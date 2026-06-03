/**
 * event-writer.mjs — Canonical validated append path for TASK_EVENTS.jsonl
 *
 * This is the ONLY authorized writer for TASK_EVENTS.jsonl (apart from the
 * initial ENGINE_INITIALIZED seed).  All agents, CI jobs, and the HTTP gate
 * MUST call this module instead of writing directly to the event log.
 *
 * What it does:
 *   1.  Parse the event payload from stdin or --event <file>.
 *   2.  Validate event_type against the frozen enum.
 *   3.  Validate per-type required fields (mirrors allOf in event.schema.json).
 *   4.  Check engine_version matches transitions.yaml (no silent drift).
 *   5.  Acquire a file-level advisory write lock (.task-locks/WRITE.lock).
 *   6.  Read current TASK_EVENTS.jsonl to get HEAD state.
 *   7.  Compute: event_index  = current line count.
 *               prev_event_hash = last event's event_hash (or "GENESIS").
 *               event_hash      = SHA-256(canonical(core) + prev_hash).
 *   8.  Verify hash parity: the algorithm is IDENTICAL to audit.mjs
 *       (sha256(JSON.stringify(sortedKeys(ev_minus_both_hash_fields)) + prevHashValue)).
 *   9.  Append the complete event as one JSON line to TASK_EVENTS.jsonl.
 *  10.  Release the write lock.
 *  11.  Optionally trigger replayer.mjs to rebuild registry.json.
 *
 * Input payload fields:
 *   Required: event_type, engine_version, timestamp
 *   Per-type: see REQUIRED_BY_TYPE below (mirrors event.schema.json allOf)
 *   Optional/computed: event_index, prev_event_hash, event_hash
 *     (computed values override any values present in the payload)
 *
 * Usage:
 *   echo '{...}' | node .task-locks/event-writer.mjs [options]
 *   node .task-locks/event-writer.mjs --event /tmp/ev.json [options]
 *
 * Options:
 *   --event <path>       Read payload from this file instead of stdin.
 *   --timestamp <ISO>    Override timestamp in payload (CI use: inject from runner).
 *   --rebuild            Run replayer.mjs after writing to refresh registry.json.
 *   --json               Emit structured JSON to stdout.
 *   --dry-run            Validate and compute, but do not write.
 *   --no-lock            Skip the advisory write lock (DANGEROUS — CI git-retry only).
 *
 * Output (--json):
 *   Success: { "ok": true,  "event": { ...complete event... } }
 *   Failure: { "ok": false, "error": "...",  "code": "ERR_CODE" }
 *
 * Exit codes:
 *   0  — event written (or validated in --dry-run).
 *   1  — validation or write failure.
 *   2  — usage error or file not found.
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: writes ONLY to TASK_EVENTS.jsonl (append) and .task-locks/WRITE.lock.
 *           NEVER edits existing events. NEVER writes to registry.json (that is
 *           replayer.mjs's job, only when --rebuild is passed).
 */

import crypto   from 'node:crypto';
import fs       from 'node:fs';
import path     from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR     = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT  = path.dirname(LOCKS_DIR);

const EVENTS_PATH      = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const TRANSITIONS_YAML = path.join(LOCKS_DIR,    'transitions.yaml');
const LOCK_FILE        = path.join(LOCKS_DIR,    'WRITE.lock');
const REPLAYER_SCRIPT  = path.join(LOCKS_DIR,    'replayer.mjs');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const JSON_OUT = argv.includes('--json');
const REBUILD  = argv.includes('--rebuild');
const NO_LOCK  = argv.includes('--no-lock');

const EVENT_FILE = (() => {
  const i = argv.indexOf('--event');
  return i >= 0 ? argv[i + 1] : null;
})();

