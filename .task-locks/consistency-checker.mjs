/**
 * consistency-checker.mjs — Read-only consistency checker for NOVA 2.5
 *
 * Evaluates all rules defined in consistency.rules.yaml against the three
 * authoritative layers and produces a consistency report.
 *
 * CONTRACT: This module is STRICTLY READ-ONLY.
 *   - It never writes to any file.
 *   - It never emits events.
 *   - It never calls repair-manager.mjs or lease-manager.mjs writes.
 *   - Its only output is the consistency report (stdout or return value).
 *
 * Outputs: { status, generated_at, rules_triggered, recommendations, summary }
 *   status is the WORST state across all triggered rules:
 *   CORRUPT > INVALID > DEGRADED > DRIFTED > STALE > CONSISTENT
 *
 * Usage:
 *   node .task-locks/consistency-checker.mjs [options]
 *
 * Options:
 *   --json              Emit structured JSON to stdout (default: human-readable)
 *   --events <path>     Override path to TASK_EVENTS.jsonl
 *   --verbose           Include all passing rules in the report, not just violations
 *
 * Exit codes:
 *   0 — CONSISTENT (no violations)
 *   1 — one or more rules triggered (STALE, DRIFTED, DEGRADED, INVALID, or CORRUPT)
 *   2 — usage error or required file missing
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads TASK_EVENTS.jsonl, .task-locks/{registry,consistency.rules}.yaml,
 *           .task-locks/agents/{leases,registry}.json,
 *           .task-locks/agents/heartbeats/*.json,
 *           docs/communication/core/trust-report.json.
 *           NEVER writes. NEVER calls repair-manager.mjs.
 */

import fs       from 'node:fs';
import path     from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(LOCKS_DIR);
const AGENTS_DIR   = path.join(LOCKS_DIR,    'agents');
const COMM_CORE    = path.join(PROJECT_ROOT, 'docs', 'communication', 'core');

const EVENTS_PATH        = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const REGISTRY_PATH      = path.join(LOCKS_DIR,    'registry.json');
const AGENT_REG_PATH     = path.join(AGENTS_DIR,   'registry.json');
const LEASES_PATH        = path.join(AGENTS_DIR,   'leases.json');
const HEARTBEATS_DIR     = path.join(AGENTS_DIR,   'heartbeats');
const TRUST_REPORT_PATH  = path.join(COMM_CORE,    'trust-report.json');
const LEASE_MANAGER      = path.join(LOCKS_DIR,    'lease-manager.mjs');

// ---------------------------------------------------------------------------
// Parameters — mirrors consistency.rules.yaml#parameters
// (kept in sync manually; source of truth is the YAML)
// ---------------------------------------------------------------------------

const PARAMS = {
  rebuild_lag_threshold_seconds:     300,
  drift_lag_threshold_seconds:      1800,
  warning_window_seconds:           1800,
  within_ttl_window_seconds:         300,
  heartbeat_stale_threshold_seconds: 21600,
  agent_registry_small_lag_max:       10,
  axiom_density_warn_threshold:       0.05,
  snapshot_age_warn_seconds:         86400,
};

// ---------------------------------------------------------------------------
// Severity table — higher = worse
// ---------------------------------------------------------------------------

const SEVERITY = {
  CONSISTENT: 0,
  STALE:      1,
  DRIFTED:    2,
  DEGRADED:   3,
  INVALID:    4,
  CORRUPT:    5,
};

/** Return the worst of two status strings. */
function worst(a, b) {
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv     = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const VERBOSE  = argv.includes('--verbose');

const EVENTS_OVERRIDE = (() => {
  const i = argv.indexOf('--events');
  return i >= 0 ? argv[i + 1] : null;
})();

const EVENTS_FILE = EVENTS_OVERRIDE ?? EVENTS_PATH;

// ---------------------------------------------------------------------------
// Safe file readers
// ---------------------------------------------------------------------------

function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

function readHeartbeat(agentId) {
  const safe = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return readJson(path.join(HEARTBEATS_DIR, `${safe}.json`));
}

function listHeartbeatFiles() {
  if (!fs.existsSync(HEARTBEATS_DIR)) return [];
  return fs.readdirSync(HEARTBEATS_DIR)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .map(f => readJson(path.join(HEARTBEATS_DIR, f)))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Single-pass event log scan (async, read-only)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   lineCount: number,
 *   leaseExpiredEvents: Array<{task_id:string|null, notes:string|null, event_index:number, timestamp:string}>,
 *   snapshotEvents: Array<{snapshot_index:number|null, event_index:number, timestamp:string}>,
 *   agentRegisteredCount: number,
 *   chainIntact: boolean,
 *   chainViolations: string[],
 *   headTimestamp: string|null
 * }} EventScanResult
 */

