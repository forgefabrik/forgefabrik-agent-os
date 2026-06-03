/**
 * snapshot-writer.mjs — Creates a new registry snapshot and records it in TASK_EVENTS.jsonl
 *
 * Produces:
 *   .task-locks/snapshots/snapshot_N.json   — the registry checkpoint
 *   TASK_EVENTS.jsonl                        — appends a SNAPSHOT_CREATED event (index N+1)
 *
 * Pre-conditions (checked before writing anything):
 *   1.  audit.mjs passes — hash chain is clean.
 *   2.  registry.json is current — matches a fresh replay of TASK_EVENTS.jsonl.
 *       Run `node .task-locks/replayer.mjs` first if not.
 *   3.  genesis_hash in snapshot_0.json matches the computed value.
 *
 * Usage:
 *   node .task-locks/snapshot-writer.mjs [options]
 *
 * Options:
 *   --timestamp <ISO>   UTC timestamp to inject (required in CI, optional locally).
 *                       Example: --timestamp 2026-06-03T12:00:00Z
 *   --dry-run           Show what would be written without touching any file.
 *   --skip-audit        Skip the audit pre-check (NOT recommended).
 *   --skip-verify       Skip the registry-current pre-check.
 *   --force             Shorthand for --skip-audit --skip-verify (DANGEROUS).
 *   --json              Emit structured JSON result to stdout.
 *
 * Exit codes:
 *   0  — snapshot written and event appended successfully.
 *   1  — pre-condition failed or write error.
 *   2  — usage error or required file missing.
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads .task-locks/* and TASK_EVENTS.jsonl.
 *           Writes only .task-locks/snapshots/snapshot_N.json
 *           and appends ONE line to TASK_EVENTS.jsonl.
 *           NEVER edits or deletes existing events.
 */

import crypto   from 'node:crypto';
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

const EVENTS_PATH     = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const REGISTRY_PATH   = path.join(LOCKS_DIR,    'registry.json');
const GENESIS_PATH    = path.join(LOCKS_DIR,    'genesis.json');
const SNAPSHOTS_DIR   = path.join(LOCKS_DIR,    'snapshots');
const AUDIT_SCRIPT    = path.join(LOCKS_DIR,    'audit.mjs');
const REPLAYER_SCRIPT = path.join(LOCKS_DIR,    'replayer.mjs');

const GENESIS_HASH_CONST =
  '1eb7528ebb64a57fb9b8b567bc9b613911aa3c213e7aaf731ce3fbdc77584eb1';
const ENGINE_VERSION = 1;

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv        = process.argv.slice(2);
const DRY_RUN     = argv.includes('--dry-run');
const SKIP_AUDIT  = argv.includes('--skip-audit')  || argv.includes('--force');
const SKIP_VERIFY = argv.includes('--skip-verify') || argv.includes('--force');
const JSON_OUT    = argv.includes('--json');

