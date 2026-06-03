/**
 * integrity-gate.mjs — Single authorized reader for verified data access.
 *
 * Every consumer that needs data from the truth layer goes through this gate.
 * It reads trust-report.json (rebuilding it if stale), verifies the trust
 * status, and only returns the requested resource if trust is "verified" or
 * "degraded" (optionally blocked on degraded with --strict).
 *
 * Data flow (from docs/TALK2AI/READ.md):
 *   dashboard
 *     ↓
 *   integrity-gate.mjs          ← this module
 *     ├── trust-report.json?    ← fresh? → use it
 *     │       stale? → run trust-report.mjs
 *     ├── trust: "verified"?    → serve data
 *     └── trust: "invalid"?     → return error, no data
 *
 * Response shape:
 *   {
 *     "trust":          "verified" | "degraded" | "invalid",
 *     "snapshot":       17,
 *     "event_head":     8421,
 *     "chain_valid":    true,
 *     "axiom_density":  0.00142,
 *     "data":           { ...requested resource... } | null,
 *     "reason":         null | "chain_broken" | "snapshot_divergence" | ...
 *   }
 *
 * Usage:
 *   node .task-locks/integrity-gate.mjs                      # trust + projection
 *   node .task-locks/integrity-gate.mjs --resource registry  # trust + registry
 *   node .task-locks/integrity-gate.mjs --resource head      # trust + HEAD event
 *   node .task-locks/integrity-gate.mjs --resource report    # trust report only
 *   node .task-locks/integrity-gate.mjs --trust-only         # trust status, no data
 *   node .task-locks/integrity-gate.mjs --max-age 30         # max report age (seconds)
 *   node .task-locks/integrity-gate.mjs --refresh            # force rebuild report
 *   node .task-locks/integrity-gate.mjs --strict             # exit 1 on degraded too
 *
 * Exit codes:
 *   0  — trusted (verified, or degraded without --strict)
 *   1  — not trusted (invalid, or degraded with --strict)
 *   2  — fatal error (file not found, parse error)
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads .task-locks/*, TASK_EVENTS.jsonl, core/projection.json,
 *           core/trust-report.json.  May write core/trust-report.json
 *           (by spawning trust-report.mjs).  Never writes to TASK_EVENTS.jsonl.
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
const COMM_CORE    = path.join(PROJECT_ROOT, 'docs', 'communication', 'core');

const REPORT_PATH     = path.join(COMM_CORE,    'trust-report.json');
const PROJECTION_PATH = path.join(COMM_CORE,    'projection.json');
const REGISTRY_PATH   = path.join(LOCKS_DIR,    'registry.json');
const EVENTS_PATH     = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const TRUST_SCRIPT    = path.join(LOCKS_DIR,    'trust-report.mjs');
// Scheduler paths
const SCHED_DIR       = path.join(LOCKS_DIR,    'scheduler');
const SCHED_QUEUE     = path.join(SCHED_DIR,    'queue.json');
const SCHED_REPORT    = path.join(SCHED_DIR,    'scheduler_report.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv      = process.argv.slice(2);
const STRICT    = argv.includes('--strict');
const TRUST_ONLY = argv.includes('--trust-only');
const REFRESH   = argv.includes('--refresh');

const RESOURCE = (() => {
  const i = argv.indexOf('--resource');
  return i >= 0 ? argv[i + 1] : 'projection';
})();

const MAX_AGE_SECS = (() => {
  const i = argv.indexOf('--max-age');
  return i >= 0 ? parseInt(argv[i + 1], 10) || 60 : 60;
})();

// ---------------------------------------------------------------------------
// Trust report freshness check
// ---------------------------------------------------------------------------

/**
 * Returns true if trust-report.json exists and is younger than MAX_AGE_SECS.
 */
