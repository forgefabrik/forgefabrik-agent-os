/**
 * repair-manager.mjs — Write actor for consistency corrections in NOVA 2.5
 *
 * Reads the consistency report produced by consistency-checker.mjs and applies
 * the prescribed corrections.  This is the ONLY module permitted to act on
 * consistency violations.
 *
 * BOUNDARY CONTRACT (from consistency.rules.yaml#repair_manager_contract):
 *   - reads:  consistency_report (from stdin, --report file, or --auto inline run)
 *   - writes: .task-locks/agents/leases.json (directly, atomic tmp+rename)
 *   - emits:  events via event-writer.mjs subprocess (never writes TASK_EVENTS.jsonl directly)
 *   - does_not_classify: true — rule evaluation is the checker's job, not ours
 *
 * Actions handled:
 *   expire_lease             — emit LEASE_EXPIRED + mark lease EXPIRED in leases.json
 *   expire_older_lease       — same as expire_lease, selects by recommendation.expire_lease_id
 *   sync_lease_status_to_expired — update leases.json only (event already in P1, no new event)
 *   rebuild_agent_registry   — call agent-runtime.mjs rebuild
 *   run_expire_check         — call lease-manager.mjs expire
 *   halt_all_operations      — print CORRUPT alert and exit 2 (no repair possible)
 *   suggest_snapshot         — print informational suggestion (never auto-creates snapshots)
 *   notify_architect         — print DEGRADED warning
 *   notify_agent             — print informational warning
 *   inspect_trust_report     — print trust status info
 *
 * Usage:
 *   node .task-locks/consistency-checker.mjs --json | node .task-locks/repair-manager.mjs --stdin
 *   node .task-locks/repair-manager.mjs --report /tmp/report.json
 *   node .task-locks/repair-manager.mjs --auto          # run checker inline, then repair
 *
 * Options:
 *   --stdin              Read consistency report from stdin
 *   --report  <path>     Read consistency report from file
 *   --auto               Run consistency-checker.mjs inline, then repair
 *   --dry-run            Show what would be done; write nothing
 *   --json               Emit structured JSON output
 *   --blocking-only      Only apply INVALID/CORRUPT corrections; skip STALE/DRIFTED
 *   --rule <id>          Only apply corrections for this rule (e.g. --rule R1)
 *   --timestamp <ISO>    Override the timestamp injected into emitted events
 *
 * Exit codes:
 *   0 — all corrections applied (or nothing to repair)
 *   1 — one or more corrections failed
 *   2 — CORRUPT state detected or fatal error (manual intervention required)
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 */

import fs   from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(LOCKS_DIR);
const AGENTS_DIR   = path.join(LOCKS_DIR, 'agents');

const LEASES_PATH       = path.join(AGENTS_DIR, 'leases.json');
const WRITER_PATH       = path.join(LOCKS_DIR,  'event-writer.mjs');
const CHECKER_PATH      = path.join(LOCKS_DIR,  'consistency-checker.mjs');
const AGENT_RUNTIME     = path.join(LOCKS_DIR,  'agent-runtime.mjs');
const LEASE_MANAGER     = path.join(LOCKS_DIR,  'lease-manager.mjs');
const TRANSITIONS_YAML  = path.join(LOCKS_DIR,  'transitions.yaml');
const WRITE_LOCK_FILE   = path.join(LOCKS_DIR,  'WRITE.lock');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const JSON_OUT = argv.includes('--json');
const BLOCKING_ONLY = argv.includes('--blocking-only');
const AUTO_RUN = argv.includes('--auto');
const FROM_STDIN = argv.includes('--stdin');

const RULE_FILTER = (() => {
  const i = argv.indexOf('--rule');
  return i >= 0 ? argv[i + 1] : null;
})();

const REPORT_FILE = (() => {
  const i = argv.indexOf('--report');
  return i >= 0 ? argv[i + 1] : null;
})();

const TIMESTAMP_OVERRIDE = (() => {
  const i = argv.indexOf('--timestamp');
  return i >= 0 ? argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// Engine version reader
// ---------------------------------------------------------------------------

function readEngineVersion() {
  try {
    const raw = fs.readFileSync(TRANSITIONS_YAML, 'utf8');
    const m   = raw.match(/^engine_version:\s*(\d+)/m);
    return m ? parseInt(m[1], 10) : 1;
  } catch { return 1; }
}

// ---------------------------------------------------------------------------
// Advisory write lock (shared with event-writer.mjs)
// ---------------------------------------------------------------------------

const LOCK_TTL_MS   = 15_000;
const LOCK_RETRIES  = 20;
const LOCK_DELAY_MS = 300;

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — acceptable for short lock waits */ }
}