const TIMESTAMP_FLAG = (() => {
  const i = argv.indexOf('--timestamp');
  return i >= 0 ? argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// Hash helpers (same algorithms as audit.mjs — kept in sync, no dep)
// ---------------------------------------------------------------------------

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

function sortedKeys(obj) {
  const s = {};
  for (const k of Object.keys(obj).sort()) s[k] = obj[k];
  return s;
}

/**
 * Compute event_hash for a new event.
 * Algorithm (verified in audit.mjs):
 *   sha256( canonical(ev minus event_hash minus prev_event_hash) + prev_event_hash_value )
 */
function computeEventHash(ev) {
  const { event_hash: _eh, prev_event_hash: prevVal, ...core } = ev;
  return sha256(JSON.stringify(sortedKeys(core)) + prevVal);
}

// ---------------------------------------------------------------------------
// Read the last non-blank line of TASK_EVENTS.jsonl
// ---------------------------------------------------------------------------

async function readHeadEvent() {
  const lines = fs.readFileSync(EVENTS_PATH, 'utf8')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  if (lines.length === 0) throw new Error('TASK_EVENTS.jsonl is empty');

  return JSON.parse(lines[lines.length - 1]);
}

// ---------------------------------------------------------------------------
// Determine next snapshot_index
// ---------------------------------------------------------------------------

function nextSnapshotIndex() {
  fs.mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  const existing = fs.readdirSync(SNAPSHOTS_DIR)
    .filter(f => /^snapshot_\d+\.json$/.test(f));
  return existing.length; // 0-based: existing.length is the next N
}

// ---------------------------------------------------------------------------
// Run a Node.js script and return { ok, stdout, stderr, code }
// ---------------------------------------------------------------------------

function runScript(scriptPath, flags = []) {
  const result = spawnSync(
    process.execPath,  // same node binary
    [scriptPath, ...flags],
    { encoding: 'utf8', timeout: 30_000 }
  );
  return {
    ok:     result.status === 0,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    code:   result.status,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function abort(msg, code = 1) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  } else {
    console.error(`FAIL: ${msg}`);
  }
  process.exit(code);
}

async function main() {
  // ── Required files check ───────────────────────────────────────────
  for (const [label, p] of [
    ['TASK_EVENTS.jsonl', EVENTS_PATH],
    ['registry.json',     REGISTRY_PATH],
    ['genesis.json',      GENESIS_PATH],
  ]) {
    if (!fs.existsSync(p)) abort(`${label} not found at ${p}`, 2);
  }

  // ── Timestamp ─────────────────────────────────────────────────────
  const timestamp = TIMESTAMP_FLAG ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  // Validate ISO format
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    abort(`Invalid --timestamp format. Expected YYYY-MM-DDTHH:MM:SSZ, got: ${timestamp}`, 2);
  }

  // ── Pre-check 1: Audit ─────────────────────────────────────────────
  if (!SKIP_AUDIT) {
    if (!JSON_OUT) process.stdout.write('[snapshot-writer] Running audit…\n');
    const audit = runScript(AUDIT_SCRIPT, ['--json', '--events', EVENTS_PATH]);
    if (!audit.ok) {
      let reason = 'audit failed';
      try {
        const report = JSON.parse(audit.stdout);
        reason = `${report.violations_count} audit violation(s) — run audit.mjs for details`;
      } catch { reason = audit.stdout.trim() || audit.stderr.trim() || 'unknown error'; }
      abort(`Cannot snapshot: ${reason}. Use --skip-audit to override (DANGEROUS).`);
    }
    if (!JSON_OUT) process.stdout.write('[snapshot-writer] Audit passed ✓\n');
  }

  // ── Pre-check 2: Registry is current ──────────────────────────────
  if (!SKIP_VERIFY) {
    if (!JSON_OUT) process.stdout.write('[snapshot-writer] Verifying registry.json is current…\n');
    const verify = runScript(REPLAYER_SCRIPT, ['--verify']);
    if (!verify.ok) {
      abort(
        'registry.json is stale. Run: node .task-locks/replayer.mjs\n' +
        'Then retry the snapshot.'
      );
    }
    if (!JSON_OUT) process.stdout.write('[snapshot-writer] Registry current ✓\n');
  }

  // ── Read HEAD event ────────────────────────────────────────────────
  let headEvent;
  try { headEvent = await readHeadEvent(); }
  catch (e) { abort(`Could not read HEAD event: ${e.message}`); }

  const headIndex = headEvent.event_index;
  const headHash  = headEvent.event_hash;

  // ── Determine snapshot_index ───────────────────────────────────────
  const snapshotIndex = nextSnapshotIndex();
  const snapshotPath  = path.join(SNAPSHOTS_DIR, `snapshot_${snapshotIndex}.json`);
  const nextEventIdx  = headIndex + 1;

  // ── Read current registry ──────────────────────────────────────────
  let registry;
  try { registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); }
  catch (e) { abort(`Could not read registry.json: ${e.message}`); }

  // ── Build snapshot data ────────────────────────────────────────────
  const snapshot = {
    snapshot_version:  1,
    projection_version: ENGINE_VERSION,
    snapshot_index:    snapshotIndex,
    event_index:       headIndex,
    event_hash:        headHash,
    genesis_hash:      GENESIS_HASH_CONST,
    registry,
  };

  // ── Build SNAPSHOT_CREATED event ──────────────────────────────────
  const notesStr = `event_count=${registry.event_count} genesis_hash=${GENESIS_HASH_CONST}`;

  const newEvent = {
    event_index:     nextEventIdx,
    event_type:      'SNAPSHOT_CREATED',
    engine_version:  ENGINE_VERSION,
    timestamp,
    task_id:         null,
    agent:           null,
    role:            'system',
    model:           null,
    branch:          null,
    pr_number:       null,
    forked_from:     null,
    fork_suffix:     null,
    override_reason: null,
    snapshot_index:  snapshotIndex,
    notes:           notesStr,
    prev_event_hash: headHash,
    event_hash:      '',  // will be replaced after computation
  };

  // Compute the hash after all fields are set (excluding event_hash itself)
  newEvent.event_hash = computeEventHash(newEvent);

  // ── Dry-run output ─────────────────────────────────────────────────
  if (DRY_RUN) {
    const report = {
      dry_run:        true,
      snapshot_index: snapshotIndex,
      snapshot_path:  snapshotPath,
      event_index:    nextEventIdx,
      event_hash:     newEvent.event_hash,
      snapshot:       snapshot,
      new_event:      newEvent,
    };
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      console.log('\n[dry-run] Would write:');
      console.log(`  Snapshot : ${snapshotPath}`);
      console.log(`  Event    : SNAPSHOT_CREATED @ index ${nextEventIdx}`);
      console.log(`  Event hash: ${newEvent.event_hash.slice(0, 16)}…`);
      console.log('');
      console.log('No files modified (dry-run).');
    }
    process.exit(0);
  }

  // ── Write snapshot file (first, before touching the event log) ─────
  // Snapshots directory is created in nextSnapshotIndex().
  const snapshotJson = JSON.stringify(snapshot, null, 2) + '\n';
  try {
    const tmpPath = snapshotPath + '.tmp';
    fs.writeFileSync(tmpPath, snapshotJson, 'utf8');
    fs.renameSync(tmpPath, snapshotPath);
  } catch (e) {
    abort(`Failed to write snapshot file: ${e.message}`);
  }

  // ── Append SNAPSHOT_CREATED event to TASK_EVENTS.jsonl ────────────
  try {
    fs.appendFileSync(EVENTS_PATH, JSON.stringify(newEvent) + '\n', 'utf8');
  } catch (e) {
    // Event write failed AFTER snapshot was written.
    // The snapshot file exists without a log record.
    // Report clearly — the operator must manually append the event or delete the snapshot.
    abort(
      `CRITICAL: snapshot_${snapshotIndex}.json was written but TASK_EVENTS.jsonl append failed: ${e.message}\n` +
      `Action required: either append the event manually or delete ${snapshotPath}.`
    );
  }

  // ── Success ───────────────────────────────────────────────────────
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok:             true,
      snapshot_index: snapshotIndex,
      snapshot_path:  snapshotPath,
      event_index:    nextEventIdx,
      event_hash:     newEvent.event_hash,
      timestamp,
    }) + '\n');
  } else {
    console.log('');
    console.log('[snapshot-writer] Snapshot created.');
    console.log(`  snapshot_${snapshotIndex}.json @ event_index=${headIndex}  (${headHash.slice(0,16)}…)`);
    console.log(`  SNAPSHOT_CREATED event appended @ index=${nextEventIdx}  (${newEvent.event_hash.slice(0,16)}…)`);
    console.log('');
    console.log('Next step: run audit.mjs to verify the new chain.');
    console.log('');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('[snapshot-writer] Fatal:', err);
  process.exit(2);
});
