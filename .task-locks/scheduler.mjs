/**
 * scheduler.mjs — Advisory task scheduler for NOVA 2.5
 *
 * Pure function: reads registry.json + dependencies + agent data → writes
 * scheduler/{queue,assignments,runtime_status,scheduler_report}.json.
 *
 * CONTRACT (from scheduler_policy.json + consistency.rules.yaml):
 *   READ ONLY source data.  Never writes to TASK_EVENTS.jsonl.
 *   Never acquires leases.  All outputs are advisory — agents may ignore them
 *   and call lease-manager.mjs directly, but doing so forfeits scheduler
 *   optimisation.
 *
 * Scoring (deterministic, fully replayable):
 *   All decisions are functions of frozen world state only.
 *   No wall-clock time used in scoring or sorting.
 *   See buildQueue() for the exact formula and canonicalization rules.
 *
 * Each queue entry includes a `components` breakdown for full auditability.
 *
 * Usage:
 *   node .task-locks/scheduler.mjs [options]
 *
 * Options:
 *   --dry-run           Print all outputs to stdout; write nothing (test mode).
 *   --projection        Emit queue + world_snapshot to stdout only; write nothing.
 *                       Used by agents in the propose/validate flow to get the
 *                       current queue and world_snapshot_hash without side effects.
 *   --json              Emit a JSON summary of the run to stdout.
 *   --timestamp <ISO>   Override wall-clock "now" for generated_at / runtime_status only.
 *                       Does NOT affect scheduling decisions (scoring is event-index based).
 *   --verbose           Log each task's score breakdown.
 *
 * Exit codes:
 *   0  — success (queue written).
 *   1  — non-fatal warnings (e.g. no agents registered).
 *   2  — fatal error (registry not found, corrupt policy, etc.).
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads .task-locks/*, reads agents/*, reads scheduler/policy+deps.
 *           writes ONLY scheduler/{queue,assignments,runtime_status,scheduler_report}.json.
 *           NEVER touches TASK_EVENTS.jsonl or .task-locks/registry.json.
 */

import crypto   from 'node:crypto';
import fs       from 'node:fs';
import path     from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const LOCKS_DIR    = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.dirname(LOCKS_DIR);
const AGENTS_DIR   = path.join(LOCKS_DIR, 'agents');
const SCHED_DIR    = path.join(LOCKS_DIR, 'scheduler');

const EVENTS_PATH     = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const REGISTRY_PATH   = path.join(LOCKS_DIR,    'registry.json');
const AGENT_REG_PATH  = path.join(AGENTS_DIR,   'registry.json');
const LEASES_PATH     = path.join(AGENTS_DIR,   'leases.json');
const REPUTATION_DIR  = path.join(AGENTS_DIR,   'reputation');
const TRUST_PATH      = path.join(PROJECT_ROOT, 'decision', 'core', 'trust-report.json');
const MARKET_PATH     = path.join(PROJECT_ROOT, 'economy', 'market_state.json');