const TIMESTAMP_OVERRIDE = (() => {
  const i = argv.indexOf('--timestamp');
  return i >= 0 ? argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// Known constants (mirrors event.schema.json — must stay in sync)
// ---------------------------------------------------------------------------

const KNOWN_EVENT_TYPES = new Set([
  'ENGINE_INITIALIZED',
  'TASK_CLAIMED',
  'TASK_HEARTBEAT',
  'TASK_REVIEW_REQUESTED',
  'TASK_REFACTOR_REQUESTED',
  'TASK_REFACTOR_COMPLETE',
  'TASK_APPROVED',
  'TASK_REJECTED',
  'TASK_MERGED',
  'TASK_LOCK_EXPIRED',
  'TASK_ARCHITECT_OVERRIDE',
  'TASK_FORKED',
  'PROJECTION_REBUILT',
  'SNAPSHOT_CREATED',
  // Agent Runtime Layer (schema_version 1.2.0)
  'AGENT_REGISTERED',
  'TASK_RELEASED',
  'LEASE_RENEWED',
  'LEASE_EXPIRED',
  // Scheduler Layer (schema_version 1.3.0)
  'TASK_PRIORITY_SET',
  'TASK_PRIORITY_CLEARED',
  // Idea Factory Layer (schema_version 2.0.0)
  'IDEA_SUBMITTED',
  'ARCHITECTURE_GENERATED',
  'TASK_GRAPH_CREATED',
  'TASK_CREATED',
  'TASK_BID_SUBMITTED',
  'TASK_BID_WON',
  'TASK_PRICE_DISCOVERED',
]);

const KNOWN_PROPERTIES = new Set([
  'event_index', 'event_type', 'engine_version', 'timestamp',
  'task_id', 'agent', 'role', 'model', 'branch', 'pr_number',
  'forked_from', 'fork_suffix', 'override_reason', 'notes',
  'prev_event_hash', 'event_hash',
  'snapshot_index',
  'priority_weight', 'execution_cost', 'reason',  // Scheduler Layer (1.3.0)
  'idea_id', 'content', 'source', 'architecture_id', 'architecture',
  'task_graph', 'parent_idea', 'description', 'module',
  'bid_id', 'bid_strength', 'cost_offer', 'confidence',
  'winning_bid_id', 'price_multiplier',
]);

// Per-type required non-null fields (mirrors allOf in event.schema.json)
const REQUIRED_BY_TYPE = {
  ENGINE_INITIALIZED:       { required: [], requireNull: ['task_id', 'agent', 'role', 'model'] },
  TASK_CLAIMED:             { required: ['task_id', 'agent', 'role', 'model', 'branch'] },
  TASK_HEARTBEAT:           { required: ['task_id', 'agent', 'role', 'model'] },
  TASK_REVIEW_REQUESTED:    { required: ['task_id', 'agent', 'role', 'model'] },
  TASK_REFACTOR_REQUESTED:  { required: ['task_id', 'agent', 'role', 'model'] },
  TASK_REFACTOR_COMPLETE:   { required: ['task_id', 'agent', 'role', 'model'] },
  TASK_APPROVED:            { required: ['task_id', 'agent', 'role', 'model'] },
  TASK_REJECTED:            { required: ['task_id', 'agent', 'role', 'model'] },
  TASK_MERGED:              { required: ['task_id', 'agent', 'role', 'model'] },
  TASK_LOCK_EXPIRED:        { required: ['task_id'], requireConst: { role: 'system' }, requireNull: ['agent', 'model'] },
  TASK_ARCHITECT_OVERRIDE:  { required: ['task_id', 'agent', 'role', 'model', 'override_reason'] },
  TASK_FORKED:              { required: ['task_id', 'forked_from', 'fork_suffix'], requireConst: { role: 'system' }, requireNull: ['agent'] },
  PROJECTION_REBUILT:       { required: ['notes'], requireConst: { role: 'system' }, requireNull: ['task_id', 'agent'] },
  SNAPSHOT_CREATED:         { required: ['snapshot_index', 'notes'], requireConst: { role: 'system' }, requireNull: ['task_id', 'agent', 'model'] },
  // Agent Runtime Layer
  AGENT_REGISTERED:         { required: ['agent', 'notes'], requireNull: ['task_id'] },
  TASK_RELEASED:            { required: ['task_id', 'agent', 'role'] },
  LEASE_RENEWED:            { required: ['task_id', 'agent', 'role'] },
  LEASE_EXPIRED:            { required: ['task_id'], requireConst: { role: 'system' }, requireNull: ['agent', 'model'] },
  // Scheduler Layer
  TASK_PRIORITY_SET:        { required: ['task_id', 'agent', 'role', 'priority_weight', 'execution_cost'] },
  TASK_PRIORITY_CLEARED:    { required: ['task_id', 'agent', 'role'], requireNull: ['priority_weight', 'execution_cost'] },
  // Idea Factory Layer
  IDEA_SUBMITTED:           { required: ['idea_id', 'content', 'source'], requireNull: ['task_id'] },
  ARCHITECTURE_GENERATED:   { required: ['idea_id', 'architecture_id', 'architecture'], requireNull: ['task_id'] },
  TASK_GRAPH_CREATED:       { required: ['idea_id', 'architecture_id', 'task_graph'], requireNull: ['task_id'] },
  TASK_CREATED:             { required: ['task_id', 'idea_id', 'architecture_id', 'description', 'module', 'priority_weight', 'execution_cost'] },
  TASK_BID_SUBMITTED:       { required: ['task_id', 'agent', 'bid_id', 'bid_strength', 'cost_offer', 'confidence'] },
  TASK_BID_WON:             { required: ['task_id', 'agent', 'bid_id'] },
  TASK_PRICE_DISCOVERED:    { required: ['task_id', 'price_multiplier', 'notes'], requireConst: { role: 'system' } },
};

// All fields that MUST be present in a complete event (null is fine)
const ALL_EVENT_FIELDS = [
  'event_index', 'event_type', 'engine_version', 'timestamp',
  'task_id', 'agent', 'role', 'model', 'branch', 'pr_number',
  'forked_from', 'fork_suffix', 'override_reason', 'notes',
  'prev_event_hash', 'event_hash', 'snapshot_index',
  'priority_weight', 'execution_cost', 'reason',  // Scheduler Layer (1.3.0)
  'idea_id', 'content', 'source', 'architecture_id', 'architecture',
  'task_graph', 'parent_idea', 'description', 'module',
  'bid_id', 'bid_strength', 'cost_offer', 'confidence',
  'winning_bid_id', 'price_multiplier',
];

// ---------------------------------------------------------------------------
// Hash helpers (identical algorithm to audit.mjs — parity guaranteed)
// ---------------------------------------------------------------------------

/** SHA-256 of a string → lower-hex. */
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Return a new object with top-level keys sorted lexicographically. */
function sortedKeys(obj) {
  const s = {};
  for (const k of Object.keys(obj).sort()) s[k] = obj[k];
  return s;
}

/**
 * Compute event_hash.
 * Algorithm (verified in audit.mjs, snapshot-writer.mjs):
 *   sha256( JSON.stringify(sortedKeys(ev minus event_hash minus prev_event_hash))
 *           + prev_event_hash_value )
 *
 * This function takes the COMPLETE event object (with prev_event_hash already set).
 */
function computeEventHash(ev) {
  const { event_hash: _eh, prev_event_hash: prevVal, ...core } = ev;
  return sha256(JSON.stringify(sortedKeys(core)) + prevVal);
}

// ---------------------------------------------------------------------------
// Engine version reader (minimal YAML: just extract `engine_version: N`)
// ---------------------------------------------------------------------------

function readEngineVersion() {
  try {
    const raw = fs.readFileSync(TRANSITIONS_YAML, 'utf8');
    const m   = raw.match(/^engine_version:\s*(\d+)/m);
    return m ? parseInt(m[1], 10) : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Payload validator
// ---------------------------------------------------------------------------

/**
 * Validate event payload (pre-hash fields).
 * Returns an array of error strings (empty = valid).
 *
 * @param {Record<string,unknown>} payload  — may lack event_index/prev/event_hash
 * @param {number|null}            engineVer — from transitions.yaml
 * @returns {string[]}
 */
function validatePayload(payload, engineVer) {
  const errs = [];

  // event_type
  const type = payload.event_type;
  if (typeof type !== 'string') {
    errs.push('event_type must be a string');
    return errs;  // can't do further checks without a valid type
  }
  if (!KNOWN_EVENT_TYPES.has(type)) {
    errs.push(`event_type "${type}" is not in the known enum (event.schema.json)`);
    return errs;
  }

  // engine_version
  if (typeof payload.engine_version !== 'number') {
    errs.push('engine_version must be a number');
  } else if (engineVer !== null && payload.engine_version !== engineVer) {
    errs.push(`engine_version mismatch: payload has ${payload.engine_version}, transitions.yaml has ${engineVer}`);
  }

  // timestamp
  if (!payload.timestamp || typeof payload.timestamp !== 'string') {
    errs.push('timestamp must be a non-empty string');
  } else if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(payload.timestamp)) {
    errs.push(`timestamp "${payload.timestamp}" does not look like an ISO-8601 datetime`);
  }

  // Unknown properties
  for (const k of Object.keys(payload)) {
    if (!KNOWN_PROPERTIES.has(k)) {
      errs.push(`Unknown property "${k}" (additionalProperties: false)`);
    }
  }

  // Per-type field rules
  const rules = REQUIRED_BY_TYPE[type];
  if (rules) {
    for (const f of (rules.required ?? [])) {
      if (payload[f] === undefined || payload[f] === null) {
        errs.push(`${type}: field "${f}" must be non-null`);
      }
    }
    for (const f of (rules.requireNull ?? [])) {
      if (payload[f] !== null && payload[f] !== undefined) {
        errs.push(`${type}: field "${f}" must be null, got ${JSON.stringify(payload[f])}`);
      }
    }
    for (const [f, expected] of Object.entries(rules.requireConst ?? {})) {
      if (payload[f] !== expected) {
        errs.push(`${type}: field "${f}" must be ${JSON.stringify(expected)}, got ${JSON.stringify(payload[f])}`);
      }
    }
  }

  return errs;
}

// ---------------------------------------------------------------------------
// Advisory write lock (file-based)
// ---------------------------------------------------------------------------

const LOCK_TTL_MS   = 15_000;  // 15 s — declare stale after this
const LOCK_RETRIES  = 20;
const LOCK_DELAY_MS = 300;

/** Sleep synchronously (blocking). For lock retry only. */
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait — acceptable for short lock waits */ }
}

/** Attempt to acquire the write lock. Returns true on success, throws on timeout. */
function acquireLock() {
  for (let i = 0; i < LOCK_RETRIES; i++) {
    try {
      // O(excl) — atomic create, fails if file exists
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return;  // acquired
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;

      // Lock exists — check if stale
      try {
        const lockData = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
        if (Date.now() - lockData.at > LOCK_TTL_MS) {
          // Stale lock — delete and retry immediately
          fs.unlinkSync(LOCK_FILE);
          continue;
        }
      } catch { /* lock file disappeared between check and read — retry */ }

      // Active lock — wait with small random jitter to avoid thundering herd
      sleepSync(LOCK_DELAY_MS + Math.floor(Math.random() * 100));
    }
  }
  throw Object.assign(
    new Error(`Could not acquire write lock after ${LOCK_RETRIES} attempts (${LOCK_TTL_MS / 1000}s window)`),
    { code: 'ERR_LOCK_TIMEOUT' }
  );
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already released — fine */ }
}