function acquireWriteLock() {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      const fd = fs.openSync(WRITE_LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const lockData = JSON.parse(fs.readFileSync(WRITE_LOCK_FILE, 'utf8'));
        if (Date.now() - lockData.at > LOCK_TTL_MS) {
          fs.unlinkSync(WRITE_LOCK_FILE);
          continue;
        }
      } catch { /* lock disappeared — retry */ }
      sleepSync(LOCK_DELAY_MS + Math.floor(Math.random() * 100));
    }
  }
  throw Object.assign(
    new Error(`Could not acquire write lock after ${LOCK_RETRIES} attempts`),
    { code: 'ERR_LOCK_TIMEOUT' }
  );
}

function releaseWriteLock() {
  try { fs.unlinkSync(WRITE_LOCK_FILE); } catch { /* already released */ }
}

// ---------------------------------------------------------------------------
// leases.json helpers
// ---------------------------------------------------------------------------

function readLeases() {
  if (!fs.existsSync(LEASES_PATH)) {
    return { schema_version: '1.0.0', generated_at: new Date().toISOString(), leases: [] };
  }
  return JSON.parse(fs.readFileSync(LEASES_PATH, 'utf8'));
}

function writeLeases(store, timestamp) {
  store.generated_at = timestamp;
  const tmp = LEASES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, LEASES_PATH);
}

// ---------------------------------------------------------------------------
// Event writer subprocess (--no-lock: caller already holds WRITE.lock)
// ---------------------------------------------------------------------------

/**
 * Emit one event via event-writer.mjs.
 * Called with the WRITE.lock already held by the caller.
 *
 * @param {object} payload
 * @returns {{ ok: boolean, event?: object, error?: string, code?: string }}
 */
function emitEvent(payload) {
  const input = JSON.stringify(payload);
  const result = spawnSync(
    process.execPath,
    [WRITER_PATH, '--json', '--no-lock'],
    { input, encoding: 'utf8', timeout: 20_000 }
  );
  if (result.error) {
    return { ok: false, error: `spawn failed: ${result.error.message}`, code: 'ERR_SPAWN' };
  }
  const stdout = (result.stdout ?? '').trim();
  try { return JSON.parse(stdout); }
  catch {
    return {
      ok:    false,
      error: `event-writer non-JSON output: ${stdout.slice(0, 200)}`,
      code:  'ERR_WRITER_OUTPUT',
    };
  }
}

// ---------------------------------------------------------------------------
// Consistency-checker runner (for --auto mode)
// ---------------------------------------------------------------------------

/**
 * Run consistency-checker.mjs and return the parsed report.
 * @returns {{ ok: boolean, report?: object, error?: string }}
 */