const POLICY_PATH     = path.join(SCHED_DIR, 'scheduler_policy.json');
const DEPS_PATH       = path.join(SCHED_DIR, 'dependencies.yaml');
const QUEUE_PATH      = path.join(SCHED_DIR, 'queue.json');
const ASSIGN_PATH     = path.join(SCHED_DIR, 'assignments.json');
const RUNTIME_PATH    = path.join(SCHED_DIR, 'runtime_status.json');
const REPORT_PATH     = path.join(SCHED_DIR, 'scheduler_report.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv      = process.argv.slice(2);
const DRY_RUN    = argv.includes('--dry-run');
const JSON_OUT   = argv.includes('--json');
const VERBOSE    = argv.includes('--verbose');
const PROJECTION = argv.includes('--projection');  // pure projection mode: stdout only, no disk writes

const TS_OVERRIDE = (() => {
  const i = argv.indexOf('--timestamp');
  return i >= 0 ? argv[i + 1] : null;
})();

// ---------------------------------------------------------------------------
// Safe readers
// ---------------------------------------------------------------------------

function readJson(p) {
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

/** List all .json files in a directory (excluding .gitkeep). */
function listJsonFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep')
    .map(f => readJson(path.join(dir, f)))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Minimal dependencies.yaml parser
//
// Parses:
//   dependencies:
//     TASK-XXXX:
//       depends_on:
//         - TASK-YYYY
// ---------------------------------------------------------------------------

/**
 * @typedef {{ [taskId: string]: string[] }} DependencyMap
 *   Maps taskId → list of taskIds it depends on.
 */

/** @returns {DependencyMap} */
function parseDependencies(yamlText) {
  /** @type {DependencyMap} */
  const result = {};
  const lines  = yamlText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

  let inDependencies = false;
  let currentTask    = null;
  let inDependsOn    = false;

  for (const rawLine of lines) {
    const commentIdx = rawLine.indexOf(' #');
    const line    = (commentIdx >= 0 ? rawLine.slice(0, commentIdx) : rawLine).trimEnd();
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const indent = line.search(/\S/);

    if (indent === 0) {
      inDependencies = trimmed === 'dependencies:';
      currentTask    = null;
      inDependsOn    = false;
      continue;
    }

    if (!inDependencies) continue;

    if (indent === 2) {
      // Task ID key: "  TASK-XXXX:"
      const m = trimmed.match(/^(TASK-\S+):$/);
      if (m) {
        currentTask = m[1];
        result[currentTask] = result[currentTask] ?? [];
        inDependsOn = false;
      }
      continue;
    }

    if (indent === 4 && trimmed === 'depends_on:') {
      inDependsOn = true;
      continue;
    }

    if (indent === 6 && inDependsOn && currentTask) {
      const m = trimmed.match(/^-\s+(TASK-\S+)$/);
      if (m) result[currentTask].push(m[1]);
      continue;
    }
  }

  return result;
}

/**
 * Compute reverse dependency map: taskId → [tasks that depend ON it].
 * dependency_pressure of task T = reverse_deps[T].filter(not terminal).length
 *
 * @param {DependencyMap} deps
 * @returns {{ [taskId: string]: string[] }}
 */
function buildReverseDeps(deps) {
  /** @type {{ [taskId: string]: string[] }} */
  const reverse = {};
  for (const [dependant, prereqs] of Object.entries(deps)) {
    for (const prereq of prereqs) {
      reverse[prereq] = reverse[prereq] ?? [];
      reverse[prereq].push(dependant);
    }
  }
  return reverse;
}

// ---------------------------------------------------------------------------
// Event log scanner
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   headHash:              string | null,
 *   headTimestamp:         string | null,
 *   headEventIndex:        number,
 *   taskLastTimestamps:    Map<string, string>,
 *   latestSnapshotIndex:   number | null
 * }} EventScanResult
 */