// ---------------------------------------------------------------------------
// Read current TASK_EVENTS.jsonl state
// ---------------------------------------------------------------------------

/**
 * @returns {{ lineCount: number, headHash: string }}
 */
function readCurrentHead() {
  if (!fs.existsSync(EVENTS_PATH)) {
    return { lineCount: 0, headHash: 'GENESIS' };
  }
  const raw   = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length === 0) {
    return { lineCount: 0, headHash: 'GENESIS' };
  }
  const last = JSON.parse(lines[lines.length - 1]);
  return {
    lineCount: lines.length,
    headHash:  last.event_hash,
  };
}

// ---------------------------------------------------------------------------
// Build complete event from payload
// ---------------------------------------------------------------------------

/**
 * Fill in all fields and compute hashes.
 * @param {Record<string,unknown>} payload
 * @param {number} lineCount
 * @param {string} headHash
 * @param {string|null} timestampOverride
 * @returns {Record<string,unknown>}  complete event
 */
function buildEvent(payload, lineCount, headHash, timestampOverride) {
  // Base: fill in all known properties with null as default
  const ev = {};
  for (const f of ALL_EVENT_FIELDS) {
    ev[f] = f in payload ? payload[f] : null;
  }

  // Inject computed fields
  ev.event_index      = lineCount;
  ev.prev_event_hash  = headHash;
  ev.event_hash       = '';  // placeholder — computed below

  // Apply timestamp override (CI injection)
  if (timestampOverride) {
    ev.timestamp = timestampOverride;
  }

  // Compute event_hash
  ev.event_hash = computeEventHash(ev);

  return ev;
}