function isTrustReportFresh() {
  if (!fs.existsSync(REPORT_PATH)) return false;
  try {
    const stats = fs.statSync(REPORT_PATH);
    const ageSecs = (Date.now() - stats.mtimeMs) / 1000;
    return ageSecs < MAX_AGE_SECS;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// Rebuild trust report (subprocess call to trust-report.mjs)
// ---------------------------------------------------------------------------

function rebuildTrustReport() {
  if (!fs.existsSync(TRUST_SCRIPT)) {
    return { ok: false, error: `trust-report.mjs not found at ${TRUST_SCRIPT}` };
  }
  const result = spawnSync(process.execPath, [TRUST_SCRIPT, '--json'], {
    encoding: 'utf8',
    timeout:  30_000,
  });
  if (result.status !== 0 && result.status !== 1) {
    // status 0 = verified, 1 = invalid/degraded, 2 = fatal
    return { ok: false, error: result.stderr?.trim() || 'trust-report.mjs failed' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Load trust report
// ---------------------------------------------------------------------------

/**
 * @returns {object|null}
 */
function loadTrustReport() {
  if (!fs.existsSync(REPORT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Load the requested resource
// ---------------------------------------------------------------------------

/**
 * @param {string} resource  'projection' | 'registry' | 'head' | 'report'
 * @returns {{ data: object|null, error: string|null }}
 */
function loadResource(resource) {
  try {
    switch (resource) {
      case 'projection': {
        if (!fs.existsSync(PROJECTION_PATH)) {
          return { data: null, error: 'projection.json not found' };
        }
        return { data: JSON.parse(fs.readFileSync(PROJECTION_PATH, 'utf8')), error: null };
      }
      case 'registry': {
        if (!fs.existsSync(REGISTRY_PATH)) {
          return { data: null, error: 'registry.json not found' };
        }
        return { data: JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')), error: null };
      }
      case 'head': {
        if (!fs.existsSync(EVENTS_PATH)) {
          return { data: null, error: 'TASK_EVENTS.jsonl not found' };
        }
        const raw   = fs.readFileSync(EVENTS_PATH, 'utf8');
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) return { data: null, error: 'TASK_EVENTS.jsonl is empty' };
        return { data: JSON.parse(lines[lines.length - 1]), error: null };
      }
      case 'report': {
        // Trust report itself is the resource
        return { data: loadTrustReport(), error: null };
      }
      case 'scheduler': {
        // Scheduler queue + report (snapshot-bound advisory output)
        if (!fs.existsSync(SCHED_QUEUE)) {
          return { data: null, error: 'scheduler/queue.json not found — run: node .task-locks/scheduler.mjs' };
        }
        try {
          const queue  = JSON.parse(fs.readFileSync(SCHED_QUEUE,  'utf8'));
          const report = fs.existsSync(SCHED_REPORT)
            ? JSON.parse(fs.readFileSync(SCHED_REPORT, 'utf8'))
            : null;
          return { data: { queue, report }, error: null };
        } catch (e) {
          return { data: null, error: `Error reading scheduler output: ${e.message}` };
        }
      }
      default:
        return { data: null, error: `Unknown resource: "${resource}"` };
    }
  } catch (e) {
    return { data: null, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // ── Step 1: Ensure trust-report.json is fresh ─────────────────────
  const needsRefresh = REFRESH || !isTrustReportFresh();

  if (needsRefresh) {
    const rebuild = rebuildTrustReport();
    if (!rebuild.ok) {
      const errOut = JSON.stringify({
        trust:       'invalid',
        reason:      'trust_report_build_failed',
        error:       rebuild.error,
        data:        null,
        chain_valid: false,
      });
      process.stdout.write(errOut + '\n');
      process.exit(2);
    }
  }

  // ── Step 2: Load trust report ─────────────────────────────────────
  const report = loadTrustReport();
  if (!report) {
    const errOut = JSON.stringify({
      trust:       'invalid',
      reason:      'trust_report_missing',
      data:        null,
      chain_valid: false,
    });
    process.stdout.write(errOut + '\n');
    process.exit(2);
  }

  // ── Step 3: Trust check ────────────────────────────────────────────
  const trusted =
    report.status === 'verified' ||
    (report.status === 'degraded' && !STRICT);

  if (!trusted) {
    const errOut = JSON.stringify({
      trust:          report.status,
      reason:         report.reason ?? 'trust_check_failed',
      snapshot:       report.snapshot_index,
      event_head:     report.event_count,
      chain_valid:    report.chain_valid,
      axiom_density:  report.axiom_density,
      violations:     report.violations,
      data:           null,
    });
    process.stdout.write(errOut + '\n');
    process.exit(1);
  }

  // ── Step 4: Load requested resource ──────────────────────────────
  let data = null;
  if (!TRUST_ONLY) {
    const loaded = loadResource(RESOURCE);
    if (loaded.error) {
      const errOut = JSON.stringify({
        trust:          report.status,
        reason:         'resource_load_failed',
        resource_error: loaded.error,
        snapshot:       report.snapshot_index,
        event_head:     report.event_count,
        chain_valid:    report.chain_valid,
        axiom_density:  report.axiom_density,
        data:           null,
      });
      process.stdout.write(errOut + '\n');
      process.exit(2);
    }
    data = loaded.data;
  }

  // ── Step 5: Return verified response ──────────────────────────────
  const response = {
    trust:          report.status,
    snapshot:       report.snapshot_index,
    event_head:     report.event_count,
    head_hash:      report.head_hash,
    chain_valid:    report.chain_valid,
    snapshot_valid: report.snapshot_valid,
    registry_valid: report.registry_valid,
    axiom_events:        report.axiom_events,
    deterministic_events: report.deterministic_events,
    axiom_density:  report.axiom_density,
    generated_at:   report.generated_at,
    data,
  };

  process.stdout.write(JSON.stringify(response) + '\n');
  process.exit(0);
}

main();