/** @returns {Promise<EventScanResult>} */
async function scanEventLog() {
  /** @type {EventScanResult} */
  const result = {
    headHash:            null,
    headTimestamp:       null,
    headEventIndex:      0,
    taskLastTimestamps:  new Map(),
    latestSnapshotIndex: null,
  };

  if (!fs.existsSync(EVENTS_PATH)) return result;

  const iface = readline.createInterface({
    input:     fs.createReadStream(EVENTS_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of iface) {
    const line = rawLine.trim();
    if (!line) continue;

    let ev;
    try { ev = JSON.parse(line); } catch { continue; }

    // Track HEAD
    if (ev.event_hash)  result.headHash       = ev.event_hash;
    if (ev.timestamp)   result.headTimestamp  = ev.timestamp;
    if (typeof ev.event_index === 'number') result.headEventIndex = ev.event_index;

    // Track last-event timestamp per task
    if (ev.task_id && ev.timestamp) {
      result.taskLastTimestamps.set(ev.task_id, ev.timestamp);
    }

    // Track latest snapshot index
    if (ev.event_type === 'SNAPSHOT_CREATED' && ev.snapshot_index != null) {
      result.latestSnapshotIndex = ev.snapshot_index;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// World Snapshot — deterministic fingerprint of all scheduler inputs
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   event_head_hash:     string | null,
 *   head_event_index:    number,
 *   registry_hash:       string,
 *   agent_registry_hash: string,
 *   leases_hash:         string,
 *   policy_hash:         string,
 *   market_hash:         string,
 *   world_snapshot_hash: string
 * }} WorldSnapshot
 */

/**
 * SHA-256 of a file's raw bytes.  Returns a 64-char hex string.
 * Returns a deterministic "empty" hash if the file does not exist.
 *
 * @param {string} filePath
 * @returns {string}
 */
function hashFile(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
  } catch {
    // File missing — use hash of empty string so the snapshot is still valid
    return crypto.createHash('sha256').update('', 'utf8').digest('hex');
  }
}

/**
 * Compute the WorldSnapshot from the current file state and event log scan.
 *
 * The `world_snapshot_hash` is the authoritative single-value fingerprint
 * of the complete scheduler input state.  The integrity-bridge re-computes
 * this hash before committing a lease and rejects the proposal if it differs.
 *
 * Canonical input string:
 *   event_head_hash:head_event_index:registry_hash:agent_registry_hash:leases_hash:policy_hash:market_hash
 *
 * @param {EventScanResult} scan
 * @returns {WorldSnapshot}
 */
function computeWorldSnapshot(scan) {
  const eventHeadHash     = scan.headHash ?? '';
  const headEventIndex    = scan.headEventIndex ?? 0;
  const registryHash      = hashFile(REGISTRY_PATH);
  const agentRegistryHash = hashFile(AGENT_REG_PATH);
  const leasesHash        = hashFile(LEASES_PATH);
  const policyHash        = hashFile(POLICY_PATH);
  const marketHash        = hashFile(MARKET_PATH);

  // Canonical concatenation — colon-separated, deterministic ordering
  const canonical = [
    eventHeadHash,
    String(headEventIndex),
    registryHash,
    agentRegistryHash,
    leasesHash,
    policyHash,
    marketHash,
  ].join(':');

  const worldSnapshotHash = crypto
    .createHash('sha256')
    .update(canonical, 'utf8')
    .digest('hex');

  return {
    event_head_hash:     eventHeadHash  || null,
    head_event_index:    headEventIndex,
    registry_hash:       registryHash,
    agent_registry_hash: agentRegistryHash,
    leases_hash:         leasesHash,
    policy_hash:         policyHash,
    market_hash:         marketHash,
    world_snapshot_hash: worldSnapshotHash,
  };
}

// ---------------------------------------------------------------------------
// Score components
// ---------------------------------------------------------------------------

/**
 * urgency_norm = min(1.0, event_distance / halflife_events)
 *
 * Deterministic: based on event index distance, NOT wall-clock time.
 * A task that was last touched 100 events ago with halflife=100 reaches U=1.0.
 *
 * @param {number} taskLastEventIndex   task.last_event_index
 * @param {number} headEventIndex       current HEAD event_index
 * @param {number} halflifeEvents       urgency_halflife_events from policy
 * @returns {number} ∈ [0, 1]
 */
function computeUrgencyNorm(taskLastEventIndex, headEventIndex, halflifeEvents) {
  if (halflifeEvents <= 0) return 0;
  const distance = Math.max(0, headEventIndex - taskLastEventIndex);
  return Math.min(1.0, distance / halflifeEvents);
}

/**
 * dep_norm = min(1.0, blocked_count / max_dep_pressure)
 * @param {number} blockedCount     direct tasks blocked by this task
 * @param {number} maxDepPressure   from policy (default 5)
 * @returns {number} ∈ [0, 1]
 */
function computeDepNorm(blockedCount, maxDepPressure) {
  if (maxDepPressure <= 0) return 0;
  return Math.min(1.0, blockedCount / maxDepPressure);
}

/**
 * cost_inv_norm = log(2) / log(execution_cost + 1)
 *
 * Logarithmic normalization prevents extreme suppression of high-cost tasks.
 * At cost=1 → 1.0 (cheapest, best).  At cost=21 → ≈0.221.
 *
 * @param {number} executionCost  Fibonacci cost (1-21)
 * @returns {number} ∈ (0, 1]
 */
const LOG2 = Math.log(2);
function computeCostInvNorm(executionCost) {
  const c = Math.max(1, executionCost);
  return LOG2 / Math.log(c + 1);
}

/**
 * Map priority_weight to discrete tier multiplier.
 *
 * The tier multiplier is the final multiplicative factor applied to the
 * within-group score.  Exponential separation ensures that P3 tasks are
 * always scheduled ahead of P2, regardless of urgency/trust differences.
 *
 * Tiers:
 *   priority_weight ≤ 1.0  → P0 multiplier=1
 *   priority_weight ≤ 2.0  → P1 multiplier=2
 *   priority_weight ≤ 4.0  → P2 multiplier=4
 *   priority_weight  > 4.0 → P3 multiplier=8
 *
 * @param {number|null} weight
 * @param {object}      policy
 * @returns {{ tier: string, multiplier: number }}
 */
function priorityTier(weight, policy) {
  const tiers    = policy.score_parameters?.priority_tiers;
  const w        = weight ?? 1.0;
  if (tiers) {
    // Sort tier definitions by max_weight ascending, pick first where w ≤ max
    const sorted = Object.entries(tiers)
      .sort(([, a], [, b]) => a.max_weight - b.max_weight);
    for (const [name, def] of sorted) {
      if (w <= def.max_weight) return { tier: name, multiplier: def.multiplier };
    }
    // Fallback: last tier
    const last = sorted[sorted.length - 1];
    return last ? { tier: last[0], multiplier: last[1].multiplier } : { tier: 'P0', multiplier: 1 };
  }
  // Default tiers if policy not available
  if (w <= 1.0) return { tier: 'P0', multiplier: 1 };
  if (w <= 2.0) return { tier: 'P1', multiplier: 2 };
  if (w <= 4.0) return { tier: 'P2', multiplier: 4 };
  return { tier: 'P3', multiplier: 8 };
}

/**
 * Compute fit_score for a single agent:
 *   fit_score = reputation_score × availability_factor
 *
 * availability_factor:
 *   1.0 — no active leases
 *   0.7 — active lease in a different role_category
 *   0.4 — active lease in the same role_category (busy with same type of work)
 *
 * @param {object}   agent
 * @param {string}   neededRole
 * @param {object[]} activeLeases
 * @param {Map<string,number>} reputationMap  agent_id → score
 * @returns {number}
 */
function computeFitScore(agent, neededRole, activeLeases, reputationMap) {
  const repScore = reputationMap.get(agent.agent_id) ?? 1.0;

  const neededCategory = (neededRole === 'REVIEW' || neededRole === 'ARCHITECT')
    ? 'review_lock'
    : 'implementation_lock';

  const agentLeases = activeLeases.filter(l => l.agent_id === agent.agent_id);

  let availabilityFactor = 1.0;
  if (agentLeases.length > 0) {
    const sameCategory = agentLeases.some(l => l.role_category === neededCategory);
    availabilityFactor = sameCategory ? 0.4 : 0.7;
  }

  return Math.round(repScore * availabilityFactor * 1e6) / 1e6;
}

/**
 * Rank all capable agents for a task by fit_score descending.
 *
 * @param {string}   neededRole
 * @param {object[]} agents          from agents/registry.json
 * @param {object[]} activeLeases    ACTIVE leases from agents/leases.json
 * @param {Map<string,number>} reputationMap
 * @returns {Array<{ agent_id: string, fit_score: number }>}
 */
function rankCandidates(neededRole, agents, activeLeases, reputationMap) {
  const capable = agents.filter(a =>
    a.status === 'ACTIVE' &&
    Array.isArray(a.capabilities) &&
    a.capabilities.includes(neededRole)
  );

  return capable
    .map(a => ({
      agent_id:  a.agent_id,
      fit_score: computeFitScore(a, neededRole, activeLeases, reputationMap),
    }))
    .sort((a, b) => b.fit_score - a.fit_score);
}

// ---------------------------------------------------------------------------
// Queue builder
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   priority_multiplier: number,
 *   urgency_norm: number,
 *   dep_norm: number,
 *   trust_norm: number,
 *   cost_inv_norm: number,
 *   within_score_fp: number,
 *   final_score_fp: number
 * }} ScoreComponents
 */

