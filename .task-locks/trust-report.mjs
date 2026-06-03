/**
 * trust-report.mjs — Generates core/trust-report.json
 *
 * Runs a complete verification of the TASK_EVENTS.jsonl chain, the latest
 * snapshot, and the registry projection.  Writes the result to
 * core/trust-report.json in the communication layer so the Dashboard can
 * read it before rendering any data.
 *
 * Verification steps:
 *   1.  Hash chain audit      — every event_hash recomputed + chain linked
 *   2.  genesis_hash check    — snapshot_0.json genesis_hash matches
 *   3.  Latest snapshot check — snapshot_N.json event_hash matches live chain
 *   4.  Registry currency     — registry.json matches fresh replay (light check)
 *   5.  axiom_density         — ARCHITECT_OVERRIDE events / total task events
 *
 * Output: core/trust-report.json
 *   {
 *     "status":             "verified" | "invalid" | "degraded",
 *     "generated_at":       "ISO",
 *     "chain_valid":        bool,
 *     "genesis_hash_valid": bool,
 *     "snapshot_valid":     bool,
 *     "registry_valid":     bool,
 *     "event_count":        number,
 *     "snapshot_index":     number | null,
 *     "head_hash":          string | null,
 *     "axiom_events":       number,
 *     "deterministic_events": number,
 *     "axiom_density":      number,
 *     "violations":         string[],
 *     "reason":             string | null
 *   }
 *
 * Usage:
 *   node .task-locks/trust-report.mjs
 *   node .task-locks/trust-report.mjs --dry-run   (print, don't write)
 *   node .task-locks/trust-report.mjs --json       (output to stdout too)
 *
 * Exit codes:
 *   0  — verified (or degraded with --allow-degraded)
 *   1  — invalid
 *   2  — file not found / fatal error
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads TASK_EVENTS.jsonl, .task-locks/snapshots/, .task-locks/registry.json
 *           writes core/trust-report.json in the COMM layer.
 */

import crypto from 'node:crypto';
import fs     from 'node:fs';
import path   from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(LOCKS_DIR);
const COMM_CORE    = path.join(PROJECT_ROOT, 'docs', 'communication', 'core');

const EVENTS_PATH   = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const REGISTRY_PATH = path.join(LOCKS_DIR,    'registry.json');
const GENESIS_PATH  = path.join(LOCKS_DIR,    'genesis.json');
const SNAPSHOTS_DIR = path.join(LOCKS_DIR,    'snapshots');
const REPORT_PATH   = path.join(COMM_CORE,    'trust-report.json');

const GENESIS_HASH_CONST =
  '1eb7528ebb64a57fb9b8b567bc9b613911aa3c213e7aaf731ce3fbdc77584eb1';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv     = process.argv.slice(2);
const DRY_RUN  = argv.includes('--dry-run');
const JSON_OUT = argv.includes('--json');
const ALLOW_DEGRADED = argv.includes('--allow-degraded');

// ---------------------------------------------------------------------------
// Hash helpers (identical algorithm to audit.mjs — parity)
// ---------------------------------------------------------------------------

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}
function sortedKeys(obj) {
  const s = {};
  for (const k of Object.keys(obj).sort()) s[k] = obj[k];
  return s;
}
function computeEventHash(ev) {
  const { event_hash: _eh, prev_event_hash: prevVal, ...core } = ev;
  return sha256(JSON.stringify(sortedKeys(core)) + prevVal);
}

// ---------------------------------------------------------------------------
// Axiom event detection
//
// Axiom events = events that extend state beyond deterministic replay.
// Per the Axiom Boundary design (ref: 2026-06-03|02:34:26):
//   is_axiomatic(e) := ¬∃ s_prev, T such that T(s_prev) = s_new
//
// Practical proxy: TASK_ARCHITECT_OVERRIDE is the only event type that
// creates state not derivable from prior events alone.
// SNAPSHOT_CREATED and PROJECTION_REBUILT are system meta-events (excluded
// from the density calculation — they don't affect task state).
// ---------------------------------------------------------------------------

const META_EVENT_TYPES = new Set([
  'ENGINE_INITIALIZED',
  'PROJECTION_REBUILT',
  'SNAPSHOT_CREATED',
]);

const AXIOM_EVENT_TYPES = new Set([
  'TASK_ARCHITECT_OVERRIDE',
]);

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   status:               'verified'|'invalid'|'degraded',
 *   generated_at:         string,
 *   chain_valid:          boolean,
 *   genesis_hash_valid:   boolean,
 *   snapshot_valid:       boolean,
 *   registry_valid:       boolean,
 *   event_count:          number,
 *   snapshot_index:       number|null,
 *   head_hash:            string|null,
 *   axiom_events:         number,
 *   deterministic_events: number,
 *   axiom_density:        number,
 *   violations:           string[],
 *   reason:               string|null
 * }} TrustReport
 */

