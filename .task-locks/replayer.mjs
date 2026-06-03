/**
 * replayer.mjs — Deterministic event log replayer for NOVA 2.5
 *
 * Reads TASK_EVENTS.jsonl from genesis to HEAD and produces registry.json
 * by applying each event against the state machine defined in transitions.yaml.
 *
 * Contract:
 *   pure(genesis.json + transitions.yaml + TASK_EVENTS.jsonl) → registry.json
 *
 *   Same input always produces the same output.
 *   No system clock. No randomness. No side effects during replay.
 *   Time comes exclusively from event.timestamp (injected, never local).
 *
 * Usage:
 *   node .task-locks/replayer.mjs [options]
 *
 * Options:
 *   --dry-run          Print derived registry to stdout, do not write file.
 *   --verify           Re-run replay and diff against current registry.json.
 *                      Exit 0 if identical, exit 1 if stale or different.
 *   --events  <path>   Override path to TASK_EVENTS.jsonl.
 *   --out     <path>   Override output path (default: .task-locks/registry.json).
 *   --verbose          Print each event as it is applied.
 *   --json             Emit JSON output for verify mode (exit 0/1 only otherwise).
 *
 * Exit codes:
 *   0  — success (or registry is current in --verify mode).
 *   1  — replay error or registry is stale (--verify).
 *   2  — usage error or required file missing.
 *
 * No npm dependencies. Pure Node.js ≥ 18 (built-ins only).
 *
 * Boundary: reads .task-locks/* and TASK_EVENTS.jsonl.
 *           Writes only .task-locks/registry.json (unless --dry-run).
 *           NEVER touches TASK_EVENTS.jsonl or snapshots.
 */

import fs   from 'node:fs';
import path from 'node:path';
import rl   from 'node:readline';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(LOCKS_DIR);