/**
 * Build the scored queue for all schedulable tasks.
 *
 * Scoring algorithm (fully deterministic — no wall-clock, no floats without
 * explicit rounding, canonical total ordering):
 *
 *   urgency_norm    = min(1.0, (head_idx - task.last_event_index) / halflife_events)
 *   dep_norm        = min(1.0, blocked_count / max_dep_pressure)
 *   trust_norm      = trust_ceiling  (∈ [0,1])
 *   cost_inv_norm   = log(2) / log(execution_cost + 1)  (∈ (0,1])
 *
 *   within_score_fp = floor(SCALE × (
 *     W_U × urgency_norm + W_D × dep_norm + W_T × trust_norm + W_C × cost_inv_norm
 *   ))
 *   final_score_fp  = within_score_fp × priority_multiplier
 *
 * Sort key: priority_multiplier DESC → final_score_fp DESC
 *           → task.last_event_index ASC → task_id ASC
 *
 * @param {object}   policy
 * @param {object[]} tasks
 * @param {{ [k:string]: string[] }} reverseDeps
 * @param {object[]} agents
 * @param {object[]} activeLeases
 * @param {Map<string,number>} reputationMap
 * @param {number}   headEventIndex   current HEAD event_index from event log scan
 * @param {object|null} marketState    bid-market projection, advisory but deterministic
 * @returns {object[]}  queue entries, sorted deterministically
 */
