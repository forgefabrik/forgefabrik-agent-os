/**
 * agent-runtime.mjs — Agent registry + runtime state for NOVA 2.5
 *
 * Rebuilds .task-locks/agents/registry.json from AGENT_REGISTERED events in
 * TASK_EVENTS.jsonl.  Also computes per-agent reputation files, per-agent
 * heartbeat files, and the ephemeral task_runtime_state document.
 *
 * Operations:
 *   rebuild     — rebuild agents/registry.json from AGENT_REGISTERED events
 *   reputation  — compute agents/reputation/<agent_id>.json for every agent
 *   heartbeats  — write agents/heartbeats/<agent_id>.json for every agent
 *   state       — print task_runtime_state for a single task (ephemeral)
 *   full        — rebuild + reputation + heartbeats in one pass
 *
 * Usage:
 *   node .task-locks/agent-runtime.mjs rebuild    [--json]
 *   node .task-locks/agent-runtime.mjs reputation [--json]
 *   node .task-locks/agent-runtime.mjs heartbeats [--json]
 *   node .task-locks/agent-runtime.mjs state --task <TASK-NNNN> [--json]
 *   node .task-locks/agent-runtime.mjs full   [--json]
 *
 * Exit codes:
 *   0 — success
 *   1 — partial failure (some agents could not be processed)
 *   2 — usage error or required file missing
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads TASK_EVENTS.jsonl, registry.json, leases.json, snapshots/*.
 *           writes ONLY agents/registry.json, agents/heartbeats/*.json,
 *           agents/reputation/*.json.
 *           calls lease-manager.mjs gate via subprocess for review gate data.
 *           NEVER writes to TASK_EVENTS.jsonl or .task-locks/registry.json.
 */

import fs   from 'node:fs';
import path from 'node:path';
import rl   from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(LOCKS_DIR);
const AGENTS_DIR   = path.join(LOCKS_DIR, 'agents');

const EVENTS_PATH      = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const REGISTRY_PATH    = path.join(LOCKS_DIR, 'registry.json');        // task registry
const AGENT_REG_PATH   = path.join(AGENTS_DIR, 'registry.json');       // agent registry
const LEASES_PATH      = path.join(AGENTS_DIR, 'leases.json');
const HEARTBEATS_DIR   = path.join(AGENTS_DIR, 'heartbeats');
const REPUTATION_DIR   = path.join(AGENTS_DIR, 'reputation');
const LEASE_MANAGER    = path.join(LOCKS_DIR,  'lease-manager.mjs');

// ---------------------------------------------------------------------------
// TTL constants (seconds, from transitions.yaml values)
// ---------------------------------------------------------------------------

const HEARTBEAT_STALE_S = 21600;  // 6 h — same as IMPLEMENTATION TTL

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv    = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');

function arg(flag, fallback = null) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

// ---------------------------------------------------------------------------
// Capability parser
// ---------------------------------------------------------------------------

/**
 * Extract capabilities list from an AGENT_REGISTERED notes string.
 * Expected format: "capabilities=[IMPLEMENTATION,REFACTOR] ..." or
 *                  "capabilities=IMPLEMENTATION,REFACTOR"
 * Falls back to [] on parse failure.
 *
 * @param {string|null} notes
 * @returns {string[]}
 */
function parseCapabilities(notes) {
  if (!notes) return [];
  // Match: capabilities=[A,B,C] or capabilities=A,B,C (no brackets)
  const m = notes.match(/capabilities=\[?([A-Z,_]+)\]?/);
  if (!m) return [];
  return m[1].split(',').map(s => s.trim()).filter(Boolean);
}

/**
 * Extract model from notes string: "model=claude-opus-4" or "model=gpt-4"
 * @param {string|null} notes
 * @returns {string|null}
 */
function parseModel(notes) {
  if (!notes) return null;
  const m = notes.match(/model=([^\s]+)/);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// Event log scanner
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   registrations:   Array<{agent:string, event_index:number, timestamp:string, notes:string|null, model:string|null}>,
 *   agentActivity:   Map<string, {last_seen_at:string, last_event_type:string, last_event_index:number}>,
 *   agentTasks:      Map<string, {completed:number, expired:number, released:number}>,
 *   eventCount:      number
 * }} ScanResult
 */