function runChecker() {
  if (!fs.existsSync(CHECKER_PATH)) {
    return { ok: false, error: `consistency-checker.mjs not found at ${CHECKER_PATH}` };
  }
  const result = spawnSync(
    process.execPath,
    [CHECKER_PATH, '--json'],
    { encoding: 'utf8', timeout: 60_000 }
  );
  if (result.error) {
    return { ok: false, error: `spawn failed: ${result.error.message}` };
  }
  const stdout = (result.stdout ?? '').trim();
  try {
    return { ok: true, report: JSON.parse(stdout) };
  } catch {
    return { ok: false, error: `checker returned non-JSON: ${stdout.slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Subprocess helpers (non-locking)
// ---------------------------------------------------------------------------

/**
 * Run a Node.js script as a subprocess.
 * @returns {{ ok: boolean, output?: object, error?: string }}
 */
function runScript(scriptPath, args) {
  if (!fs.existsSync(scriptPath)) {
    return { ok: false, error: `script not found: ${scriptPath}` };
  }
  const result = spawnSync(
    process.execPath,
    [scriptPath, '--json', ...args],
    { encoding: 'utf8', timeout: 30_000 }
  );
  if (result.error) {
    return { ok: false, error: `spawn: ${result.error.message}` };
  }
  const stdout = (result.stdout ?? '').trim();
  try {
    return { ok: result.status === 0, output: JSON.parse(stdout) };
  } catch {
    return { ok: result.status === 0, output: null };
  }
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

/**
 * Force-expire a lease: emit LEASE_EXPIRED then mark it EXPIRED in leases.json.
 * Requires recommendation to have { agent_id, task_id, lease_id? }.
 *
 * @param {object} rec      recommendation from consistency report
 * @param {string} timestamp
 * @param {number} engineVersion
 * @param {string} notes_prefix  e.g. "consistency_rule=R1"
 * @returns {{ ok: boolean, action: string, details: string, error?: string }}
 */
function applyExpireLease(rec, timestamp, engineVersion, notes_prefix) {
  const { agent_id, task_id, lease_id } = rec;

  if (!task_id) {
    return { ok: false, action: 'expire_lease', details: 'missing task_id', error: 'ERR_NO_TASK_ID' };
  }

  // Find the lease in leases.json to get its role
  const store     = readLeases();
  const leaseObj  = lease_id
    ? store.leases.find(l => l.lease_id === lease_id)
    : store.leases.find(l => l.agent_id === agent_id && l.task_id === task_id && l.status === 'ACTIVE');

  if (!leaseObj) {
    // Lease already gone — treat as success (idempotent)
    return {
      ok:      true,
      action:  'expire_lease',
      details: `Lease not found in leases.json (may have been already corrected) — agent=${agent_id} task=${task_id}`,
    };
  }

  const shortId = (leaseObj.lease_id ?? '').slice(0, 16);
  const notes   = `${notes_prefix} expired_agent=${agent_id} lease_id=${shortId}`;

  // Emit LEASE_EXPIRED via event-writer.mjs (acquires WRITE.lock)
  if (!fs.existsSync(WRITER_PATH)) {
    return { ok: false, action: 'expire_lease', details: 'event-writer.mjs not found', error: 'ERR_WRITER_MISSING' };
  }

  acquireWriteLock();
  try {
    const evResult = emitEvent({
      event_type:     'LEASE_EXPIRED',
      engine_version:  engineVersion,
      timestamp,
      task_id,
      agent:           null,
      role:            'system',
      model:           null,
      notes,
    });

    if (!evResult.ok) {
      return {
        ok:      false,
        action:  'expire_lease',
        details: `LEASE_EXPIRED event write failed: ${evResult.error}`,
        error:   evResult.code,
      };
    }

    // Update leases.json atomically (still under WRITE.lock)
    leaseObj.status      = 'EXPIRED';
    leaseObj.released_at = timestamp;
    writeLeases(store, timestamp);

    return {
      ok:      true,
      action:  'expire_lease',
      details: `LEASE_EXPIRED event at idx=${evResult.event?.event_index ?? '?'} + leases.json updated. lease_id=${shortId}`,
      event:   evResult.event,
    };
  } finally {
    releaseWriteLock();
  }
}

/**
 * Sync lease status to EXPIRED without emitting a new event.
 * Used for R2: the LEASE_EXPIRED event already exists in P1.
 *
 * @param {object} rec
 * @param {string} timestamp
 * @returns {{ ok: boolean, action: string, details: string, error?: string }}
 */
function applySyncLeaseToExpired(rec, timestamp) {
  const { agent_id, task_id, lease_id } = rec;

  acquireWriteLock();
  try {
    const store = readLeases();
    const leaseObj = lease_id
      ? store.leases.find(l => l.lease_id === lease_id)
      : store.leases.find(l => l.agent_id === agent_id && l.task_id === task_id && l.status === 'ACTIVE');

    if (!leaseObj) {
      return {
        ok:      true,
        action:  'sync_lease_status_to_expired',
        details: `Lease already gone — agent=${agent_id} task=${task_id} (idempotent)`,
      };
    }

    leaseObj.status      = 'EXPIRED';
    leaseObj.released_at = timestamp;
    writeLeases(store, timestamp);

    return {
      ok:      true,
      action:  'sync_lease_status_to_expired',
      details: `leases.json synced: lease ${leaseObj.lease_id?.slice(0, 16)} → EXPIRED (no new event; event already in P1)`,
    };
  } finally {
    releaseWriteLock();
  }
}

// ---------------------------------------------------------------------------
// Action dispatcher
// ---------------------------------------------------------------------------

/**
 * Dispatch one recommendation to the appropriate repair action.
 *
 * @param {object} rec          recommendation from consistency report
 * @param {string} timestamp
 * @param {number} engineVersion
 * @returns {{ ok: boolean, action: string, details: string, event?: object, error?: string }}
 */
function applyRecommendation(rec, timestamp, engineVersion) {
  const notes = rec.notes_template ?? `consistency_rule=${rec.rule_id}`;

  switch (rec.action) {

    case 'expire_lease':
    case 'expire_older_lease': {
      // For R3 (duplicate slot), the recommendation carries expire_lease_id
      const target = rec.expire_lease_id
        ? { ...rec, lease_id: rec.expire_lease_id }
        : rec;
      return applyExpireLease(target, timestamp, engineVersion, notes);
    }

    case 'sync_lease_status_to_expired':
      return applySyncLeaseToExpired(rec, timestamp);

    case 'rebuild_agent_registry': {
      const result = runScript(AGENT_RUNTIME, ['rebuild']);
      return {
        ok:      result.ok,
        action:  'rebuild_agent_registry',
        details: result.ok
          ? `agents/registry.json rebuilt (${result.output?.agents ?? '?'} agents, ${result.output?.event_count ?? '?'} events)`
          : `Rebuild failed: ${result.error ?? 'exit non-zero'}`,
        error:   result.ok ? undefined : 'ERR_REBUILD_FAILED',
      };
    }

    case 'run_expire_check': {
      const result = runScript(LEASE_MANAGER, ['expire', '--timestamp', timestamp]);
      const expired = result.output?.expired ?? [];
      return {
        ok:      result.ok,
        action:  'run_expire_check',
        details: result.ok
          ? `Expire check complete — ${expired.length} lease(s) expired`
          : `Expire check failed: ${result.error ?? 'exit non-zero'}`,
        error:   result.ok ? undefined : 'ERR_EXPIRE_CHECK_FAILED',
      };
    }

    case 'halt_all_operations':
      // CORRUPT — no repair is possible; this is a manual intervention case
      return {
        ok:      false,
        action:  'halt_all_operations',
        details: 'CORRUPT state: hash chain broken. Manual intervention required. Run: node .task-locks/audit.mjs --verbose',
        error:   'ERR_CORRUPT_CHAIN',
      };

    case 'suggest_snapshot':
      // Never auto-create snapshots — only print the suggestion
      return {
        ok:      true,
        action:  'suggest_snapshot',
        details: `Snapshot suggested: node .task-locks/snapshot-writer.mjs (not auto-applied — requires Architect approval)`,
      };

    case 'notify_architect':
      return {
        ok:      true,
        action:  'notify_architect',
        details: `DEGRADED notice logged. Architect review recommended. Rule: ${rec.rule_id}`,
      };

    case 'notify_agent':
      return {
        ok:      true,
        action:  'notify_agent',
        details: `Advisory warning: lease for task ${rec.task_id ?? '?'} (agent ${rec.agent_id ?? '?'}) approaching expiry`,
      };

    case 'inspect_trust_report':
      return {
        ok:      true,
        action:  'inspect_trust_report',
        details: `Trust report is DEGRADED. Run: node .task-locks/trust-report.mjs --json`,
      };

    case 'none':
      return {
        ok:      true,
        action:  'none',
        details: 'No action needed.',
      };

    default:
      return {
        ok:      false,
        action:  rec.action,
        details: `Unknown action: "${rec.action}"`,
        error:   'ERR_UNKNOWN_ACTION',
      };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   ok:        boolean,
 *   applied:   number,
 *   skipped:   number,
 *   failed:    number,
 *   results:   object[]
 * }} RepairReport
 */

async function main() {
  const timestamp     = TIMESTAMP_OVERRIDE ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const engineVersion = readEngineVersion();

  // ── 1. Load consistency report ────────────────────────────────
  let report;

  if (AUTO_RUN) {
    if (!JSON_OUT) process.stdout.write('[repair-manager] Running consistency-checker.mjs…\n');
    const checkerResult = runChecker();
    if (!checkerResult.ok) {
      const msg = `Failed to run consistency-checker.mjs: ${checkerResult.error}`;
      if (JSON_OUT) {
        process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      } else {
        console.error(`FAIL: ${msg}`);
      }
      process.exit(2);
    }
    report = checkerResult.report;
  } else if (FROM_STDIN) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    try { report = JSON.parse(raw); }
    catch (e) {
      const msg = `stdin is not valid JSON: ${e.message}`;
      if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      else console.error(`FAIL: ${msg}`);
      process.exit(2);
    }
  } else if (REPORT_FILE) {
    if (!fs.existsSync(REPORT_FILE)) {
      const msg = `Report file not found: ${REPORT_FILE}`;
      if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      else console.error(`FAIL: ${msg}`);
      process.exit(2);
    }
    try { report = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8')); }
    catch (e) {
      const msg = `Report file is not valid JSON: ${e.message}`;
      if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
      else console.error(`FAIL: ${msg}`);
      process.exit(2);
    }
  } else {
    const msg = 'No input source: use --stdin, --report <file>, or --auto';
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else console.error(`FAIL: ${msg}`);
    process.exit(2);
  }

  // ── 2. Handle CONSISTENT ─────────────────────────────────────
  if (report.status === 'CONSISTENT' && (report.recommendations ?? []).length === 0) {
    const result = { ok: true, status: 'CONSISTENT', applied: 0, skipped: 0, failed: 0, results: [] };
    if (JSON_OUT) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else console.log('OK: system is CONSISTENT — nothing to repair.');
    process.exit(0);
  }

  // ── 3. Handle CORRUPT (halt before touching anything) ────────
  if (report.status === 'CORRUPT') {
    const msg = 'CORRUPT state detected. No automated repair is possible. Run: node .task-locks/audit.mjs --verbose';
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify({
        ok: false, status: 'CORRUPT', error: msg,
        applied: 0, skipped: 0, failed: 1, results: [],
      }, null, 2) + '\n');
    } else {
      console.error(`\n  ✗  CORRUPT: ${msg}\n`);
    }
    process.exit(2);
  }

  // ── 4. Apply corrections ──────────────────────────────────────
  const recommendations = report.recommendations ?? [];
  /** @type {object[]} */
  const results = [];
  let applied = 0, skipped = 0, failed = 0;

  for (const rec of recommendations) {
    // Filter: --blocking-only skips STALE/DRIFTED/DEGRADED non-blocking actions
    if (BLOCKING_ONLY && !rec.blocking && rec.result !== 'INVALID') {
      skipped++;
      if (VERBOSE_RESULTS) {
        results.push({ rule_id: rec.rule_id, action: rec.action, result: 'skipped', reason: '--blocking-only' });
      }
      continue;
    }

    // Filter: --rule <id>
    if (RULE_FILTER && rec.rule_id !== RULE_FILTER) {
      skipped++;
      continue;
    }

    // Skip informational-only actions in non-verbose mode unless JSON
    const INFO_ACTIONS = new Set(['notify_agent', 'inspect_trust_report', 'none']);
    if (!JSON_OUT && !argv.includes('--verbose') && INFO_ACTIONS.has(rec.action)) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      results.push({
        rule_id: rec.rule_id,
        action:  rec.action,
        result:  'dry-run',
        details: `Would apply: ${rec.action} for agent=${rec.agent_id ?? '?'} task=${rec.task_id ?? '?'}`,
      });
      applied++;
      continue;
    }

    const actionResult = applyRecommendation(rec, timestamp, engineVersion);
    results.push({
      rule_id:   rec.rule_id,
      action:    rec.action,
      result:    actionResult.ok ? 'applied' : 'failed',
      details:   actionResult.details,
      event:     actionResult.event ?? undefined,
      error:     actionResult.error ?? undefined,
    });

    if (actionResult.ok) {
      applied++;
      if (!JSON_OUT) console.log(`  ✓  [${rec.rule_id}] ${actionResult.details}`);
    } else {
      failed++;
      if (!JSON_OUT) console.error(`  ✗  [${rec.rule_id}] ${actionResult.details}`);
      // Halt on CORRUPT
      if (actionResult.error === 'ERR_CORRUPT_CHAIN') break;
    }
  }

  // ── 5. Output report ──────────────────────────────────────────
  const ok = failed === 0;

  /** @type {RepairReport} */
  const repairReport = {
    ok,
    status:              report.status,
    dry_run:             DRY_RUN,
    generated_at:        timestamp,
    applied,
    skipped,
    failed,
    results,
  };

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(repairReport, null, 2) + '\n');
  } else {
    const WIDTH = 60;
    console.log('');
    console.log('─'.repeat(WIDTH));
    console.log(ok
      ? `OK: ${applied} correction(s) applied${skipped > 0 ? `, ${skipped} skipped` : ''}.`
      : `FAIL: ${failed} correction(s) failed, ${applied} applied.`
    );
    if (failed > 0) {
      console.log('Re-run consistency-checker.mjs to verify remaining issues.');
    }
    console.log('');
  }

  process.exit(ok ? 0 : 1);
}

// Hide the unused VERBOSE_RESULTS flag warning (used in the loop)
const VERBOSE_RESULTS = argv.includes('--verbose');

main().catch(err => {
  const msg = `[repair-manager] Fatal: ${err.message}`;
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else console.error(msg);
  process.exit(2);
});