function buildQueue(
  policy, tasks, reverseDeps,
  agents, activeLeases, reputationMap,
  headEventIndex,
  marketState = null
) {
  const { schedulable_states, terminal_states: terminalArr } = policy;
  const terminalStates = new Set(terminalArr);

  const sp             = policy.score_parameters ?? {};
  const halflifeEvents = sp.urgency_halflife_events     ?? 100;
  const maxDepPressure = sp.urgency_max_dep_pressure    ?? 5;
  const wU             = sp.score_weights?.urgency              ?? 0.35;
  const wD             = sp.score_weights?.dependency_pressure  ?? 0.25;
  const wT             = sp.score_weights?.trust                ?? 0.25;
  const wC             = sp.score_weights?.complexity_inverse   ?? 0.15;
  const SCALE          = sp.fixed_point_scale ?? 1_000_000;
  const defaultCost    = sp.default_execution_cost ?? 1;

  /** @type {object[]} */
  const entries = [];

  for (const [state, neededRole] of Object.entries(schedulable_states)) {
    const tasksInState = tasks.filter(t => t.status === state);

    for (const task of tasksInState) {
      // ── Priority tier ────────────────────────────────────────────
      const { tier, multiplier } = priorityTier(task.priority_weight, policy);

      // ── Score components (all normalized to [0,1]) ───────────────
      const executionCost  = task.execution_cost ?? defaultCost;
      const marketTask     = marketState?.tasks?.[task.task_id] ?? null;
      const marketPressure = marketTask?.market_pressure_multiplier ?? 1;
      const effectiveCost  = Math.max(1, executionCost * marketPressure);
      const urgencyNorm    = computeUrgencyNorm(task.last_event_index ?? 0, headEventIndex, halflifeEvents);
      const blockedCount   = (reverseDeps[task.task_id] ?? [])
        .filter(d => { const s = tasks.find(t => t.task_id === d)?.status; return s && !terminalStates.has(s); })
        .length;
      const depNorm        = computeDepNorm(blockedCount, maxDepPressure);
      const candidates     = rankCandidates(neededRole, agents, activeLeases, reputationMap);
      const trustNorm      = candidates.length > 0 ? candidates[0].fit_score : 0;
      const costInvNorm    = computeCostInvNorm(effectiveCost);

      // ── Fixed-point score ────────────────────────────────────────
      const withinScoreFp = Math.floor(
        SCALE * (wU * urgencyNorm + wD * depNorm + wT * trustNorm + wC * costInvNorm)
      );
      const finalScoreFp = withinScoreFp * multiplier;

      // ── Components record (for auditability + integrity-bridge) ──
      /** @type {ScoreComponents} */
      const components = {
        priority_multiplier: multiplier,
        priority_tier:       tier,
        urgency_norm:        Math.round(urgencyNorm  * 1e6) / 1e6,
        dep_norm:            Math.round(depNorm      * 1e6) / 1e6,
        trust_norm:          Math.round(trustNorm    * 1e6) / 1e6,
        cost_inv_norm:       Math.round(costInvNorm  * 1e6) / 1e6,
        execution_cost:      executionCost,
        effective_execution_cost: Math.round(effectiveCost * 1e6) / 1e6,
        market_pressure_multiplier: Math.round(marketPressure * 1e6) / 1e6,
        winning_bid_id:      marketTask?.winning_bid?.bid_id ?? null,
        within_score_fp:     withinScoreFp,
        final_score_fp:      finalScoreFp,
      };

      entries.push({
        task_id:              task.task_id,
        state,
        needed_role:          neededRole,
        last_event_index:     task.last_event_index ?? 0,
        score:                finalScoreFp,          // canonical integer for comparisons
        score_display:        finalScoreFp / SCALE,  // float for human display only
        components,
        candidates,
        no_candidates_reason: candidates.length === 0
          ? `no_agents_with_${neededRole}_capability`
          : null,
      });

      if (VERBOSE) {
        console.log(
          `  ${task.task_id}  state=${state}  tier=${tier}(×${multiplier})` +
          `  final_fp=${finalScoreFp}  U=${urgencyNorm.toFixed(3)}` +
          `  D=${depNorm.toFixed(3)}  T=${trustNorm.toFixed(3)}  C=${costInvNorm.toFixed(3)}`
        );
      }
    }
  }

  // ── Canonical sort (total ordering — fully deterministic) ────────
  // priority_multiplier DESC → final_score_fp DESC → last_event_index ASC → task_id ASC
  entries.sort((a, b) => {
    const aMult = a.components.priority_multiplier;
    const bMult = b.components.priority_multiplier;
    if (bMult !== aMult) return bMult - aMult;
    if (b.score !== a.score) return b.score - a.score;
    if (a.last_event_index !== b.last_event_index) return a.last_event_index - b.last_event_index;
    return a.task_id.localeCompare(b.task_id);
  });

  return entries;
}