// ---------------------------------------------------------------------------
// Atomic append
// ---------------------------------------------------------------------------

/**
 * Append one JSON line to TASK_EVENTS.jsonl.
 * Does NOT use tmp+rename because JSONL files are append-only;
 * fs.appendFileSync is safe for single-process + advisory lock usage.
 */
function appendEvent(ev) {
  fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
  fs.appendFileSync(EVENTS_PATH, JSON.stringify(ev) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function abort(msg, code = 1, errCode = 'ERR_WRITE_FAILED') {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: false, error: msg, code: errCode }) + '\n');
  } else {
    console.error(`FAIL: ${msg}`);
  }
  process.exit(code);
}

function succeed(ev) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: true, event: ev }) + '\n');
  } else {
    const tag = DRY_RUN ? '[dry-run] Would write' : 'Written';
    console.log(`${tag}: event_type=${ev.event_type}  idx=${ev.event_index}  hash=${ev.event_hash.slice(0, 16)}…`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ── Required files check ───────────────────────────────────────────
  if (!fs.existsSync(EVENTS_PATH)) {
    abort(`TASK_EVENTS.jsonl not found at ${EVENTS_PATH}`, 2, 'ERR_NO_EVENT_LOG');
  }
  if (!fs.existsSync(TRANSITIONS_YAML)) {
    abort(`transitions.yaml not found at ${TRANSITIONS_YAML}`, 2, 'ERR_NO_TRANSITIONS');
  }

  // ── Read engine version ────────────────────────────────────────────
  const engineVer = readEngineVersion();
  if (engineVer === null) {
    abort('Could not read engine_version from transitions.yaml', 2, 'ERR_NO_ENGINE_VERSION');
  }

  // ── Read payload ───────────────────────────────────────────────────
  let rawPayload;
  if (EVENT_FILE) {
    if (!fs.existsSync(EVENT_FILE)) {
      abort(`Event file not found: ${EVENT_FILE}`, 2, 'ERR_NO_EVENT_FILE');
    }
    rawPayload = fs.readFileSync(EVENT_FILE, 'utf8');
  } else {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    rawPayload = chunks.join('').trim();
    if (!rawPayload) {
      abort('No input: pass event JSON via stdin or --event <file>', 2, 'ERR_NO_INPUT');
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (e) {
    abort(`Payload is not valid JSON: ${e.message}`, 1, 'ERR_INVALID_JSON');
  }

  // ── Validate payload ───────────────────────────────────────────────
  const errors = validatePayload(payload, engineVer);
  if (errors.length > 0) {
    const msg = `Event payload validation failed (${errors.length} error(s)):\n` +
      errors.map(e => `  ✗ ${e}`).join('\n');
    abort(msg, 1, 'ERR_VALIDATION');
  }

  // ── Dry-run: show what would happen ───────────────────────────────
  if (DRY_RUN) {
    const { lineCount, headHash } = readCurrentHead();
    const ev = buildEvent(payload, lineCount, headHash, TIMESTAMP_OVERRIDE);
    if (JSON_OUT) {
      process.stdout.write(JSON.stringify({ ok: true, dry_run: true, event: ev }) + '\n');
    } else {
      console.log('[dry-run] Computed event:');
      console.log(`  event_index:     ${ev.event_index}`);
      console.log(`  event_type:      ${ev.event_type}`);
      console.log(`  prev_event_hash: ${ev.prev_event_hash.slice(0, 16)}…`);
      console.log(`  event_hash:      ${ev.event_hash.slice(0, 16)}…`);
      console.log('');
      console.log('No files modified (dry-run).');
    }
    process.exit(0);
  }

  // ── Acquire write lock ─────────────────────────────────────────────
  if (!NO_LOCK) {
    try {
      acquireLock();
    } catch (e) {
      abort(e.message, 1, e.code ?? 'ERR_LOCK_TIMEOUT');
    }
  }

  let ev;
  try {
    // ── Atomic section: read HEAD + compute + append ─────────────────
    const { lineCount, headHash } = readCurrentHead();
    ev = buildEvent(payload, lineCount, headHash, TIMESTAMP_OVERRIDE);
    appendEvent(ev);
  } catch (e) {
    if (!NO_LOCK) releaseLock();
    abort(`Write failed: ${e.message}`, 1, 'ERR_APPEND_FAILED');
  }

  if (!NO_LOCK) releaseLock();

  // ── Optional: rebuild registry.json ───────────────────────────────
  if (REBUILD) {
    const result = spawnSync(process.execPath, [REPLAYER_SCRIPT], { encoding: 'utf8' });
    if (!JSON_OUT) {
      if (result.status === 0) console.log('[event-writer] registry.json rebuilt.');
      else console.warn(`[event-writer] replayer returned exit ${result.status}: ${result.stderr.trim()}`);
    }
  }

  succeed(ev);
  process.exit(0);
}

main().catch(err => {
  console.error('[event-writer] Fatal:', err);
  process.exit(2);
});