/** @returns {TrustReport} */
function buildReport() {
  const now        = new Date().toISOString();
  const violations = [];

  /** @type {TrustReport} */
  const report = {
    status:               'verified',
    generated_at:         now,
    chain_valid:          true,
    genesis_hash_valid:   true,
    snapshot_valid:       true,
    registry_valid:       true,
    event_count:          0,
    snapshot_index:       null,
    head_hash:            null,
    axiom_events:         0,
    deterministic_events: 0,
    axiom_density:        0,
    violations:           violations,
    reason:               null,
  };

  // ── 1. Read events ────────────────────────────────────────────────
  if (!fs.existsSync(EVENTS_PATH)) {
    violations.push('TASK_EVENTS.jsonl not found');
    report.chain_valid = false;
    report.status = 'invalid';
    report.reason = 'event_log_missing';
    return report;
  }

  const raw   = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    violations.push('TASK_EVENTS.jsonl is empty');
    report.chain_valid = false;
    report.status = 'invalid';
    report.reason = 'event_log_empty';
    return report;
  }

  // ── 2. Hash chain + axiom density ────────────────────────────────
  /** @type {Array<{event_hash: string, event_type: string, event_index: number}>} */
  const events = [];
  let prevHash = 'GENESIS';
  let chainBroken = false;

  for (let i = 0; i < lines.length; i++) {
    let ev;
    try { ev = JSON.parse(lines[i]); } catch (e) {
      violations.push(`Line ${i + 1}: JSON parse error — ${e.message}`);
      chainBroken = true;
      continue;
    }

    // Index continuity
    if (ev.event_index !== i) {
      violations.push(`Line ${i + 1}: event_index expected ${i}, got ${ev.event_index}`);
      chainBroken = true;
    }

    // prev_event_hash chain
    if (ev.prev_event_hash !== prevHash) {
      violations.push(`Event ${i}: prev_event_hash chain broken`);
      chainBroken = true;
    }

    // event_hash recomputation
    const computed = computeEventHash(ev);
    if (computed !== ev.event_hash) {
      violations.push(`Event ${i}: event_hash MISMATCH — stored=${ev.event_hash?.slice(0,16)}… computed=${computed.slice(0,16)}…`);
      chainBroken = true;
    }

    prevHash = ev.event_hash ?? prevHash;
    events.push({ event_hash: ev.event_hash, event_type: ev.event_type, event_index: i });

    // Axiom density calculation (exclude meta events)
    if (!META_EVENT_TYPES.has(ev.event_type)) {
      if (AXIOM_EVENT_TYPES.has(ev.event_type)) {
        report.axiom_events++;
      } else {
        report.deterministic_events++;
      }
    }
  }

  report.event_count = events.length;
  report.head_hash   = events.length > 0 ? events[events.length - 1].event_hash : null;

  if (chainBroken) {
    report.chain_valid = false;
    report.status      = 'invalid';
    report.reason      = 'chain_broken';
  }

  const taskEvents = report.axiom_events + report.deterministic_events;
  report.axiom_density = taskEvents > 0
    ? Math.round((report.axiom_events / taskEvents) * 1e6) / 1e6
    : 0;

  // ── 3. genesis_hash verification ──────────────────────────────────
  try {
    const snap0Path = path.join(SNAPSHOTS_DIR, 'snapshot_0.json');
    if (fs.existsSync(snap0Path)) {
      const snap0 = JSON.parse(fs.readFileSync(snap0Path, 'utf8'));
      if (snap0.genesis_hash !== GENESIS_HASH_CONST) {
        violations.push(`snapshot_0.json genesis_hash mismatch — possible genesis.json tampering`);
        report.genesis_hash_valid = false;
        report.status = 'invalid';
        report.reason = report.reason ?? 'genesis_hash_mismatch';
      }
    } else {
      violations.push('snapshot_0.json not found — genesis anchor missing');
      report.genesis_hash_valid = false;
      if (report.status === 'verified') report.status = 'degraded';
    }
  } catch (e) {
    violations.push(`genesis_hash check error: ${e.message}`);
    report.genesis_hash_valid = false;
    if (report.status === 'verified') report.status = 'degraded';
  }

  // ── 4. Latest snapshot verification ──────────────────────────────
  try {
    if (!fs.existsSync(SNAPSHOTS_DIR)) {
      violations.push('snapshots/ directory missing');
      report.snapshot_valid = false;
      if (report.status === 'verified') report.status = 'degraded';
    } else {
      const snapFiles = fs.readdirSync(SNAPSHOTS_DIR)
        .filter(f => /^snapshot_\d+\.json$/.test(f))
        .sort((a, b) => {
          const na = parseInt(a.match(/\d+/)?.[0] ?? '0', 10);
          const nb = parseInt(b.match(/\d+/)?.[0] ?? '0', 10);
          return nb - na; // descending
        });

      if (snapFiles.length === 0) {
        violations.push('No snapshot files found in snapshots/');
        report.snapshot_valid = false;
        if (report.status === 'verified') report.status = 'degraded';
      } else {
        const latestSnapFile = snapFiles[0];
        const latestN = parseInt(latestSnapFile.match(/\d+/)?.[0] ?? '0', 10);
        report.snapshot_index = latestN;

        const snap = JSON.parse(
          fs.readFileSync(path.join(SNAPSHOTS_DIR, latestSnapFile), 'utf8')
        );

        // Verify snapshot's event_hash exists in current chain
        const matchingEvent = events.find(e => e.event_hash === snap.event_hash);
        if (!matchingEvent) {
          violations.push(
            `Latest snapshot (${latestSnapFile}) references event_hash ${snap.event_hash?.slice(0,16)}… ` +
            `which is not present in the current chain — snapshot divergence`
          );
          report.snapshot_valid = false;
          report.status = 'invalid';
          report.reason = report.reason ?? 'snapshot_divergence';
        }

        if (snap.genesis_hash && snap.genesis_hash !== GENESIS_HASH_CONST) {
          violations.push(`Snapshot ${latestSnapFile} genesis_hash mismatch`);
          report.snapshot_valid = false;
          report.status = 'invalid';
          report.reason = report.reason ?? 'snapshot_genesis_mismatch';
        }
      }
    }
  } catch (e) {
    violations.push(`Snapshot verification error: ${e.message}`);
    report.snapshot_valid = false;
    if (report.status === 'verified') report.status = 'degraded';
  }

  // ── 5. Registry currency check (lightweight) ──────────────────────
  try {
    if (!fs.existsSync(REGISTRY_PATH)) {
      violations.push('registry.json not found');
      report.registry_valid = false;
      if (report.status === 'verified') report.status = 'degraded';
    } else {
      const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
      if (reg.event_count !== events.length) {
        violations.push(
          `registry.json event_count=${reg.event_count} but chain has ${events.length} events — registry stale`
        );
        report.registry_valid = false;
        if (report.status === 'verified') report.status = 'degraded';
        report.reason = report.reason ?? 'registry_stale';
      }
    }
  } catch (e) {
    violations.push(`Registry check error: ${e.message}`);
    report.registry_valid = false;
    if (report.status === 'verified') report.status = 'degraded';
  }

  // ── Final status ──────────────────────────────────────────────────
  if (violations.length > 0 && report.status === 'verified') {
    report.status = 'degraded';
  }
  if (report.status !== 'invalid' && report.status !== 'degraded') {
    report.reason = null;  // clean
  }

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const report = buildReport();

  const json = JSON.stringify(report, null, 2) + '\n';

  // Write report
  if (!DRY_RUN) {
    fs.mkdirSync(COMM_CORE, { recursive: true });
    fs.writeFileSync(REPORT_PATH, json, 'utf8');
  }

  // Output
  if (JSON_OUT || DRY_RUN) {
    process.stdout.write(json);
  } else {
    const icon = report.status === 'verified' ? '✓' : report.status === 'degraded' ? '⚠' : '✗';
    const statusLabel = report.status.toUpperCase();
    console.log(`\n[trust-report] ${icon}  ${statusLabel}`);
    console.log(`  events:     ${report.event_count}`);
    console.log(`  snapshot:   ${report.snapshot_index ?? 'none'}`);
    console.log(`  head_hash:  ${(report.head_hash ?? '—').slice(0, 16)}…`);
    console.log(`  axiom_density: ${(report.axiom_density * 100).toFixed(4)}%`);
    if (report.violations.length > 0) {
      console.log(`  violations:`);
      for (const v of report.violations) console.log(`    ✗ ${v}`);
    }
    if (!DRY_RUN) console.log(`  written: ${REPORT_PATH}`);
    console.log('');
  }

  const exitCode =
    report.status === 'verified' ? 0
    : report.status === 'degraded' && ALLOW_DEGRADED ? 0
    : 1;

  process.exit(exitCode);
}

main();