// ---------------------------------------------------------------------------
// Assignments builder (distilled from queue)
// ---------------------------------------------------------------------------

/**
 * @param {object[]} queue
 * @param {number}   registryEventCount
 * @param {number}   schedulerSeq
 * @param {string}   nowIso
 * @returns {object}
 */
function buildAssignments(queue, registryEventCount, schedulerSeq, nowIso) {
  const assignments = queue.map(entry => ({
    task_id:                entry.task_id,
    needed_role:            entry.needed_role,
    score:                  entry.score,
    recommended_agent:      entry.candidates[0]?.agent_id       ?? null,
    recommended_fit_score:  entry.candidates[0]?.fit_score      ?? null,
    fallback_candidates:    entry.candidates.slice(1),
  }));

  return {
    schema_version:       '1.0.0',
    scheduler_sequence:   schedulerSeq,
    registry_event_count: registryEventCount,
    generated_at:         nowIso,
    assignments,
  };
}

// ---------------------------------------------------------------------------
// Runtime status builder (monitoring view)
// ---------------------------------------------------------------------------

/**
 * @param {object}   policy
 * @param {object[]} tasks
 * @param {object[]} activeLeases
 * @param {Date}     now
 * @param {number}   registryEventCount
 * @param {number}   schedulerSeq
 * @param {string}   nowIso
 * @returns {object}
 */
function buildRuntimeStatus(policy, tasks, activeLeases, now, registryEventCount, schedulerSeq, nowIso) {
  const monitoringStates = new Set(policy.monitoring_states ?? []);

  // TTL constants (from transitions.yaml values, mirrored here)
  const TTL_IMPLEMENTATION_S = 21600;
  const TTL_REFACTOR_S       =  7200;

  const monitored = tasks
    .filter(t => monitoringStates.has(t.status))
    .map(task => {
      // Find the ACTIVE implementation_lock lease for this task
      const lease = activeLeases.find(
        l => l.task_id === task.task_id &&
             l.role_category === 'implementation_lock' &&
             l.status === 'ACTIVE'
      );

      // Derive agent from lease or from registry lock
      const assignedAgent =
        lease?.agent_id ??
        task.implementation_lock?.agent ??
        null;

      // TTL for this role
      const ttlS = (task.status === 'REFACTOR_CLAIMED') ? TTL_REFACTOR_S : TTL_IMPLEMENTATION_S;

      // Last heartbeat: prefer lease.last_heartbeat, fall back to lock.acquired_at
      const lastHb =
        lease?.last_heartbeat ??
        task.implementation_lock?.acquired_at ??
        null;

      let heartbeatAgeS  = null;
      let expiresInS     = null;
      let leaseHealth    = 0;

      if (lastHb) {
        heartbeatAgeS = Math.max(0, (now.getTime() - new Date(lastHb).getTime()) / 1000);
        leaseHealth   = Math.max(0, 1 - heartbeatAgeS / ttlS);
      }

      if (lease?.expires_at) {
        expiresInS = (new Date(lease.expires_at).getTime() - now.getTime()) / 1000;
      }

      return {
        task_id:                task.task_id,
        state:                  task.status,
        assigned_agent:         assignedAgent,
        lease_health:           Math.round(leaseHealth   * 1e6) / 1e6,
        heartbeat_age_seconds:  heartbeatAgeS !== null
          ? Math.round(heartbeatAgeS * 10) / 10
          : null,
        expires_in_seconds:     expiresInS !== null
          ? Math.round(expiresInS)
          : null,
        ttl_seconds:            ttlS,
      };
    })
    // Least healthy first (surface critical tasks at top)
    .sort((a, b) => a.lease_health - b.lease_health);

  return {
    schema_version:       '1.0.0',
    scheduler_sequence:   schedulerSeq,
    registry_event_count: registryEventCount,
    generated_at:         nowIso,
    monitored,
  };
}

// ---------------------------------------------------------------------------
// Atomic writer helper
// ---------------------------------------------------------------------------