const DEFAULT_EVENTS   = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const TRANSITIONS_YAML = path.join(LOCKS_DIR,    'transitions.yaml');
const GENESIS_JSON     = path.join(LOCKS_DIR,    'genesis.json');
const DEFAULT_OUT      = path.join(LOCKS_DIR,    'registry.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv    = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const VERIFY  = argv.includes('--verify');
const VERBOSE = argv.includes('--verbose');
const JSON_OUT = argv.includes('--json');

const EVENTS_PATH = (() => {
  const i = argv.indexOf('--events');
  return i >= 0 ? argv[i + 1] : DEFAULT_EVENTS;
})();
const OUT_PATH = (() => {
  const i = argv.indexOf('--out');
  return i >= 0 ? argv[i + 1] : DEFAULT_OUT;
})();

// ---------------------------------------------------------------------------
// Minimal transitions.yaml parser
//
// Extracts only:
//   transitions[from_state][event_type] = { next_state, lock_effect }
//   terminal_states = [...]
//
// Does NOT parse full YAML. Exploits the known, fixed indentation structure
// of transitions.yaml (2-space indent per level).
// ---------------------------------------------------------------------------

/**
 * @typedef {{ next_state: string, lock_effect: Record<string,string> }} TransitionRule
 * @typedef {{ transitions: Record<string, Record<string, TransitionRule>>, terminal_states: string[] }} TransitionTable
 */

/**
 * @param {string} yamlText
 * @returns {TransitionTable}
 */
function parseTransitionsYaml(yamlText) {
  /** @type {TransitionTable} */
  const result = { transitions: {}, terminal_states: [] };

  const lines = yamlText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  /** @type {'none'|'transitions'|'terminal_states'} */
  let mode = 'none';

  let currentFromState    = null;  // state key at indent=2
  let currentEventType    = null;  // event key at indent=4
  let inLockEffect        = false; // are we inside a lock_effect: block?

  for (const rawLine of lines) {
    // Strip inline comment and trailing whitespace
    const commentIdx = rawLine.indexOf(' #');
    const line = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);

    // ── Top-level keys (indent 0) ──────────────────────────────────────
    if (indent === 0) {
      if (trimmed === 'transitions:')     { mode = 'transitions';     continue; }
      if (trimmed === 'terminal_states:') { mode = 'terminal_states'; continue; }
      mode = 'none';
      continue;
    }

    // ── terminal_states items ─────────────────────────────────────────
    if (mode === 'terminal_states') {
      const m = trimmed.match(/^-\s+(.+)$/);
      if (m) result.terminal_states.push(m[1].trim());
      continue;
    }

    if (mode !== 'transitions') continue;

    // ── transitions section ───────────────────────────────────────────
    // indent=2 → FROM_STATE:
    // indent=4 → EVENT_TYPE:
    // indent=6 → next_state / allowed_roles / lock_effect
    // indent=8 → lock_effect sub-keys

    if (indent === 2) {
      currentFromState = trimmed.replace(/:$/, '').trim();
      if (!result.transitions[currentFromState]) {
        result.transitions[currentFromState] = {};
      }
      currentEventType = null;
      inLockEffect     = false;
      continue;
    }

    if (indent === 4) {
      currentEventType = trimmed.replace(/:$/, '').trim();
      if (currentFromState && currentEventType) {
        result.transitions[currentFromState][currentEventType] = {
          next_state:  null,
          lock_effect: {},
        };
      }
      inLockEffect = false;
      continue;
    }

    if (indent === 6) {
      if (!currentFromState || !currentEventType) continue;
      const m = trimmed.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      const entry = result.transitions[currentFromState][currentEventType];
      if (key === 'next_state')  { entry.next_state  = val.trim(); }
      if (key === 'lock_effect') { inLockEffect       = true;       }
      continue;
    }

    if (indent >= 8 && inLockEffect) {
      if (!currentFromState || !currentEventType) continue;
      const m = trimmed.match(/^(\w+):\s*(.*)$/);
      if (!m) continue;
      const [, key, val] = m;
      const entry = result.transitions[currentFromState][currentEventType];
      // Parse flow-sequence values like [REVIEW] → 'REVIEW'
      // and multi-key list values like "- review_lock" → capture first
      const cleanVal = val.replace(/^\[|\]$/g, '').trim();  // strip [] from flow seqs
      entry.lock_effect[key] = cleanVal;
      continue;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Initial registry builder (from genesis.json)
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   task_id: string,
 *   status: string,
 *   implementation_lock: object|null,
 *   review_lock: object|null,
 *   forked_from: string|null,
 *   fork_suffix: string|null,
 *   pr_number: number|null,
 *   last_event_index: number
 * }} TaskState
 *
 * @typedef {{
 *   schema_version: number,
 *   engine_version: number,
 *   generated_at: string,
 *   event_count: number,
 *   tasks: TaskState[]
 * }} Registry
 */

/**
 * Build the genesis registry from genesis.json.
 * All tasks start as TODO, no locks, last_event_index = 0.
 *
 * @param {{ engine_version: number, tasks: string[] }} genesisConfig
 * @returns {Registry}
 */
function buildInitialRegistry(genesisConfig) {
  return {
    schema_version: 1,
    engine_version: genesisConfig.engine_version ?? 1,
    generated_at:   '2026-06-02T00:00:00Z',  // genesis timestamp
    event_count:    1,                          // ENGINE_INITIALIZED counts
    tasks: genesisConfig.tasks.map(id => ({
      task_id:             id,
      status:              'TODO',
      implementation_lock: null,
      review_lock:         null,
      forked_from:         null,
      fork_suffix:         null,
      pr_number:           null,
      last_event_index:    0,
      priority_weight:     null,  // set by TASK_PRIORITY_SET; null = default (1.0)
      execution_cost:      null,  // set by TASK_PRIORITY_SET; null = default (1)
    })),
  };
}

// ---------------------------------------------------------------------------
// Lock effect application
// ---------------------------------------------------------------------------

/**
 * Build a lock object from an event's agent/model/role/branch fields.
 * @param {{ agent: string, model: string|null, role: string, branch: string|null, timestamp: string }} ev
 * @returns {{ agent: string, model: string|null, role: string, branch: string|null, acquired_at: string }}
 */
function lockFrom(ev) {
  return {
    agent:       ev.agent,
    model:       ev.model       ?? null,
    role:        ev.role        ?? null,
    branch:      ev.branch      ?? null,
    acquired_at: ev.timestamp,
  };
}

/**
 * Apply a lock_effect object (from transitions.yaml) to a task.
 * Implements all lock operations defined in transitions.yaml.
 *
 * @param {TaskState} task
 * @param {object}    ev          the triggering event
 * @param {Record<string,string>} lockEffect
 */
function applyLockEffect(task, ev, lockEffect) {
  const acquire  = lockEffect.acquire;
  const extend   = lockEffect.extend;
  const transfer = lockEffect.transfer;
  const toRole   = lockEffect.to_role;
  const release  = lockEffect.release;
  const restore  = lockEffect.restore;
  // `keep` means "no change" — explicit no-op

  // ── acquire ────────────────────────────────────────────────────────
  if (acquire === 'implementation_lock') {
    task.implementation_lock = lockFrom(ev);
  }
  if (acquire === 'review_lock') {
    task.review_lock = lockFrom(ev);
  }

  // ── extend (heartbeat / review heartbeat) ──────────────────────────
  if (extend === 'implementation_lock' && task.implementation_lock) {
    task.implementation_lock.acquired_at = ev.timestamp;
  }
  if (extend === 'review_lock' && task.review_lock) {
    task.review_lock.acquired_at = ev.timestamp;
  }

  // ── transfer ───────────────────────────────────────────────────────
  // "transfer: implementation_lock, to_role: REVIEW, acquire: review_lock"
  // → keep implementation_lock, set review_lock to reviewing agent
  //
  // "transfer: implementation_lock, to_role: REFACTOR"
  // → reassign implementation_lock to refactor agent
  if (transfer === 'implementation_lock') {
    if (toRole === 'REVIEW') {
      // Review agent acquires review_lock; implementation_lock stays
      task.review_lock = lockFrom(ev);
    } else if (toRole === 'REFACTOR') {
      // Refactor agent takes implementation_lock
      task.implementation_lock = lockFrom(ev);
    }
  }

  // ── release ────────────────────────────────────────────────────────
  if (release) {
    // release can be a single key or a YAML list ("- review_lock\n- implementation_lock")
    // In our parsed form it's a string that may contain comma-separated values
    // or just a single value.
    const releaseList = release.split(/[\s,]+/).filter(Boolean);
    for (const lockName of releaseList) {
      if (lockName === 'implementation_lock') task.implementation_lock = null;
      if (lockName === 'review_lock')         task.review_lock         = null;
    }
  }

  // ── restore ────────────────────────────────────────────────────────
  if (restore === 'implementation_lock') {
    // Restore implementation_lock with the current event's agent/model
    // (the rejecting / overriding agent hands control back to implementation)
    task.implementation_lock = lockFrom(ev);
  }
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

/** System meta-events that never mutate task state (no task_id). */
const META_EVENTS = new Set([
  'ENGINE_INITIALIZED',
  'PROJECTION_REBUILT',
  'SNAPSHOT_CREATED',
  'IDEA_SUBMITTED',
  'ARCHITECTURE_GENERATED',
  'TASK_GRAPH_CREATED',
]);

/**
 * Events that belong to other layers (Agent Runtime, Scheduler) and carry a
 * task_id but do NOT affect the task status or locks in registry.json.
 * The replayer silently advances event_count past these events.
 * Their state is managed by lease-manager.mjs / agent-runtime.mjs instead.
 */
const SILENT_EVENTS = new Set([
  'AGENT_REGISTERED',  // no task_id → also caught by META_EVENTS path, listed here for clarity
  'TASK_RELEASED',     // lease layer only
  'LEASE_RENEWED',     // lease layer only
  'LEASE_EXPIRED',     // lease layer only
  'TASK_BID_SUBMITTED',
  'TASK_BID_WON',
  'TASK_PRICE_DISCOVERED',
]);

/**
 * Apply one event to the registry (mutates in place).
 *
 * @param {Registry}        registry
 * @param {object}          ev
 * @param {TransitionTable} table
 * @param {number}          lineNo   for error messages
 * @returns {{ ok: boolean, error?: string }}
 */
function applyEvent(registry, ev, table, lineNo) {
  const type   = ev.event_type;
  const taskId = ev.task_id;

  // Always advance event_count and generated_at
  registry.event_count    = ev.event_index + 1;
  registry.generated_at   = ev.timestamp;
  registry.engine_version = ev.engine_version ?? registry.engine_version;

  // ── System meta-events — no task mutation ──────────────────────────
  if (META_EVENTS.has(type)) {
    return { ok: true };
  }

  // ── Silent pass-through events (other layers) ─────────────────────
  // These events are handled by lease-manager.mjs / agent-runtime.mjs.
  // The replayer advances event_count but makes no registry change.
  if (SILENT_EVENTS.has(type)) {
    return { ok: true };
  }

  // -- TASK_CREATED - create a new executable task from compiled architecture --
  if (type === 'TASK_CREATED') {
    if (!taskId) return { ok: false, error: `line ${lineNo}: TASK_CREATED has null task_id` };
    const existing = registry.tasks.find(t => t.task_id === taskId);
    if (!existing) {
      registry.tasks.push({
        task_id:             taskId,
        status:              'TODO',
        implementation_lock: null,
        review_lock:         null,
        forked_from:         null,
        fork_suffix:         null,
        pr_number:           null,
        last_event_index:    ev.event_index,
        priority_weight:     ev.priority_weight ?? null,
        execution_cost:      ev.execution_cost ?? null,
        parent_idea:         ev.idea_id ?? ev.parent_idea ?? null,
        architecture_id:     ev.architecture_id ?? null,
        description:         ev.description ?? null,
        module:              ev.module ?? null,
      });
    } else {
      existing.priority_weight  = ev.priority_weight ?? existing.priority_weight ?? null;
      existing.execution_cost   = ev.execution_cost ?? existing.execution_cost ?? null;
      existing.parent_idea      = ev.idea_id ?? ev.parent_idea ?? existing.parent_idea ?? null;
      existing.architecture_id  = ev.architecture_id ?? existing.architecture_id ?? null;
      existing.description      = ev.description ?? existing.description ?? null;
      existing.module           = ev.module ?? existing.module ?? null;
      existing.last_event_index = ev.event_index;
    }
    return { ok: true };
  }

  // ── TASK_PRIORITY_SET — update priority fields (Scheduler Layer) ──
  if (type === 'TASK_PRIORITY_SET') {
    if (!taskId) return { ok: false, error: `line ${lineNo}: TASK_PRIORITY_SET has null task_id` };
    const task = registry.tasks.find(t => t.task_id === taskId);
    if (!task) return { ok: false, error: `line ${lineNo}: TASK_PRIORITY_SET references unknown task "${taskId}"` };
    task.priority_weight  = ev.priority_weight  ?? null;
    task.execution_cost   = ev.execution_cost   ?? null;
    task.last_event_index = ev.event_index;
    return { ok: true };
  }

  // ── TASK_PRIORITY_CLEARED — reset priority fields to defaults ─────
  if (type === 'TASK_PRIORITY_CLEARED') {
    if (!taskId) return { ok: false, error: `line ${lineNo}: TASK_PRIORITY_CLEARED has null task_id` };
    const task = registry.tasks.find(t => t.task_id === taskId);
    if (!task) return { ok: false, error: `line ${lineNo}: TASK_PRIORITY_CLEARED references unknown task "${taskId}"` };
    task.priority_weight  = null;
    task.execution_cost   = null;
    task.last_event_index = ev.event_index;
    return { ok: true };
  }

  // ── TASK_FORKED — create a new task entry ─────────────────────────
  if (type === 'TASK_FORKED') {
    const existing = registry.tasks.find(t => t.task_id === taskId);
    if (!existing) {
      registry.tasks.push({
        task_id:             taskId,
        status:              'TODO',
        implementation_lock: null,
        review_lock:         null,
        forked_from:         ev.forked_from ?? null,
        fork_suffix:         ev.fork_suffix ?? null,
        pr_number:           null,
        last_event_index:    ev.event_index,
        priority_weight:     null,
        execution_cost:      null,
      });
    }
    return { ok: true };
  }

  // ── All other events operate on an existing task ──────────────────
  if (!taskId) {
    return { ok: false, error: `line ${lineNo}: ${type} has null task_id but is not a meta-event` };
  }

  const task = registry.tasks.find(t => t.task_id === taskId);
  if (!task) {
    return { ok: false, error: `line ${lineNo}: ${type} references unknown task "${taskId}"` };
  }

  // ── State transition ───────────────────────────────────────────────
  const fromState   = task.status;
  const stateRules  = table.transitions[fromState];
  if (!stateRules) {
    return { ok: false, error: `line ${lineNo}: no transitions defined from state "${fromState}"` };
  }

  const rule = stateRules[type];
  if (!rule) {
    return {
      ok: false,
      error: `line ${lineNo}: event "${type}" is not a valid transition from state "${fromState}" for task ${taskId}`,
    };
  }

  if (!rule.next_state) {
    return { ok: false, error: `line ${lineNo}: transition ${fromState}→${type} has no next_state` };
  }

  // Apply status transition
  task.status           = rule.next_state;
  task.last_event_index = ev.event_index;

  // Update pr_number if present
  if (typeof ev.pr_number === 'number' && ev.pr_number !== null) {
    task.pr_number = ev.pr_number;
  }

  // Apply lock effect
  if (rule.lock_effect && Object.keys(rule.lock_effect).length > 0) {
    applyLockEffect(task, ev, rule.lock_effect);
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // ── Validate required files ────────────────────────────────────────
  for (const [label, p] of [
    ['genesis.json',     GENESIS_JSON],
    ['transitions.yaml', TRANSITIONS_YAML],
    ['TASK_EVENTS.jsonl', EVENTS_PATH],
  ]) {
    if (!fs.existsSync(p)) {
      console.error(`ERROR: ${label} not found at ${p}`);
      process.exit(2);
    }
  }

  // ── Parse transitions.yaml ─────────────────────────────────────────
  const yamlText = fs.readFileSync(TRANSITIONS_YAML, 'utf8');
  const table    = parseTransitionsYaml(yamlText);

  if (Object.keys(table.transitions).length === 0) {
    console.error('ERROR: No transitions parsed from transitions.yaml — parser error?');
    process.exit(2);
  }

  // ── Build initial registry from genesis ───────────────────────────
  const genesisConfig = JSON.parse(fs.readFileSync(GENESIS_JSON, 'utf8'));
  const registry      = buildInitialRegistry(genesisConfig);

  // ── Replay all events ──────────────────────────────────────────────
  const errors = [];
  let lineNo   = 0;

  const rlInterface = rl.createInterface({
    input:     fs.createReadStream(EVENTS_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rlInterface) {
    lineNo++;
    const line = rawLine.trim();
    if (!line) continue;

    let ev;
    try {
      ev = JSON.parse(line);
    } catch (e) {
      errors.push(`line ${lineNo}: invalid JSON — ${e.message}`);
      continue;
    }

    const result = applyEvent(registry, ev, table, lineNo);

    if (!result.ok) {
      errors.push(result.error);
    } else if (VERBOSE) {
      const pad = (s, n) => String(s).padEnd(n);
      console.log(
        `  ${String(lineNo).padStart(4)}  idx=${String(ev.event_index ?? '?').padStart(4)}` +
        `  ${pad(ev.event_type ?? '?', 30)}` +
        (ev.task_id ? `  task=${ev.task_id}` : '  (meta)')
      );
    }
  }

  // ── Handle replay errors ───────────────────────────────────────────
  if (errors.length > 0) {
    console.error('REPLAY ERRORS:');
    for (const e of errors) console.error(`  ✗ ${e}`);
    console.error(`\nFAIL: ${errors.length} error(s) during replay.`);
    process.exit(1);
  }

  // ── Sort tasks by task_id for stable output ────────────────────────
  registry.tasks.sort((a, b) => a.task_id.localeCompare(b.task_id));

  // ── Serialise in the canonical registry.json format ────────────────
  // Top-level fields are 2-space indented; each task is a single compact line
  // (4-space indent). This matches the original genesis format and keeps
  // git diffs readable: one changed line per affected task.
  // Serialize each task as a single compact-but-spaced line:
  //   { "task_id": "TASK-0001", "status": "TODO", ... }
  // This matches the original genesis format (space after { and before }).
  function serializeTask(t) {
    const pairs = Object.entries(t)
      .map(([k, v]) => `"${k}": ${JSON.stringify(v)}`)
      .join(', ');
    return `{ ${pairs} }`;
  }
  const taskLines = registry.tasks.map(t => '    ' + serializeTask(t)).join(',\n');
  const output =
    `{\n` +
    `  "schema_version": ${registry.schema_version},\n` +
    `  "engine_version": ${registry.engine_version},\n` +
    `  "generated_at": "${registry.generated_at}",\n` +
    `  "event_count": ${registry.event_count},\n` +
    `  "tasks": [\n` +
    taskLines + '\n' +
    `  ]\n` +
    `}\n`;

  // ── Verify mode ────────────────────────────────────────────────────
  if (VERIFY) {
    if (!fs.existsSync(OUT_PATH)) {
      console.error(`FAIL: registry.json not found at ${OUT_PATH}`);
      process.exit(1);
    }
    const existing = fs.readFileSync(OUT_PATH, 'utf8');
    if (existing === output) {
      if (!JSON_OUT) console.log(`OK: registry.json is current (event_count=${registry.event_count}).`);
      process.exit(0);
    } else {
      if (JSON_OUT) {
        // Produce a line-level diff summary
        const existLines  = existing.split('\n');
        const freshLines  = output.split('\n');
        process.stdout.write(JSON.stringify({
          ok:     false,
          reason: 'registry_stale',
          existing_event_count: JSON.parse(existing).event_count,
          current_event_count:  registry.event_count,
        }, null, 2) + '\n');
      } else {
        console.error('FAIL: registry.json is STALE. Run:');
        console.error('  node .task-locks/replayer.mjs');
        // Show which task statuses changed
        try {
          const old = JSON.parse(existing);
          const changed = [];
          for (const t of registry.tasks) {
            const prev = old.tasks.find(x => x.task_id === t.task_id);
            if (!prev) { changed.push(`  + ${t.task_id} (new)`); continue; }
            if (prev.status !== t.status) {
              changed.push(`  ~ ${t.task_id}: ${prev.status} → ${t.status}`);
            }
          }
          if (changed.length) {
            console.error('\nDiff summary (task states):');
            for (const c of changed) console.error(c);
          }
        } catch { /* diff output is best-effort */ }
      }
      process.exit(1);
    }
  }

  // ── Dry-run: print to stdout ───────────────────────────────────────
  if (DRY_RUN) {
    process.stdout.write(output);
    process.exit(0);
  }

  // ── Write registry.json ────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, output, 'utf8');

  if (!JSON_OUT) {
    console.log(
      `OK: ${lineNo} lines → ${registry.event_count} events → registry.json written.` +
      ` Tasks: ${registry.tasks.length} (${table.terminal_states.join(', ')} = terminal).`
    );
  }
  process.exit(0);
}

main().catch(err => {
  console.error('[replayer] Fatal:', err);
  process.exit(2);
});