/**
 * Single-pass scan of TASK_EVENTS.jsonl collecting all Agent Runtime data.
 * @returns {Promise<ScanResult>}
 */
async function scanEvents() {
  /** @type {ScanResult} */
  const result = {
    registrations: [],
    agentActivity: new Map(),
    agentTasks:    new Map(),
    eventCount:    0,
  };

  if (!fs.existsSync(EVENTS_PATH)) {
    return result;
  }

  const AGENT_EVENTS = new Set([
    'AGENT_REGISTERED', 'TASK_CLAIMED', 'TASK_HEARTBEAT',
    'TASK_REVIEW_REQUESTED', 'TASK_REFACTOR_REQUESTED', 'TASK_REFACTOR_COMPLETE',
    'TASK_APPROVED', 'TASK_REJECTED', 'TASK_MERGED',
    'TASK_LOCK_EXPIRED', 'LEASE_RENEWED', 'TASK_RELEASED', 'LEASE_EXPIRED',
  ]);

  const iface = rl.createInterface({
    input:     fs.createReadStream(EVENTS_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of iface) {
    const line = rawLine.trim();
    if (!line) continue;

    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    result.eventCount++;

    const type      = ev.event_type;
    const agentId   = ev.agent ?? null;
    const taskId    = ev.task_id ?? null;

    // ── Activity tracking (for any event with an agent field) ────────
    if (agentId && AGENT_EVENTS.has(type)) {
      const prev = result.agentActivity.get(agentId);
      if (!prev || ev.event_index > prev.last_event_index) {
        result.agentActivity.set(agentId, {
          last_seen_at:    ev.timestamp,
          last_event_type: type,
          last_event_index: ev.event_index,
        });
      }
    }

    // ── Registration ──────────────────────────────────────────────
    if (type === 'AGENT_REGISTERED' && agentId) {
      result.registrations.push({
        agent:       agentId,
        event_index: ev.event_index,
        timestamp:   ev.timestamp,
        notes:       ev.notes ?? null,
        model:       ev.model ?? parseModel(ev.notes),
      });
    }

    // ── Reputation: completed ──────────────────────────────────────
    // Credit TASK_MERGED to the agent who held the implementation_lock
    // (i.e. the agent that claimed the task — sourced from lock, not event agent)
    if (type === 'TASK_MERGED' && agentId) {
      const bucket = result.agentTasks.get(agentId) ?? { completed: 0, expired: 0, released: 0 };
      bucket.completed++;
      result.agentTasks.set(agentId, bucket);
    }

    // ── Reputation: expired ───────────────────────────────────────
    // TASK_LOCK_EXPIRED or LEASE_EXPIRED: debit the agent who held the lock.
    // The agent field is null on these (role=system), so we use the notes
    // field written by lease-manager: "expired_agent=<id> ..."
    if ((type === 'TASK_LOCK_EXPIRED' || type === 'LEASE_EXPIRED') && ev.notes) {
      const m = ev.notes.match(/expired_agent=([^\s]+)/);
      const expiredAgent = m ? m[1] : null;
      if (expiredAgent) {
        const bucket = result.agentTasks.get(expiredAgent) ?? { completed: 0, expired: 0, released: 0 };
        bucket.expired++;
        result.agentTasks.set(expiredAgent, bucket);
      }
    }

    // ── Reputation: released ──────────────────────────────────────
    if (type === 'TASK_RELEASED' && agentId) {
      const bucket = result.agentTasks.get(agentId) ?? { completed: 0, expired: 0, released: 0 };
      bucket.released++;
      result.agentTasks.set(agentId, bucket);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// rebuild — agents/registry.json
// ---------------------------------------------------------------------------

/**
 * Rebuild agents/registry.json from AGENT_REGISTERED events.
 * @returns {Promise<{ ok: boolean, agents: number, event_count: number, error?: string }>}
 */
export async function rebuildRegistry() {
  const scan = await scanEvents();

  // Deduplicate registrations: most recent AGENT_REGISTERED per agent wins.
  // Earlier registrations that are re-registered move to ACTIVE.
  /** @type {Map<string, object>} */
  const byAgent = new Map();

  for (const reg of scan.registrations) {
    const existing = byAgent.get(reg.agent);
    // Keep the record with the highest event_index (most recent registration)
    if (!existing || reg.event_index > existing.registered_at_event_index) {
      byAgent.set(reg.agent, {
        agent_id:                reg.agent,
        capabilities:            parseCapabilities(reg.notes),
        model:                   reg.model,
        registered_at:           reg.timestamp,
        registered_at_event_index: reg.event_index,
        status:                  'ACTIVE',
        notes:                   reg.notes,
        last_seen_at:            reg.timestamp,  // will be overwritten below
      });
    }
  }

  // Update last_seen_at from activity scan
  for (const [agentId, activity] of scan.agentActivity) {
    const record = byAgent.get(agentId);
    if (record) {
      // Only update if activity is more recent than current last_seen_at
      if (!record.last_seen_at || activity.last_seen_at > record.last_seen_at) {
        record.last_seen_at = activity.last_seen_at;
      }
    }
  }

  const agents    = [...byAgent.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id));
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const store = {
    schema_version: '1.0.0',
    generated_at:   generatedAt,
    event_count:    scan.eventCount,
    agents,
  };

  fs.mkdirSync(AGENTS_DIR, { recursive: true });
  const tmp = AGENT_REG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, AGENT_REG_PATH);

  return { ok: true, agents: agents.length, event_count: scan.eventCount };
}

// ---------------------------------------------------------------------------
// reputation — agents/reputation/<agent_id>.json
// ---------------------------------------------------------------------------

/**
 * Rebuild per-agent reputation files from event log.
 * @returns {Promise<{ ok: boolean, agents: number }>}
 */
export async function rebuildReputation() {
  const scan = await scanEvents();
  const generatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  fs.mkdirSync(REPUTATION_DIR, { recursive: true });

  // Build a unified set of all known agent IDs
  const allAgents = new Set([
    ...scan.registrations.map(r => r.agent),
    ...scan.agentTasks.keys(),
  ]);

  let count = 0;
  for (const agentId of allAgents) {
    const stats    = scan.agentTasks.get(agentId) ?? { completed: 0, expired: 0, released: 0 };
    const total    = stats.completed + stats.expired;
    const score    = total > 0 ? stats.completed / total : 1.0;  // no history → neutral

    const record = {
      agent_id:        agentId,
      tasks_completed: stats.completed,
      tasks_expired:   stats.expired,
      tasks_released:  stats.released,
      score:           Math.round(score * 1e6) / 1e6,
      last_updated:    generatedAt,
    };

    // Safe filename: replace non-alphanum chars that aren't hyphen/underscore/dot
    const safeName = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(REPUTATION_DIR, `${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    count++;
  }

  return { ok: true, agents: count };
}

// ---------------------------------------------------------------------------
// heartbeats — agents/heartbeats/<agent_id>.json
// ---------------------------------------------------------------------------

/**
 * Write per-agent heartbeat status files based on last observed activity.
 * @returns {Promise<{ ok: boolean, agents: number }>}
 */
export async function rebuildHeartbeats() {
  const scan = await scanEvents();
  const now  = new Date();
  const generatedAt = now.toISOString().replace(/\.\d+Z$/, 'Z');

  fs.mkdirSync(HEARTBEATS_DIR, { recursive: true });

  // Build a unified set of all known agent IDs
  const allAgents = new Set([
    ...scan.registrations.map(r => r.agent),
    ...scan.agentActivity.keys(),
  ]);

  let count = 0;
  for (const agentId of allAgents) {
    const activity = scan.agentActivity.get(agentId);
    const lastSeen = activity?.last_seen_at ?? null;

    let status = 'UNKNOWN';
    if (lastSeen) {
      const ageMs = now.getTime() - new Date(lastSeen).getTime();
      status = ageMs / 1000 < HEARTBEAT_STALE_S ? 'ACTIVE' : 'STALE';
    }

    const record = {
      agent_id:          agentId,
      last_seen_at:      lastSeen,
      last_event_type:   activity?.last_event_type  ?? null,
      last_event_index:  activity?.last_event_index ?? null,
      status,
      evaluated_at:      generatedAt,
    };

    const safeName = agentId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = path.join(HEARTBEATS_DIR, `${safeName}.json`);
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + '\n', 'utf8');
    count++;
  }

  return { ok: true, agents: count };
}

// ---------------------------------------------------------------------------
// computeTaskRuntimeState — ephemeral, never written to disk
// ---------------------------------------------------------------------------

/**
 * Read active leases for a task from leases.json.
 * Returns { implLease, reviewLease } — null if none found.
 *
 * @param {string} taskId
 * @returns {{ implLease: object|null, reviewLease: object|null }}
 */
function readActiveLeases(taskId) {
  if (!fs.existsSync(LEASES_PATH)) {
    return { implLease: null, reviewLease: null };
  }
  const store = JSON.parse(fs.readFileSync(LEASES_PATH, 'utf8'));
  const active = store.leases.filter(l => l.task_id === taskId && l.status === 'ACTIVE');
  const implLease   = active.find(l => l.role_category === 'implementation_lock') ?? null;
  const reviewLease = active.find(l => l.role_category === 'review_lock')         ?? null;
  return { implLease, reviewLease };
}

/**
 * Project a lease record to the active_lease_ref shape (task_runtime_state schema).
 * @param {object|null} lease
 * @returns {object|null}
 */
function leaseRef(lease) {
  if (!lease) return null;
  return {
    lease_id:             lease.lease_id,
    agent_id:             lease.agent_id,
    role:                 lease.role,
    role_category:        lease.role_category,
    acquired_at:          lease.acquired_at,
    expires_at:           lease.expires_at,
    last_heartbeat:       lease.last_heartbeat,
    renewal_count:        lease.renewal_count ?? 0,
    bound_snapshot_index: lease.bound_snapshot_index ?? null,
  };
}

/**
 * Compute implementation_stability for a lease (or null lease).
 * @param {object|null} implLease
 * @param {string}      evaluatedAt   ISO timestamp
 * @returns {object}  implementation_stability block per task_runtime_state.schema.json
 */
function computeImplStability(implLease, evaluatedAt) {
  if (!implLease) {
    return {
      stable:                  false,
      agent_id:                null,
      heartbeat_age_seconds:   null,
      ttl_seconds:             21600,
      expires_at:              null,
      reason:                  'No active implementation lease.',
    };
  }

  const ttlS           = implLease.role === 'REFACTOR' ? 7200 : 21600;
  const nowMs          = new Date(evaluatedAt).getTime();
  const lastHbMs       = new Date(implLease.last_heartbeat).getTime();
  const heartbeatAgeS  = (nowMs - lastHbMs) / 1000;
  const stable         = heartbeatAgeS >= 0 && heartbeatAgeS < ttlS;

  return {
    stable,
    agent_id:              implLease.agent_id,
    heartbeat_age_seconds: Math.round(heartbeatAgeS * 10) / 10,
    ttl_seconds:           ttlS,
    expires_at:            implLease.expires_at,
    reason: stable
      ? `Heartbeat ${heartbeatAgeS.toFixed(1)} s ago (TTL ${ttlS} s).`
      : `Heartbeat ${heartbeatAgeS.toFixed(1)} s ago exceeds TTL ${ttlS} s — lock stale.`,
  };
}

/**
 * Fetch the review gate by calling lease-manager.mjs gate via subprocess.
 * @param {string} taskId
 * @returns {object}  gate block per task_runtime_state.schema.json
 */
function fetchReviewGate(taskId) {
  // Fallback (no gate data) returned when lease-manager is unavailable
  const unavailableGate = {
    claim_bound: {
      satisfied: false, bound_snapshot_index: null,
      claim_event_index: 0, snapshot_event_count: null,
      reason: 'Could not compute gate (lease-manager unavailable)',
    },
    stability_bound: {
      satisfied: false, snapshot_impl_heartbeat_age_seconds: null,
      impl_ttl_seconds: 21600,
      reason: 'Could not compute gate (lease-manager unavailable)',
    },
    finalization_bound: {
      satisfied: false, trigger_event_type: null, trigger_event_index: null,
      reason: 'Could not compute gate (lease-manager unavailable)',
    },
    review_legal: false,
  };

  if (!fs.existsSync(LEASE_MANAGER)) return unavailableGate;

  try {
    const result = spawnSync(
      process.execPath,
      [LEASE_MANAGER, 'gate', '--task', taskId, '--json'],
      { encoding: 'utf8', timeout: 20_000 }
    );
    if (result.error || result.status !== 0) return unavailableGate;
    const parsed = JSON.parse((result.stdout ?? '').trim());
    return parsed.gate ?? unavailableGate;
  } catch {
    return unavailableGate;
  }
}

/**
 * Compute the ephemeral task_runtime_state document.
 *
 * @param {string} taskId
 * @returns {Promise<object>}  conforms to task_runtime_state.schema.json
 */
export async function computeTaskRuntimeState(taskId) {
  const evaluatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  // ── Task state from task registry ─────────────────────────────
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`registry.json not found at ${REGISTRY_PATH}`);
  }
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const task     = registry.tasks.find(t => t.task_id === taskId);
  if (!task) {
    throw new Error(`Task "${taskId}" not found in registry.json`);
  }

  // ── Active leases ──────────────────────────────────────────────
  const { implLease, reviewLease } = readActiveLeases(taskId);

  // ── Review gate ────────────────────────────────────────────────
  const reviewGate = fetchReviewGate(taskId);

  // ── Implementation stability ───────────────────────────────────
  const implStability = computeImplStability(implLease, evaluatedAt);

  return {
    task_id:                  taskId,
    state:                    task.status,
    implementation_lease:     leaseRef(implLease),
    review_lease:             leaseRef(reviewLease),
    review_gate:              reviewGate,
    implementation_stability: implStability,
    evaluated_at:             evaluatedAt,
  };
}

// ---------------------------------------------------------------------------
// CLI interface
// ---------------------------------------------------------------------------

function out(data) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    if (data.ok === false || (data.error && !data.ok)) {
      console.error('FAIL:', data.error ?? JSON.stringify(data));
    } else {
      console.log('OK:', JSON.stringify(data));
    }
  }
}

const command = argv[0];

if (!command || command.startsWith('--')) {
  console.error('Usage: node agent-runtime.mjs <rebuild|reputation|heartbeats|state|full> [options]');
  process.exit(2);
}

(async () => {
  switch (command) {

    case 'rebuild': {
      const result = await rebuildRegistry();
      out(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'reputation': {
      const result = await rebuildReputation();
      out(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'heartbeats': {
      const result = await rebuildHeartbeats();
      out(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'state': {
      const taskId = arg('--task');
      if (!taskId) {
        console.error('state requires: --task <TASK-NNNN>');
        process.exit(2);
      }
      try {
        const runtimeState = await computeTaskRuntimeState(taskId);
        out({ ok: true, ...runtimeState });
      } catch (e) {
        out({ ok: false, error: e.message, code: 'ERR_STATE_COMPUTE' });
        process.exit(1);
      }
      break;
    }

    case 'full': {
      const [regResult, repResult, hbResult] = await Promise.all([
        rebuildRegistry(),
        rebuildReputation(),
        rebuildHeartbeats(),
      ]);
      const ok = regResult.ok && repResult.ok && hbResult.ok;
      out({ ok, registry: regResult, reputation: repResult, heartbeats: hbResult });
      process.exit(ok ? 0 : 1);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Use: rebuild|reputation|heartbeats|state|full`);
      process.exit(2);
  }
})().catch(err => {
  console.error('[agent-runtime] Fatal:', err);
  process.exit(2);
});