function writeAtomic(filePath, data) {
  const json = JSON.stringify(data, null, 2) + '\n';
  const tmp  = filePath + '.tmp';
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const nowIso = TS_OVERRIDE ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const now    = new Date(nowIso);

  // ── Trust gate ────────────────────────────────────────────────────
  // Scheduler reads registry.json — if the underlying event chain is broken
  // the registry is untrustworthy and scheduling MUST NOT proceed.
  //
  // Gate rules:
  //   trust_status == 'invalid'  → chain broken or snapshot divergence → EXIT 2
  //   trust_status == 'corrupt'  → consistency-checker CORRUPT → EXIT 2
  //   trust_status == 'degraded' → soft warnings → proceed with warning
  //   trust_status == null       → trust-report.json absent → proceed with warning
  const earlyTrust = readJson(TRUST_PATH);
  if (earlyTrust?.status === 'invalid') {
    const msg = `Trust gate blocked: trust_status=invalid (chain broken or snapshot divergence). Run: node .task-locks/audit.mjs`;
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg, trust: 'invalid' }) + '\n');
    else          console.error(`FAIL: ${msg}`);
    process.exit(2);
  }

  // ── Required files check ─────────────────────────────────────────
  if (!fs.existsSync(REGISTRY_PATH)) {
    const msg = `registry.json not found at ${REGISTRY_PATH}. Run: node .task-locks/replayer.mjs`;
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else          console.error(`FAIL: ${msg}`);
    process.exit(2);
  }

  if (!fs.existsSync(POLICY_PATH)) {
    const msg = `scheduler_policy.json not found at ${POLICY_PATH}`;
    if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    else          console.error(`FAIL: ${msg}`);
    process.exit(2);
  }

  // ── Load all inputs ───────────────────────────────────────────────
  const policy      = readJson(POLICY_PATH);
  const registry    = readJson(REGISTRY_PATH);
  const agentReg    = readJson(AGENT_REG_PATH)  ?? { agents: [] };
  const leaseStore  = readJson(LEASES_PATH)     ?? { leases: [] };
  const prevReport  = readJson(REPORT_PATH)     ?? { scheduler_sequence: 0 };
  const trustReport = readJson(TRUST_PATH);
  const marketState = readJson(MARKET_PATH)      ?? { tasks: {} };

  const tasks        = registry.tasks       ?? [];
  const agents       = agentReg.agents      ?? [];
  const activeLeases = (leaseStore.leases   ?? []).filter(l => l.status === 'ACTIVE');

  // ── Dependency graph ─────────────────────────────────────────────
  const depsYaml   = fs.existsSync(DEPS_PATH)
    ? fs.readFileSync(DEPS_PATH, 'utf8')
    : 'dependencies: {}';
  const deps       = parseDependencies(depsYaml);
  const reverseDeps = buildReverseDeps(deps);

  // ── Reputation map ───────────────────────────────────────────────
  const reputationFiles = listJsonFiles(REPUTATION_DIR);
  /** @type {Map<string, number>} */
  const reputationMap = new Map(
    reputationFiles
      .filter(r => r.agent_id && typeof r.score === 'number')
      .map(r => [r.agent_id, r.score])
  );

  // ── Event log scan ────────────────────────────────────────────────
  const scan = await scanEventLog();

  // ── World Snapshot (frozen input fingerprint) ─────────────────────
  // Computed AFTER the scan so headHash/headEventIndex are available.
  // Must be computed before calling buildQueue to ensure it reflects
  // exactly the state used for scoring.
  const worldSnapshot = computeWorldSnapshot(scan);

  // ── Scheduler sequence ────────────────────────────────────────────
  const schedulerSeq = (prevReport.scheduler_sequence ?? 0) + 1;

  // ── Build queue ───────────────────────────────────────────────────
  if (VERBOSE && !JSON_OUT) {
    console.log(`\n[scheduler] sequence=${schedulerSeq}  event_count=${registry.event_count}  agents=${agents.length}  now=${nowIso}`);
    console.log('[scheduler] Task scores:');
  }

  const queue = buildQueue(
    policy, tasks, reverseDeps,
    agents, activeLeases, reputationMap,
    scan.headEventIndex ?? 0,
    marketState
  );

  // ── Build assignments ─────────────────────────────────────────────
  const assignmentsDoc = buildAssignments(
    queue, registry.event_count, schedulerSeq, nowIso
  );

  // ── Build runtime status ──────────────────────────────────────────
  const runtimeDoc = buildRuntimeStatus(
    policy, tasks, activeLeases, now,
    registry.event_count, schedulerSeq, nowIso
  );

  // ── Build queue document ──────────────────────────────────────────
  const queueDoc = {
    schema_version:          '1.0.0',
    scheduler_sequence:       schedulerSeq,
    registry_event_count:     registry.event_count,
    event_head_hash:          scan.headHash,
    registry_snapshot_index:  scan.latestSnapshotIndex,
    world_snapshot:           worldSnapshot,
    generated_at:             nowIso,
    queue,
  };

  // ── Count excluded and terminal tasks ────────────────────────────
  const excludedStates = new Set(policy.excluded_states  ?? []);
  const terminalStates  = new Set(policy.terminal_states ?? []);
  const monitoringStates = new Set(policy.monitoring_states ?? []);
  const schedulableStates = new Set(Object.keys(policy.schedulable_states ?? {}));

  const excludedCount = tasks.filter(t => excludedStates.has(t.status)).length;
  const terminalCount = tasks.filter(t => terminalStates.has(t.status)).length;

  // ── Build scheduler report ─────────────────────────────────────────
  const warnings = [];
  if (agents.length === 0) warnings.push('no_agents_registered');
  if (queue.some(e => e.candidates.length === 0)) warnings.push('some_tasks_have_no_candidates');
  if (trustReport?.status === 'degraded')  warnings.push('trust_degraded');
  if (trustReport === null)                warnings.push('trust_report_missing');

  const reportDoc = {
    schema_version:          '1.0.0',
    scheduler_sequence:       schedulerSeq,
    registry_event_count:     registry.event_count,
    event_head_hash:          scan.headHash,
    registry_snapshot_index:  scan.latestSnapshotIndex,
    world_snapshot:           worldSnapshot,
    generated_at:             nowIso,
    queue_count:              queue.length,
    monitored_count:          runtimeDoc.monitored.length,
    excluded_count:           excludedCount,
    terminal_count:           terminalCount,
    trust_status:             trustReport?.status ?? null,
    warnings,
    errors: [],
  };

  // ── Write outputs ─────────────────────────────────────────────────
  if (DRY_RUN || PROJECTION) {
    // DRY_RUN: test mode — show everything.
    // PROJECTION: pure projection mode — emit queue + world_snapshot to stdout
    //   for the propose/validate flow.  Agents read this and extract the
    //   world_snapshot_hash to submit to integrity-bridge.mjs validate.
    //   No files are written to disk in either mode.
    const out = PROJECTION
      ? { queue: queueDoc, world_snapshot: worldSnapshot }  // minimal projection output
      : { queue: queueDoc, assignments: assignmentsDoc, runtime_status: runtimeDoc, report: reportDoc };
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(0);
  }

  fs.mkdirSync(SCHED_DIR, { recursive: true });
  writeAtomic(QUEUE_PATH,   queueDoc);
  writeAtomic(ASSIGN_PATH,  assignmentsDoc);
  writeAtomic(RUNTIME_PATH, runtimeDoc);
  writeAtomic(REPORT_PATH,  reportDoc);

  // ── Output ────────────────────────────────────────────────────────
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({
      ok:               warnings.length === 0,
      scheduler_sequence: schedulerSeq,
      registry_event_count: registry.event_count,
      queue_count:      queue.length,
      monitored_count:  runtimeDoc.monitored.length,
      warnings,
    }, null, 2) + '\n');
  } else {
    const WIDTH = 60;
    console.log('');
    console.log('NOVA 2.5 Scheduler');
    console.log('─'.repeat(WIDTH));
    console.log(`Sequence      : ${schedulerSeq}`);
    console.log(`Event count   : ${registry.event_count}`);
    console.log(`Head hash     : ${(scan.headHash ?? '—').slice(0, 16)}…`);
    console.log(`Agents        : ${agents.length}`);
    console.log(`Queue         : ${queue.length} schedulable task(s)`);
    console.log(`Monitoring    : ${runtimeDoc.monitored.length} active task(s)`);
    console.log(`Excluded      : ${excludedCount}  Terminal: ${terminalCount}`);
    if (trustReport?.status) console.log(`Trust         : ${trustReport.status}`);
    console.log('─'.repeat(WIDTH));

    if (queue.length > 0) {
      console.log('');
      console.log('  Queue (top tasks):');
      for (const entry of queue.slice(0, 5)) {
        const cand = entry.candidates[0]?.agent_id ?? '(no candidate)';
        console.log(
          `  ${entry.task_id.padEnd(16)}  ${entry.needed_role.padEnd(15)}` +
          `  score=${entry.score.toFixed(3).padStart(7)}  → ${cand}`
        );
      }
      if (queue.length > 5) console.log(`  … and ${queue.length - 5} more`);
    }

    if (warnings.length > 0) {
      console.log('');
      for (const w of warnings) console.log(`  ⚠  ${w}`);
    }

    console.log('');
    console.log(`OK: scheduler_sequence=${schedulerSeq}.`);
    console.log('');
  }

  process.exit(warnings.length > 0 ? 1 : 0);
}

main().catch(err => {
  const msg = `[scheduler] Fatal: ${err.message}`;
  if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
  else          console.error(msg);
  process.exit(2);
});
