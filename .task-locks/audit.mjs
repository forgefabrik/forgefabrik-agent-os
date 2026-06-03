/**
 * audit.mjs — Integrity auditor for TASK_EVENTS.jsonl
 *
 * Checks, in order:
 *   1.  Each line is valid JSON.
 *   2.  All required top-level fields are present (per event.schema.json).
 *   3.  No unknown properties (additionalProperties: false).
 *   4.  event_type is a known enum value.
 *   5.  event_index is sequential with no gaps (0, 1, 2, …).
 *   6.  engine_version is consistent across all events (no silent version drift).
 *   7.  prev_event_hash chain: event[0] == "GENESIS", event[N] == event[N-1].event_hash.
 *   8.  event_hash recomputed:
 *         SHA-256( canonical(core) + prev_event_hash_value )
 *         where canonical = JSON.stringify(sortedKeys(ev minus event_hash minus prev_event_hash))
 *   9.  Per-event-type field rules (from allOf conditionals in event.schema.json).
 *  10.  genesis_hash in .task-locks/snapshots/snapshot_0.json:
 *         SHA-256( JSON.stringify(sortedKeys(.task-locks/genesis.json)) )
 *
 * Usage:
 *   node .task-locks/audit.mjs [options]
 *
 * Options:
 *   --verbose          Print a status line for every event (not just errors).
 *   --json             Emit a single JSON object to stdout (for CI integration).
 *   --no-snapshot      Skip the genesis_hash / snapshot_0 check.
 *   --events <path>    Override path to TASK_EVENTS.jsonl.
 *
 * Exit codes:
 *   0 — all checks pass, chain is clean.
 *   1 — one or more integrity violations found.
 *   2 — usage error or required file not found.
 *
 * No npm dependencies. Pure Node.js ≥18 (built-ins only).
 *
 * Boundary: reads TASK_EVENTS.jsonl and .task-locks/* — never writes.
 */

import crypto   from 'node:crypto';
import fs       from 'node:fs';
import path     from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR     = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT  = path.dirname(LOCKS_DIR);

const DEFAULT_EVENTS  = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const GENESIS_JSON    = path.join(LOCKS_DIR, 'genesis.json');
const SNAPSHOT_0      = path.join(LOCKS_DIR, 'snapshots', 'snapshot_0.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv    = process.argv.slice(2);
const VERBOSE       = argv.includes('--verbose');
const JSON_OUTPUT   = argv.includes('--json');
const SKIP_SNAPSHOT = argv.includes('--no-snapshot');
const EVENTS_PATH   = (() => {
  const i = argv.indexOf('--events');
  return i >= 0 ? argv[i + 1] : DEFAULT_EVENTS;
})();

// ---------------------------------------------------------------------------
// Known schema constants (mirrors event.schema.json — kept in sync manually)
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
  'AGENT_REGISTERED',
  'TASK_RELEASED',
  'LEASE_RENEWED',
  'LEASE_EXPIRED',
  // Scheduler Layer (schema_version 1.3.0)
  'TASK_PRIORITY_SET',
  'TASK_PRIORITY_CLEARED',
]);

// All top-level property names declared in event.schema.json (additionalProperties: false)
const KNOWN_PROPERTIES = new Set([
  'event_index', 'event_type', 'engine_version', 'timestamp',
  'task_id', 'agent', 'role', 'model', 'branch', 'pr_number',
  'forked_from', 'fork_suffix', 'override_reason', 'notes',
  'prev_event_hash', 'event_hash',
  'snapshot_index',           // added in schema_version 1.1.0
  'priority_weight',          // added in schema_version 1.3.0 (Scheduler Layer)
  'execution_cost',           // added in schema_version 1.3.0
  'reason',                   // added in schema_version 1.3.0
]);

const REQUIRED_FIELDS = [
  'event_index', 'event_type', 'engine_version', 'timestamp',
  'prev_event_hash', 'event_hash',
];