/** @returns {Promise<EventScanResult>} */
async function scanEventLog() {
  /** @type {EventScanResult} */
  const result = {
    lineCount:            0,
    leaseExpiredEvents:   [],
    snapshotEvents:       [],
    agentRegisteredCount: 0,
    chainIntact:          true,
    chainViolations:      [],
    headTimestamp:        null,
  };

  if (!fs.existsSync(EVENTS_FILE)) {
    result.chainIntact = false;
    result.chainViolations.push(`TASK_EVENTS.jsonl not found at ${EVENTS_FILE}`);
    return result;
  }

  let expectedIndex = 0;
  let prevHash      = 'GENESIS';

  const iface = readline.createInterface({
    input:     fs.createReadStream(EVENTS_FILE, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of iface) {
    const line = rawLine.trim();
    if (!line) continue;

    let ev;
    try { ev = JSON.parse(line); }
    catch (e) {
      result.chainViolations.push(`Line ${result.lineCount + 1}: JSON parse error — ${e.message}`);
      result.chainIntact = false;
      result.lineCount++;
      continue;
    }

    result.lineCount++;

    // Lightweight chain checks (no hash recomputation — that's audit.mjs's job)
    if (ev.event_index !== expectedIndex) {
      result.chainViolations.push(
        `Event ${expectedIndex}: index discontinuity (expected ${expectedIndex}, got ${ev.event_index})`
      );
      result.chainIntact = false;
    }
    if (ev.prev_event_hash !== prevHash) {
      result.chainViolations.push(`Event ${expectedIndex}: prev_event_hash chain broken`);
      result.chainIntact = false;
    }
    prevHash = ev.event_hash ?? prevHash;
    expectedIndex++;

    // Collect specific event types
    switch (ev.event_type) {
      case 'LEASE_EXPIRED':
        result.leaseExpiredEvents.push({
          task_id:     ev.task_id ?? null,
          notes:       ev.notes   ?? null,
          event_index: ev.event_index,
          timestamp:   ev.timestamp,
        });
        break;
      case 'SNAPSHOT_CREATED':
        result.snapshotEvents.push({
          snapshot_index: ev.snapshot_index ?? null,
          event_index:    ev.event_index,
          timestamp:      ev.timestamp,
        });
        break;
      case 'AGENT_REGISTERED':
        result.agentRegisteredCount++;
        break;
    }

    result.headTimestamp = ev.timestamp ?? result.headTimestamp;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Review gate (read-only subprocess call)
// ---------------------------------------------------------------------------

/**
 * Call lease-manager.mjs gate --task <taskId> --json (read-only operation).
 * Returns { review_legal: boolean } or null on error.
 *
 * @param {string} taskId
 * @returns {{ review_legal: boolean } | null}
 */
function getReviewGate(taskId) {
  if (!fs.existsSync(LEASE_MANAGER)) return null;
  try {
    const result = spawnSync(
      process.execPath,
      [LEASE_MANAGER, 'gate', '--task', taskId, '--json'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    if (result.status !== 0) return null;
    const parsed = JSON.parse((result.stdout ?? '').trim());
    return parsed.gate ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Main checker
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   rule_id:        string,
 *   result:         string,
 *   details:        string,
 *   lease_id?:      string,
 *   agent_id?:      string,
 *   task_id?:       string,
 *   recommendation: object
 * }} Violation
 */

/**
 * Run all consistency rules and return the full report.
 *
 * @returns {Promise<object>} consistency report
 */
async function check() {
  const now       = new Date();
  const nowIso    = now.toISOString().replace(/\.\d+Z$/, 'Z');
  const nowMs     = now.getTime();

  /** @type {Violation[]} */
  const violations = [];

  let overallStatus = 'CONSISTENT';

  // ── Load all data sources ────────────────────────────────────────
  const taskRegistry  = readJson(REGISTRY_PATH);
  const agentRegistry = readJson(AGENT_REG_PATH);
  const leaseStore    = readJson(LEASES_PATH);
  const trustReport   = readJson(TRUST_REPORT_PATH);
  const scanResult    = await scanEventLog();
  const heartbeats    = listHeartbeatFiles();

  const tasks  = taskRegistry?.tasks  ?? [];
  const leases = leaseStore?.leases   ?? [];
  const agents = agentRegistry?.agents ?? [];

  // Helper: find task in registry
  const taskMap = new Map(tasks.map(t => [t.task_id, t]));

  // Helper: active leases only
  const activeLeases = leases.filter(l => l.status === 'ACTIVE');

  // ── CORRUPT: event log chain check ──────────────────────────────
  // Use trust-report.json if available (it runs audit.mjs including hash recomputation);
  // fall back to our lightweight scan if trust-report is missing.
  const chainBroken = trustReport
    ? trustReport.chain_valid === false
    : !scanResult.chainIntact;

  if (chainBroken) {
    const details = trustReport?.violations?.join('; ')
      ?? scanResult.chainViolations.join('; ')
      ?? 'Chain broken — run audit.mjs for details';

    violations.push({
      rule_id: 'CORRUPT',
      result:  'CORRUPT',
      details,
      recommendation: {
        action:   'halt_all_operations',
        command:  'node .task-locks/audit.mjs --verbose',
        blocking: true,
      },
    });
    overallStatus = worst(overallStatus, 'CORRUPT');
  }

  // ── R1: lease_active_task_terminal ─────────────────────────────
  for (const lease of activeLeases) {
    const task = taskMap.get(lease.task_id);
    if (!task) {
      // Task not in registry at all — check T1 (registry rebuild lag)
      const leaseAgeS = (nowMs - new Date(lease.acquired_at).getTime()) / 1000;
      if (leaseAgeS <= PARAMS.within_ttl_window_seconds) {
        // T1: tolerated — registry rebuild lag within window
        if (VERBOSE) {
          violations.push({
            rule_id:    'T1',
            result:     'CONSISTENT',
            details:    `Lease ${lease.lease_id?.slice(0,16)} for task ${lease.task_id} not yet in registry (T1 tolerated — ${leaseAgeS.toFixed(0)}s within ${PARAMS.within_ttl_window_seconds}s window)`,
            lease_id:   lease.lease_id,
            task_id:    lease.task_id,
            agent_id:   lease.agent_id,
            recommendation: { action: 'none' },
          });
        }
      } else {
        violations.push({
          rule_id:    'R1',
          result:     'INVALID',
          details:    `ACTIVE lease for task ${lease.task_id} (agent ${lease.agent_id}) — task not found in registry.json and T1 window (${PARAMS.within_ttl_window_seconds}s) exceeded (lease age ${leaseAgeS.toFixed(0)}s)`,
          lease_id:   lease.lease_id,
          task_id:    lease.task_id,
          agent_id:   lease.agent_id,
          recommendation: {
            action:     'expire_lease',
            emit_event: 'LEASE_EXPIRED',
            notes_template: 'consistency_rule=R1 task_not_in_registry',
          },
        });
        overallStatus = worst(overallStatus, 'INVALID');
      }
      continue;
    }

    if (task.status === 'MERGED' || task.status === 'EXPIRED') {
      violations.push({
        rule_id:    'R1',
        result:     'INVALID',
        details:    `ACTIVE lease for task ${lease.task_id} (agent ${lease.agent_id}, role ${lease.role}) but task status is ${task.status} in registry.json`,
        lease_id:   lease.lease_id,
        task_id:    lease.task_id,
        agent_id:   lease.agent_id,
        recommendation: {
          action:         'expire_lease',
          emit_event:     'LEASE_EXPIRED',
          notes_template: `consistency_rule=R1 task_terminal_status=${task.status}`,
        },
      });
      overallStatus = worst(overallStatus, 'INVALID');
    }
  }

  // ── R2: lease_expired_event_not_synced ──────────────────────────
  for (const ev of scanResult.leaseExpiredEvents) {
    if (!ev.notes) continue;

    // Extract expired_agent from notes field
    const m = ev.notes.match(/expired_agent=([^\s]+)/);
    if (!m) continue;
    const expiredAgent = m[1];

    // Check if this agent has an ACTIVE lease for this task in leases.json
    const stillActive = activeLeases.some(
      l => l.agent_id === expiredAgent && l.task_id === ev.task_id
    );
    if (stillActive) {
      const affectedLease = activeLeases.find(
        l => l.agent_id === expiredAgent && l.task_id === ev.task_id
      );
      violations.push({
        rule_id:    'R2',
        result:     'INVALID',
        details:    `LEASE_EXPIRED event at idx=${ev.event_index} for agent=${expiredAgent} task=${ev.task_id} was not synced to leases.json (lease still ACTIVE)`,
        lease_id:   affectedLease?.lease_id,
        task_id:    ev.task_id,
        agent_id:   expiredAgent,
        recommendation: {
          action:         'sync_lease_status_to_expired',
          emit_event:     false,
          notes_template: 'consistency_rule=R2 source=P1_event_not_synced_to_P3',
        },
      });
      overallStatus = worst(overallStatus, 'INVALID');
    }
  }

  // ── R3: duplicate_active_slot ───────────────────────────────────
  /** @type {Map<string, object[]>} */
  const slotMap = new Map();
  for (const lease of activeLeases) {
    const key = `${lease.task_id}::${lease.role_category}`;
    const bucket = slotMap.get(key) ?? [];
    bucket.push(lease);
    slotMap.set(key, bucket);
  }

  for (const [key, bucket] of slotMap) {
    if (bucket.length <= 1) continue;
    // Sort by claim_event_index ascending → first is "older" (lower = earlier in event log)
    bucket.sort((a, b) => (a.claim_event_index ?? 0) - (b.claim_event_index ?? 0));
    const older = bucket[0];
    const newer = bucket.slice(1);

    for (const dup of newer) {
      // older gets expired (lower claim_event_index = earlier in P1)
      violations.push({
        rule_id:    'R3',
        result:     'INVALID',
        details:    `Duplicate ACTIVE leases for slot ${key}: conflict between agent ${older.agent_id} (claim_idx=${older.claim_event_index}) and agent ${dup.agent_id} (claim_idx=${dup.claim_event_index}). Expire lower claim_event_index (${older.agent_id}).`,
        lease_id:   older.lease_id,
        task_id:    older.task_id,
        agent_id:   older.agent_id,
        recommendation: {
          action:             'expire_older_lease',
          conflict_resolution: 'lower_claim_event_index',
          expire_lease_id:    older.lease_id,
          emit_event:         'LEASE_EXPIRED',
          notes_template:     'consistency_rule=R3 conflict_resolution=lower_claim_event_index',
        },
      });
      overallStatus = worst(overallStatus, 'INVALID');
    }
  }

  // ── R4: invalid_review_lease ────────────────────────────────────
  const reviewLeases = activeLeases.filter(l => l.role_category === 'review_lock');
  for (const lease of reviewLeases) {
    const gate = getReviewGate(lease.task_id);
    if (gate === null) {
      // Cannot evaluate gate — skip R4 rather than false positive
      if (VERBOSE) {
        violations.push({
          rule_id:    'R4',
          result:     'CONSISTENT',
          details:    `R4 skipped for task ${lease.task_id} — lease-manager.mjs gate unavailable`,
          lease_id:   lease.lease_id,
          task_id:    lease.task_id,
          agent_id:   lease.agent_id,
          recommendation: { action: 'none' },
        });
      }
      continue;
    }
    if (!gate.review_legal) {
      violations.push({
        rule_id:    'R4',
        result:     'INVALID',
        details:    `ACTIVE review_lock lease for task ${lease.task_id} (agent ${lease.agent_id}) but review_legal=false: claim=${gate.claim_bound?.satisfied} stability=${gate.stability_bound?.satisfied} finalization=${gate.finalization_bound?.satisfied}`,
        lease_id:   lease.lease_id,
        task_id:    lease.task_id,
        agent_id:   lease.agent_id,
        recommendation: {
          action:         'expire_lease',
          emit_event:     'LEASE_EXPIRED',
          notes_template: 'consistency_rule=R4 gate_invalidated_after_acquire',
        },
      });
      overallStatus = worst(overallStatus, 'INVALID');
    }
  }

  // ── R5: agent_registry_stale ────────────────────────────────────
  const agentRegCount   = agents.length;
  const eventRegCount   = scanResult.agentRegisteredCount;
  const agentRegDiff    = eventRegCount - agentRegCount;

  // T2: tolerate small lag
  if (agentRegDiff > PARAMS.agent_registry_small_lag_max) {
    const agentRegAgeS = agentRegistry?.generated_at
      ? (nowMs - new Date(agentRegistry.generated_at).getTime()) / 1000
      : Infinity;

    const regStatus = agentRegAgeS > PARAMS.drift_lag_threshold_seconds ? 'DRIFTED' : 'STALE';
    violations.push({
      rule_id:    'R5',
      result:     regStatus,
      details:    `agents/registry.json has ${agentRegCount} agents but event log has ${eventRegCount} AGENT_REGISTERED events (diff=${agentRegDiff} > max ${PARAMS.agent_registry_small_lag_max}). Age: ${agentRegAgeS.toFixed(0)}s`,
      recommendation: {
        action:   'rebuild_agent_registry',
        command:  'node .task-locks/agent-runtime.mjs rebuild',
        blocking: false,
      },
    });
    overallStatus = worst(overallStatus, regStatus);
  } else if (VERBOSE && agentRegDiff > 0) {
    violations.push({
      rule_id:    'T2',
      result:     'CONSISTENT',
      details:    `Agent registry lag of ${agentRegDiff} agents is within T2 tolerance (max ${PARAMS.agent_registry_small_lag_max})`,
      recommendation: { action: 'none' },
    });
  }

  // ── R6: lease_store_stale ───────────────────────────────────────
  if (leaseStore?.generated_at) {
    const leaseStoreAgeS = (nowMs - new Date(leaseStore.generated_at).getTime()) / 1000;
    if (leaseStoreAgeS > PARAMS.rebuild_lag_threshold_seconds) {
      const r6Status = leaseStoreAgeS > PARAMS.drift_lag_threshold_seconds ? 'DRIFTED' : 'STALE';
      violations.push({
        rule_id:    'R6',
        result:     r6Status,
        details:    `leases.json was last written ${leaseStoreAgeS.toFixed(0)}s ago (threshold ${PARAMS.rebuild_lag_threshold_seconds}s). May have missed recent LEASE_EXPIRED / TASK_RELEASED events.`,
        recommendation: {
          action:   'run_expire_check',
          command:  'node .task-locks/lease-manager.mjs expire',
          blocking: false,
        },
      });
      overallStatus = worst(overallStatus, r6Status);
    }
  }

  // ── R7: lease_expiry_warning ────────────────────────────────────
  for (const lease of activeLeases) {
    const expiresAt = lease.expires_at ? new Date(lease.expires_at).getTime() : null;
    if (!expiresAt) continue;
    const secondsToExpiry = (expiresAt - nowMs) / 1000;
    if (secondsToExpiry > 0 && secondsToExpiry < PARAMS.warning_window_seconds) {
      violations.push({
        rule_id:    'R7',
        result:     'CONSISTENT',   // still consistent; informational only
        details:    `ACTIVE lease for task ${lease.task_id} (agent ${lease.agent_id}, role ${lease.role}) expires in ${secondsToExpiry.toFixed(0)}s (< warning_window ${PARAMS.warning_window_seconds}s)`,
        lease_id:   lease.lease_id,
        task_id:    lease.task_id,
        agent_id:   lease.agent_id,
        recommendation: {
          action:   'notify_agent',
          blocking: false,
        },
      });
      // R7 does not change overallStatus
    }
  }

  // ── R8: agent_heartbeat_ttl_expired ────────────────────────────
  for (const lease of activeLeases) {
    const hb = readHeartbeat(lease.agent_id);
    const lastSeenAt = hb?.last_seen_at
      ?? lease.last_heartbeat  // fall back to lease heartbeat field
      ?? null;

    if (!lastSeenAt) {
      violations.push({
        rule_id:    'R8',
        result:     'INVALID',
        details:    `ACTIVE lease for task ${lease.task_id} (agent ${lease.agent_id}) has no heartbeat record at all`,
        lease_id:   lease.lease_id,
        task_id:    lease.task_id,
        agent_id:   lease.agent_id,
        recommendation: {
          action:         'expire_lease',
          emit_event:     'LEASE_EXPIRED',
          notes_template: 'consistency_rule=R8 agent_absent_no_heartbeat_record',
        },
      });
      overallStatus = worst(overallStatus, 'INVALID');
      continue;
    }

    const heartbeatAgeS = (nowMs - new Date(lastSeenAt).getTime()) / 1000;
    if (heartbeatAgeS > PARAMS.heartbeat_stale_threshold_seconds) {
      violations.push({
        rule_id:    'R8',
        result:     'INVALID',
        details:    `ACTIVE lease for task ${lease.task_id} (agent ${lease.agent_id}) — heartbeat age ${heartbeatAgeS.toFixed(0)}s exceeds threshold ${PARAMS.heartbeat_stale_threshold_seconds}s. Agent is absent.`,
        lease_id:   lease.lease_id,
        task_id:    lease.task_id,
        agent_id:   lease.agent_id,
        recommendation: {
          action:         'expire_lease',
          emit_event:     'LEASE_EXPIRED',
          notes_template: `consistency_rule=R8 agent_absent_since=${lastSeenAt}`,
        },
      });
      overallStatus = worst(overallStatus, 'INVALID');
    }
  }

  // ── D1: axiom_density_high ──────────────────────────────────────
  const axiomDensity = trustReport?.axiom_density ?? null;
  if (axiomDensity !== null && axiomDensity > PARAMS.axiom_density_warn_threshold) {
    violations.push({
      rule_id:    'D1',
      result:     'DEGRADED',
      details:    `axiom_density=${(axiomDensity * 100).toFixed(4)}% exceeds threshold ${(PARAMS.axiom_density_warn_threshold * 100).toFixed(0)}%. High ARCHITECT_OVERRIDE ratio reduces deterministic proof value.`,
      recommendation: {
        action:   'notify_architect',
        blocking: false,
      },
    });
    overallStatus = worst(overallStatus, 'DEGRADED');
  }

  // ── D2: snapshot_age_high ───────────────────────────────────────
  if (scanResult.snapshotEvents.length > 0) {
    const latestSnap = scanResult.snapshotEvents[scanResult.snapshotEvents.length - 1];
    const snapAgeS   = (nowMs - new Date(latestSnap.timestamp).getTime()) / 1000;
    if (snapAgeS > PARAMS.snapshot_age_warn_seconds) {
      violations.push({
        rule_id:    'D2',
        result:     'DEGRADED',
        details:    `Latest snapshot (event_idx=${latestSnap.event_index}) is ${(snapAgeS / 3600).toFixed(1)}h old (threshold ${PARAMS.snapshot_age_warn_seconds / 3600}h). Rollback window is large.`,
        recommendation: {
          action:   'suggest_snapshot',
          command:  'node .task-locks/snapshot-writer.mjs',
          blocking: false,
        },
      });
      overallStatus = worst(overallStatus, 'DEGRADED');
    }
  } else if (scanResult.lineCount > 0) {
    // Event log has events but no snapshots at all
    violations.push({
      rule_id:    'D2',
      result:     'DEGRADED',
      details:    `No SNAPSHOT_CREATED events found in event log (${scanResult.lineCount} events total). No rollback point exists.`,
      recommendation: {
        action:   'suggest_snapshot',
        command:  'node .task-locks/snapshot-writer.mjs',
        blocking: false,
      },
    });
    overallStatus = worst(overallStatus, 'DEGRADED');
  }

  // ── D3: trust_report_degraded ───────────────────────────────────
  if (trustReport?.status === 'degraded') {
    violations.push({
      rule_id:    'D3',
      result:     'DEGRADED',
      details:    `trust-report.json status=degraded. Reason: ${trustReport.reason ?? 'unspecified'}. Violations: ${(trustReport.violations ?? []).join('; ') || 'none listed'}`,
      recommendation: {
        action:   'inspect_trust_report',
        command:  'node .task-locks/trust-report.mjs --json',
        blocking: false,
      },
    });
    overallStatus = worst(overallStatus, 'DEGRADED');
  }

  // ── Build report ─────────────────────────────────────────────────
  const rulesFired   = VERBOSE
    ? violations
    : violations.filter(v => v.result !== 'CONSISTENT');

  const recommendations = rulesFired
    .filter(v => v.recommendation?.action && v.recommendation.action !== 'none')
    .map(v => ({
      rule_id:        v.rule_id,
      result:         v.result,
      action:         v.recommendation.action,
      command:        v.recommendation.command      ?? null,
      emit_event:     v.recommendation.emit_event   ?? null,
      blocking:       v.recommendation.blocking     ?? false,
      lease_id:       v.lease_id   ?? null,
      task_id:        v.task_id    ?? null,
      agent_id:       v.agent_id   ?? null,
    }));

  return {
    ok:              overallStatus === 'CONSISTENT',
    status:          overallStatus,
    generated_at:    nowIso,
    rules_triggered: rulesFired,
    recommendations,
    summary: {
      event_count:        scanResult.lineCount,
      active_leases:      activeLeases.length,
      total_leases:       leases.length,
      agents_registered:  agents.length,
      chain_intact:       !chainBroken,
      corrupt:            violations.filter(v => v.result === 'CORRUPT').length,
      invalid:            violations.filter(v => v.result === 'INVALID').length,
      degraded:           violations.filter(v => v.result === 'DEGRADED').length,
      drifted:            violations.filter(v => v.result === 'DRIFTED').length,
      stale:              violations.filter(v => v.result === 'STALE').length,
      warnings:           violations.filter(v => v.rule_id === 'R7').length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI output
// ---------------------------------------------------------------------------

function humanReport(report) {
  const WIDTH = 60;
  const LINE  = '─'.repeat(WIDTH);
  const STATUS_ICONS = {
    CONSISTENT: '✓', STALE: '⚠', DRIFTED: '⚠', DEGRADED: '⚠', INVALID: '✗', CORRUPT: '✗',
  };
  const icon = STATUS_ICONS[report.status] ?? '?';

  console.log('');
  console.log('NOVA 2.5 Consistency Check');
  console.log(LINE);
  console.log(`Status        : ${icon}  ${report.status}`);
  console.log(`Generated at  : ${report.generated_at}`);
  console.log(`Events        : ${report.summary.event_count}`);
  console.log(`Active leases : ${report.summary.active_leases}`);
  console.log(`Agents        : ${report.summary.agents_registered}`);
  console.log(`Chain intact  : ${report.summary.chain_intact ? 'yes' : 'NO'}`);
  console.log(LINE);

  if (report.rules_triggered.length === 0) {
    console.log('');
    console.log('  All consistency rules pass.');
    console.log('');
    console.log('OK: system is CONSISTENT.');
    console.log('');
    return;
  }

  // Group by result
  for (const category of ['CORRUPT', 'INVALID', 'DEGRADED', 'DRIFTED', 'STALE', 'CONSISTENT']) {
    const group = report.rules_triggered.filter(v => v.result === category);
    if (group.length === 0) continue;
    console.log('');
    console.log(`  ${category} (${group.length}):`);
    for (const v of group) {
      const icon2 = category === 'CONSISTENT' ? '  ✓' : '  ✗';
      console.log(`${icon2}  [${v.rule_id}] ${v.details}`);
      if (v.recommendation?.action && v.recommendation.action !== 'none' && v.recommendation.action !== 'notify_agent') {
        const cmd = v.recommendation.command
          ?? `repair-manager.mjs ${v.recommendation.action}`;
        console.log(`       → ${cmd}`);
      }
    }
  }

  console.log('');
  if (report.status !== 'CONSISTENT') {
    console.log(`FAIL: ${report.summary.invalid + report.summary.corrupt} invalid, ${report.summary.degraded} degraded, ${report.summary.stale + report.summary.drifted} stale.`);
    if (report.summary.invalid > 0 || report.summary.corrupt > 0) {
      console.log('Run: node .task-locks/repair-manager.mjs --from <(node .task-locks/consistency-checker.mjs --json)');
    }
  } else {
    console.log('OK: system is CONSISTENT (with informational notices above).');
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

check().then(report => {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    humanReport(report);
  }
  process.exit(report.ok ? 0 : 1);
}).catch(err => {
  const errOut = { ok: false, status: 'CORRUPT', error: err.message };
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(errOut) + '\n');
  } else {
    console.error('[consistency-checker] Fatal:', err);
  }
  process.exit(2);
});