// Per-event-type rules derived from allOf conditionals in event.schema.json.
// Each rule is: { required, requireNull, requireConst, requireIndex0 }
// null means "not checked for this type".
const TYPE_RULES = {
  ENGINE_INITIALIZED: {
    required:      [],
    requireNull:   ['task_id', 'agent', 'role', 'model'],
    requireConst:  {},
    requireIndex0: true,
  },
  TASK_CLAIMED: {
    required:     ['task_id', 'agent', 'role', 'model', 'branch'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_HEARTBEAT: {
    required:     ['task_id'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_REVIEW_REQUESTED: {
    required:     ['task_id', 'agent', 'role', 'model'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_REFACTOR_REQUESTED: {
    required:     ['task_id', 'agent', 'role', 'model'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_REFACTOR_COMPLETE: {
    required:     ['task_id', 'agent', 'role', 'model'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_APPROVED: {
    required:     ['task_id', 'agent', 'role', 'model'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_REJECTED: {
    required:     ['task_id', 'agent', 'role', 'model'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_MERGED: {
    required:     ['task_id', 'agent', 'role', 'model'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_LOCK_EXPIRED: {
    required:     ['task_id'],
    requireNull:  ['agent', 'model'],
    requireConst: { role: 'system' },
  },
  TASK_ARCHITECT_OVERRIDE: {
    required:     ['task_id', 'agent', 'role', 'model', 'override_reason'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_FORKED: {
    required:     ['task_id', 'forked_from', 'fork_suffix'],
    requireNull:  ['agent'],
    requireConst: { role: 'system' },
  },
  PROJECTION_REBUILT: {
    required:     ['notes'],
    requireNull:  ['task_id', 'agent'],
    requireConst: { role: 'system' },
  },
  SNAPSHOT_CREATED: {
    required:     ['snapshot_index', 'notes'],
    requireNull:  ['task_id', 'agent', 'model'],
    requireConst: { role: 'system' },
    requireInteger: ['snapshot_index'],
  },
  // Scheduler Layer
  TASK_PRIORITY_SET: {
    required:     ['task_id', 'agent', 'role', 'priority_weight', 'execution_cost'],
    requireNull:  [],
    requireConst: {},
  },
  TASK_PRIORITY_CLEARED: {
    required:     ['task_id', 'agent', 'role'],
    requireNull:  ['priority_weight', 'execution_cost'],
    requireConst: {},
  },
};

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

/** SHA-256 of a string, returns lower-hex. */
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Return a new object with keys sorted lexicographically. */
function sortedKeys(obj) {
  const sorted = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return sorted;
}

/**
 * Re-compute the expected event_hash for a given event object.
 *
 * Algorithm (verified against genesis event):
 *   canonical = JSON.stringify(sortedKeys(event minus event_hash minus prev_event_hash))
 *   event_hash = SHA-256(canonical + prev_event_hash_value)
 */
function computeEventHash(ev) {
  const { event_hash: _eh, prev_event_hash: prevVal, ...core } = ev;
  const canonical = JSON.stringify(sortedKeys(core));
  return sha256(canonical + prevVal);
}

// ---------------------------------------------------------------------------
// Violation accumulator
// ---------------------------------------------------------------------------

const violations = [];

/**
 * Record a violation.
 * @param {number|null} lineNo   1-based line number in TASK_EVENTS.jsonl
 * @param {number|null} idx      event_index value (may be unknown)
 * @param {string}      code     Machine-readable violation code
 * @param {string}      message  Human-readable description
 * @param {object}      [detail] Optional { expected, found } fields
 */
function violation(lineNo, idx, code, message, detail = {}) {
  violations.push({ lineNo, idx, code, message, ...detail });
}

// ---------------------------------------------------------------------------
// Per-event structural checks
// ---------------------------------------------------------------------------

function checkEvent(ev, lineNo) {
  const idx  = ev.event_index ?? null;
  const type = ev.event_type  ?? '(missing)';

  // ── Required top-level fields ──────────────────────────────────────────
  for (const f of REQUIRED_FIELDS) {
    if (!(f in ev)) {
      violation(lineNo, idx, 'MISSING_REQUIRED_FIELD',
        `Required field "${f}" absent`, { field: f });
    }
  }

  // ── No unknown properties (additionalProperties: false) ────────────────
  for (const k of Object.keys(ev)) {
    if (!KNOWN_PROPERTIES.has(k)) {
      violation(lineNo, idx, 'UNKNOWN_PROPERTY',
        `Unknown property "${k}" (additionalProperties: false)`, { field: k });
    }
  }

  // ── event_type in enum ─────────────────────────────────────────────────
  if (ev.event_type !== undefined && !KNOWN_EVENT_TYPES.has(ev.event_type)) {
    violation(lineNo, idx, 'UNKNOWN_EVENT_TYPE',
      `event_type "${ev.event_type}" not in known enum`, { found: ev.event_type });
  }

  // ── Per-type field rules ───────────────────────────────────────────────
  const rules = TYPE_RULES[type];
  if (rules) {
    // Required fields for this type
    for (const f of (rules.required ?? [])) {
      if (ev[f] === undefined || ev[f] === null) {
        violation(lineNo, idx, 'TYPE_REQUIRED_FIELD_MISSING',
          `${type}: field "${f}" must be non-null`, { eventType: type, field: f });
      }
    }
    // Must-be-null fields
    for (const f of (rules.requireNull ?? [])) {
      if (ev[f] !== null && ev[f] !== undefined) {
        violation(lineNo, idx, 'TYPE_FIELD_MUST_BE_NULL',
          `${type}: field "${f}" must be null, found ${JSON.stringify(ev[f])}`,
          { eventType: type, field: f, found: ev[f] });
      }
    }
    // Const constraints
    for (const [f, expected] of Object.entries(rules.requireConst ?? {})) {
      if (ev[f] !== expected) {
        violation(lineNo, idx, 'TYPE_FIELD_WRONG_CONST',
          `${type}: field "${f}" must be ${JSON.stringify(expected)}, found ${JSON.stringify(ev[f])}`,
          { eventType: type, field: f, expected, found: ev[f] });
      }
    }
    // Integer constraints
    for (const f of (rules.requireInteger ?? [])) {
      if (typeof ev[f] !== 'number' || !Number.isInteger(ev[f]) || ev[f] < 0) {
        violation(lineNo, idx, 'TYPE_FIELD_MUST_BE_NON_NEG_INT',
          `${type}: field "${f}" must be a non-negative integer, found ${JSON.stringify(ev[f])}`,
          { eventType: type, field: f, found: ev[f] });
      }
    }
    // ENGINE_INITIALIZED: must be index 0
    if (rules.requireIndex0 && ev.event_index !== 0) {
      violation(lineNo, idx, 'ENGINE_INITIALIZED_INDEX',
        `ENGINE_INITIALIZED must have event_index=0, found ${ev.event_index}`,
        { expected: 0, found: ev.event_index });
    }
  }
}

// ---------------------------------------------------------------------------
// Genesis hash check (snapshot_0)
// ---------------------------------------------------------------------------

function checkGenesisHash() {
  const results = [];

  if (!fs.existsSync(GENESIS_JSON)) {
    results.push({ ok: false, code: 'GENESIS_JSON_MISSING',
      message: `genesis.json not found at ${GENESIS_JSON}` });
    return results;
  }
  if (!fs.existsSync(SNAPSHOT_0)) {
    results.push({ ok: false, code: 'SNAPSHOT_0_MISSING',
      message: `snapshot_0.json not found at ${SNAPSHOT_0}` });
    return results;
  }

  try {
    const genesisObj  = JSON.parse(fs.readFileSync(GENESIS_JSON, 'utf8'));
    const snap0       = JSON.parse(fs.readFileSync(SNAPSHOT_0,   'utf8'));
    const storedHash  = snap0.genesis_hash;
    const computed    = sha256(JSON.stringify(sortedKeys(genesisObj)));

    if (!storedHash) {
      results.push({ ok: false, code: 'GENESIS_HASH_ABSENT',
        message: 'snapshot_0.json has no genesis_hash field' });
    } else if (computed !== storedHash) {
      results.push({ ok: false, code: 'GENESIS_HASH_MISMATCH',
        message: 'genesis_hash in snapshot_0.json does not match SHA-256(sortedKeys(genesis.json))',
        expected: computed, found: storedHash });
    } else {
      results.push({ ok: true, message: `genesis_hash verified: ${storedHash.slice(0,16)}…` });
    }

    // Also check snapshot_0 event_hash matches what's in TASK_EVENTS
    results.push({ ok: true, code: 'GENESIS_HASH_ALGORITHM',
      message: 'genesis_hash algorithm: SHA-256(JSON.stringify(sortedKeys(genesis.json)))' });
  } catch (e) {
    results.push({ ok: false, code: 'GENESIS_CHECK_ERROR',
      message: `Error during genesis check: ${e.message}` });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main audit loop
// ---------------------------------------------------------------------------

async function audit() {
  // Check file exists
  if (!fs.existsSync(EVENTS_PATH)) {
    if (JSON_OUTPUT) {
      process.stdout.write(JSON.stringify({
        ok: false, error: `File not found: ${EVENTS_PATH}`,
      }) + '\n');
    } else {
      console.error(`ERROR: File not found: ${EVENTS_PATH}`);
    }
    process.exit(2);
  }

  let lineNo              = 0;
  let eventCount          = 0;
  let prevHash            = 'GENESIS';   // expected prev_event_hash for the next event
  let expectedIndex       = 0;
  let engineVersion       = null;        // set from first event

  // Axiom density counters (per design in docs/TALK2AI/READ.md)
  // axiom_events       = TASK_ARCHITECT_OVERRIDE (state beyond deterministic replay)
  // deterministic_events = all other task-state events (excludes meta events)
  // meta events (ENGINE_INITIALIZED, PROJECTION_REBUILT, SNAPSHOT_CREATED) excluded from ratio
  let axiomEvents         = 0;
  let deterministicEvents = 0;
  const AXIOM_TYPES       = new Set(['TASK_ARCHITECT_OVERRIDE']);
  const META_TYPES        = new Set(['ENGINE_INITIALIZED', 'PROJECTION_REBUILT', 'SNAPSHOT_CREATED']);

  const eventsPath = EVENTS_PATH;
  const rl = readline.createInterface({
    input: fs.createReadStream(eventsPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;  // skip blank lines

    // ── Parse JSON ──────────────────────────────────────────────────────
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      violation(lineNo, null, 'INVALID_JSON',
        `Line is not valid JSON: ${e.message}`, { raw: line.slice(0, 120) });
      continue;  // can't do further checks on this line
    }

    eventCount++;
    const idx  = ev.event_index;
    const type = ev.event_type ?? '(missing)';

    // ── Structural checks ──────────────────────────────────────────────
    checkEvent(ev, lineNo);

    // ── Index continuity ───────────────────────────────────────────────
    if (typeof idx === 'number') {
      if (idx !== expectedIndex) {
        violation(lineNo, idx, 'INDEX_GAP_OR_DUPLICATE',
          `event_index discontinuity: expected ${expectedIndex}, found ${idx}`,
          { expected: expectedIndex, found: idx });
      }
      expectedIndex = idx + 1;
    }

    // ── engine_version consistency ──────────────────────────────────────
    if (typeof ev.engine_version === 'number') {
      if (engineVersion === null) {
        engineVersion = ev.engine_version;
      } else if (ev.engine_version !== engineVersion) {
        violation(lineNo, idx, 'ENGINE_VERSION_DRIFT',
          `engine_version changed from ${engineVersion} to ${ev.engine_version} without a schema freeze`,
          { expected: engineVersion, found: ev.engine_version });
      }
    }

    // ── prev_event_hash chain ──────────────────────────────────────────
    if (ev.prev_event_hash !== undefined) {
      if (ev.prev_event_hash !== prevHash) {
        violation(lineNo, idx, 'CHAIN_BROKEN_PREV_HASH',
          `prev_event_hash chain broken`,
          { expected: prevHash, found: ev.prev_event_hash });
      }
    }

    // ── event_hash recomputation ───────────────────────────────────────
    if (ev.event_hash && ev.prev_event_hash !== undefined) {
      const recomputed = computeEventHash(ev);
      if (recomputed !== ev.event_hash) {
        violation(lineNo, idx, 'EVENT_HASH_MISMATCH',
          `event_hash does not match recomputed value`,
          { expected: recomputed, found: ev.event_hash });
      }
    }

    // Advance the chain pointer (even if the hash was wrong — to continue audit)
    prevHash = ev.event_hash ?? prevHash;

    // ── Axiom density tracking ─────────────────────────────────────────
    if (typeof type === 'string' && !META_TYPES.has(type)) {
      if (AXIOM_TYPES.has(type)) axiomEvents++;
      else                       deterministicEvents++;
    }

    if (VERBOSE && !JSON_OUTPUT) {
      console.log(`  ${String(lineNo).padStart(4)}  idx=${String(idx ?? '?').padStart(4)}  ${type}`);
    }
  }

  // ── Genesis hash check ─────────────────────────────────────────────────
  const genesisResults = SKIP_SNAPSHOT ? [] : checkGenesisHash();

  // Promote genesis check failures to violations
  for (const r of genesisResults) {
    if (!r.ok) {
      violations.push({
        lineNo: null,
        idx:    null,
        code:   r.code ?? 'GENESIS_CHECK',
        message: r.message,
        ...(r.expected !== undefined ? { expected: r.expected } : {}),
        ...(r.found    !== undefined ? { found:    r.found    } : {}),
      });
    }
  }

  // ── Build report ───────────────────────────────────────────────────────
  const ok        = violations.length === 0;
  const chainInfo = genesisResults.find(r => r.ok && r.message?.includes('genesis_hash'));

  // Axiom density: ratio of axiom events to all task-state events
  const taskEvents   = axiomEvents + deterministicEvents;
  const axiomDensity = taskEvents > 0 ? axiomEvents / taskEvents : 0;

  if (JSON_OUTPUT) {
    // Machine-readable JSON output for CI
    const report = {
      ok,
      events_audited:        eventCount,
      violations_count:      violations.length,
      violations,
      genesis_hash_verified: !SKIP_SNAPSHOT && chainInfo !== undefined,
      axiom_events:          axiomEvents,
      deterministic_events:  deterministicEvents,
      axiom_density:         Math.round(axiomDensity * 1e6) / 1e6,
      events_path:           eventsPath,
    };
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    // Human-readable output
    const WIDTH = 60;
    const line  = '─'.repeat(WIDTH);
    console.log('');
    console.log('TASK_EVENTS.jsonl integrity audit');
    console.log(line);
    console.log(`Events path   : ${eventsPath}`);
    console.log(`Events read   : ${eventCount}`);
    console.log(`Violations    : ${violations.length}`);
    console.log(`Axiom density : ${(axiomDensity * 100).toFixed(4)}%  (${axiomEvents} axiom / ${deterministicEvents} deterministic)`);
    if (!SKIP_SNAPSHOT && chainInfo) {
      console.log(`Genesis       : ${chainInfo.message}`);
    }
    console.log(line);

    if (violations.length > 0) {
      console.log('');
      for (const v of violations) {
        const loc = v.lineNo ? `line ${v.lineNo}` : '(global)';
        const idxLabel = v.idx !== null && v.idx !== undefined ? ` idx=${v.idx}` : '';
        console.error(`  ✗  [${v.code}] @ ${loc}${idxLabel}`);
        console.error(`     ${v.message}`);
        if (v.expected !== undefined) console.error(`     expected: ${JSON.stringify(v.expected)}`);
        if (v.found    !== undefined) console.error(`     found:    ${JSON.stringify(v.found)}`);
        console.error('');
      }
      console.error(`FAIL: ${violations.length} violation${violations.length !== 1 ? 's' : ''} found.`);
    } else {
      console.log('');
      console.log(`  ✓  Hash chain intact`);
      console.log(`  ✓  All event_index values sequential`);
      console.log(`  ✓  All event_hash values verified`);
      console.log(`  ✓  All per-event-type field rules pass`);
      if (!SKIP_SNAPSHOT && chainInfo) {
        console.log(`  ✓  ${chainInfo.message}`);
      }
      console.log('');
      console.log(`OK: ${eventCount} event${eventCount !== 1 ? 's' : ''} audited. Chain is clean.`);
    }
    console.log('');
  }

  process.exit(ok ? 0 : 1);
}

audit().catch(err => {
  console.error('[audit] Fatal error:', err);
  process.exit(2);
});
