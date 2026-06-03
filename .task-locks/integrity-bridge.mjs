/**
 * integrity-bridge.mjs — Proposal validator for NOVA 2.5 Scheduler Layer
 *
 * The integrity-bridge sits between scheduler.mjs and lease-manager.mjs.
 * It validates that a scheduling proposal is still coherent with the current
 * world state before authorising the lease acquisition commit.
 *
 * Two-phase commit flow:
 *   PROPOSE   agent reads queue.json → submits proposal to bridge
 *   VALIDATE  bridge checks B1-B6 → issues bridge_token if all pass
 *   COMMIT    lease-manager.mjs acquire --bridge-token <token>
 *
 * Six validation checks (B1-B6):
 *   B1  world_snapshot_match     recomputed world_snapshot_hash == proposal hash
 *   B2  scheduler_sequence_match proposal.scheduler_sequence == current report
 *   B3  task_schedulable         task still in TODO|REVIEW_LOCKED in registry.json
 *   B4  agent_active             agent still ACTIVE in agents/registry.json
 *   B5  slot_available           no ACTIVE lease for (task_id, role_category)
 *   B6  review_gate              review_legal=true (REVIEW/ARCHITECT only)
 *
 * Bridge token:
 *   bridge_token = SHA-256(task_id:agent_id:role:world_snapshot_hash:evaluated_at)
 *   Expires after bridge_token_ttl_seconds (from scheduler_policy.json, default 60 s).
 *   lease-manager.mjs verifies the token by recomputing it from the same inputs
 *   and checking world_snapshot_hash still matches the current world state.
 *
 * CONTRACT:
 *   READ ONLY.  Never writes any file.  Never emits events.
 *   All 6 checks run regardless of earlier failures (no short-circuit).
 *   The bridge never acquires leases and never calls lease-manager writes.
 *
 * Usage:
 *   echo '<proposal-json>' | node .task-locks/integrity-bridge.mjs validate [--json]
 *   node .task-locks/integrity-bridge.mjs validate --proposal-file <path> [--json]
 *   node .task-locks/integrity-bridge.mjs validate --task <id> --agent <id> --role <ROLE>
 *     --scheduler-sequence <N> --world-snapshot-hash <hex> [--json]
 *
 * Exit codes:
 *   0  — valid (bridge_token issued)
 *   1  — invalid (one or more checks failed)
 *   2  — usage error or required file missing
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads .task-locks/* and agents/*.
 *           calls lease-manager.mjs gate --json (read-only subprocess) for B6.
 *           NEVER writes. NEVER acquires leases. NEVER emits events.
 */

import crypto   from 'node:crypto';
import fs       from 'node:fs';
import path     from 'node:path';
import { spawnSync } from 'node:child_process';
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
const POLICY_PATH     = path.join(SCHED_DIR,    'scheduler_policy.json');
const REPORT_PATH     = path.join(SCHED_DIR,    'scheduler_report.json');
const LEASE_MANAGER   = path.join(LOCKS_DIR,    'lease-manager.mjs');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv      = process.argv.slice(2);
const JSON_OUT  = argv.includes('--json');

function arg(flag) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
}

// ---------------------------------------------------------------------------
// Helpers (self-contained — no shared imports with scheduler.mjs)
// ---------------------------------------------------------------------------

/** SHA-256 of a file's raw bytes, or hash of empty string if missing. */
function hashFile(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch {
    return crypto.createHash('sha256').update('', 'utf8').digest('hex');
  }
}

/** SHA-256 of a UTF-8 string. */
function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/** Read HEAD event hash + index from TASK_EVENTS.jsonl. */
function readEventHead() {
  if (!fs.existsSync(EVENTS_PATH)) return { hash: null, index: 0 };
  const raw   = fs.readFileSync(EVENTS_PATH, 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { hash: null, index: 0 };
  try {
    const ev = JSON.parse(lines[lines.length - 1]);
    return { hash: ev.event_hash ?? null, index: ev.event_index ?? 0 };
  } catch { return { hash: null, index: 0 }; }
}

/**
 * Recompute world_snapshot_hash from current file state.
 * Algorithm is identical to scheduler.mjs computeWorldSnapshot().
 * MUST be kept in sync manually — they are the same computation.
 */
function recomputeWorldSnapshotHash() {
  const head              = readEventHead();
  const eventHeadHash     = head.hash ?? '';
  const headEventIndex    = head.index;
  const registryHash      = hashFile(REGISTRY_PATH);
  const agentRegistryHash = hashFile(AGENT_REG_PATH);
  const leasesHash        = hashFile(LEASES_PATH);
  const policyHash        = hashFile(POLICY_PATH);

  const canonical = [
    eventHeadHash,
    String(headEventIndex),
    registryHash,
    agentRegistryHash,
    leasesHash,
    policyHash,
  ].join(':');

  return sha256(canonical);
}

/** Safe JSON file reader. */
function readJson(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

/**
 * Map role → role_category per lease.schema.json.
 * @param {string} role
 * @returns {'implementation_lock'|'review_lock'}
 */
function roleCategory(role) {
  return (role === 'REVIEW' || role === 'ARCHITECT') ? 'review_lock' : 'implementation_lock';
}

/** Call lease-manager.mjs gate (read-only) for a task. Returns gate object or null. */
function fetchReviewGate(taskId) {
  if (!fs.existsSync(LEASE_MANAGER)) return null;
  try {
    const r = spawnSync(
      process.execPath,
      [LEASE_MANAGER, 'gate', '--task', taskId, '--json'],
      { encoding: 'utf8', timeout: 15_000 }
    );
    if (r.status !== 0) return null;
    const parsed = JSON.parse((r.stdout ?? '').trim());
    return parsed.gate ?? null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Check result builder
// ---------------------------------------------------------------------------

/**
 * @param {boolean|null} ok
 * @param {string|null}  reason
 * @param {object|null}  detail
 * @returns {{ ok: boolean|null, reason: string|null, detail: object|null }}
 */
function checkResult(ok, reason = null, detail = null) {
  return { ok, reason: reason ?? null, detail: detail ?? null };
}

// ---------------------------------------------------------------------------
// The six validation checks
// ---------------------------------------------------------------------------

/**
 * B1 — world_snapshot_match
 * The current world_snapshot_hash must equal the one in the proposal.
 */
function checkWorldSnapshot(proposalHash) {
  const currentHash = recomputeWorldSnapshotHash();
  const ok = currentHash === proposalHash;
  return checkResult(
    ok,
    ok
      ? `world_snapshot_hash matches — world state is unchanged`
      : `world_snapshot_hash mismatch: state changed since scheduler ran`,
    { expected: proposalHash, found: currentHash }
  );
}

/**
 * B2 — scheduler_sequence_match
 * proposal.scheduler_sequence must equal scheduler_report.scheduler_sequence.
 */
function checkSchedulerSequence(proposalSeq) {
  const report    = readJson(REPORT_PATH);
  const currentSeq = report?.scheduler_sequence ?? null;
  if (currentSeq === null) {
    return checkResult(
      false,
      'scheduler_report.json not found — run scheduler.mjs first',
      null
    );
  }
  const ok = proposalSeq === currentSeq;
  return checkResult(
    ok,
    ok
      ? `scheduler_sequence=${proposalSeq} matches current run`
      : `scheduler_sequence mismatch: proposal has ${proposalSeq}, current is ${currentSeq}`,
    { expected: proposalSeq, found: currentSeq }
  );
}

/**
 * B3 — task_schedulable
 * The task must still be in a schedulable state in registry.json.
 */
function checkTaskSchedulable(taskId, neededRole) {
  const registry = readJson(REGISTRY_PATH);
  if (!registry) return checkResult(false, 'registry.json not found');

  const task = registry.tasks?.find(t => t.task_id === taskId);
  if (!task) return checkResult(false, `Task "${taskId}" not found in registry.json`);

  const policy = readJson(POLICY_PATH);
  const schedulableStates = policy?.schedulable_states ?? { TODO: 'IMPLEMENTATION', REVIEW_LOCKED: 'REVIEW' };

  const schedulableState = Object.entries(schedulableStates)
    .find(([, role]) => role === neededRole)
    ?.[0];

  if (!schedulableState) {
    return checkResult(
      false,
      `Role "${neededRole}" has no schedulable state in policy`,
      { task_status: task.status }
    );
  }

  const ok = task.status === schedulableState;
  return checkResult(
    ok,
    ok
      ? `Task "${taskId}" is in schedulable state ${task.status}`
      : `Task "${taskId}" is no longer schedulable: status=${task.status}, expected ${schedulableState}`,
    { task_status: task.status, expected_status: schedulableState }
  );
}

/**
 * B4 — agent_active
 * The agent must be ACTIVE in agents/registry.json.
 */
function checkAgentActive(agentId) {
  const agentReg = readJson(AGENT_REG_PATH);
  if (!agentReg) {
    // No agent registry yet — treat as unknown but non-blocking
    return checkResult(null, 'agents/registry.json not found — agent status unknown');
  }
  const agent = agentReg.agents?.find(a => a.agent_id === agentId);
  if (!agent) return checkResult(false, `Agent "${agentId}" not found in agents/registry.json`);

  const ok = agent.status === 'ACTIVE';
  return checkResult(
    ok,
    ok
      ? `Agent "${agentId}" is ACTIVE`
      : `Agent "${agentId}" is not ACTIVE (status: ${agent.status})`,
    { agent_status: agent.status }
  );
}

/**
 * B5 — slot_available
 * No ACTIVE lease must exist for (task_id, role_category).
 */
function checkSlotAvailable(taskId, role) {
  const leaseStore = readJson(LEASES_PATH);
  if (!leaseStore) {
    // No lease store yet — slot is available by definition
    return checkResult(true, 'leases.json not found — slot is available');
  }

  const category    = roleCategory(role);
  const activeLeases = leaseStore.leases?.filter(
    l => l.task_id === taskId && l.role_category === category && l.status === 'ACTIVE'
  ) ?? [];

  const ok = activeLeases.length === 0;
  return checkResult(
    ok,
    ok
      ? `Slot (${taskId}, ${category}) is available`
      : `Slot (${taskId}, ${category}) is occupied by agent "${activeLeases[0].agent_id}"`,
    ok ? null : { occupying_lease_id: activeLeases[0].lease_id?.slice(0, 16), occupying_agent: activeLeases[0].agent_id }
  );
}

/**
 * B6 — review_gate
 * For REVIEW/ARCHITECT roles only: review_legal must be true.
 * Returns null (N/A) for IMPLEMENTATION/REFACTOR.
 */
function checkReviewGate(taskId, role) {
  if (role !== 'REVIEW' && role !== 'ARCHITECT') {
    return checkResult(null, `N/A — review gate only applies to REVIEW/ARCHITECT roles`);
  }

  const gate = fetchReviewGate(taskId);
  if (gate === null) {
    return checkResult(
      null,
      `Could not compute review gate for task ${taskId} — lease-manager.mjs unavailable`
    );
  }

  const ok = gate.review_legal === true;
  return checkResult(
    ok,
    ok
      ? 'review_legal=true — all three gate conditions satisfied'
      : `review_legal=false — gate not satisfied: claim=${gate.claim_bound?.satisfied}, stability=${gate.stability_bound?.satisfied}, finalization=${gate.finalization_bound?.satisfied}`,
    ok ? null : {
      claim_bound_satisfied:        gate.claim_bound?.satisfied,
      stability_bound_satisfied:    gate.stability_bound?.satisfied,
      finalization_bound_satisfied: gate.finalization_bound?.satisfied,
    }
  );
}

// ---------------------------------------------------------------------------
// Bridge token computation + verification
// ---------------------------------------------------------------------------

/**
 * Compute the bridge_token.
 *
 * token_input = task_id:agent_id:role:world_snapshot_hash:evaluated_at
 * bridge_token = SHA-256(token_input)
 *
 * This is deterministic and verifiable without a secret key.
 * lease-manager.mjs verifies by recomputing from the same inputs.
 *
 * @param {string} taskId
 * @param {string} agentId
 * @param {string} role
 * @param {string} worldSnapshotHash
 * @param {string} evaluatedAt
 * @returns {string}
 */
export function computeBridgeToken(taskId, agentId, role, worldSnapshotHash, evaluatedAt) {
  return sha256(`${taskId}:${agentId}:${role}:${worldSnapshotHash}:${evaluatedAt}`);
}

/**
 * Verify a bridge_token.
 *
 * Recomputes the expected token and checks:
 *   1. token == expected_token (integrity)
 *   2. evaluated_at + ttlSeconds > now (freshness)
 *   3. world_snapshot_hash == current world hash (TOCTOU prevention)
 *
 * @param {{
 *   token:              string,
 *   taskId:             string,
 *   agentId:            string,
 *   role:               string,
 *   worldSnapshotHash:  string,
 *   evaluatedAt:        string,
 *   ttlSeconds:         number,
 * }} params
 * @returns {{ valid: boolean, reason: string | null }}
 */
export function verifyBridgeToken({ token, taskId, agentId, role, worldSnapshotHash, evaluatedAt, ttlSeconds }) {
  // Check 1: token integrity
  const expected = computeBridgeToken(taskId, agentId, role, worldSnapshotHash, evaluatedAt);
  if (token !== expected) {
    return { valid: false, reason: `bridge_token integrity check failed — token does not match inputs` };
  }

  // Check 2: freshness
  const evalMs      = new Date(evaluatedAt).getTime();
  const expiresMs   = evalMs + ttlSeconds * 1000;
  if (Date.now() > expiresMs) {
    return { valid: false, reason: `bridge_token expired (evaluated_at=${evaluatedAt}, ttl=${ttlSeconds}s)` };
  }

  // Check 3: world state has not changed since the bridge validated
  const currentHash = recomputeWorldSnapshotHash();
  if (currentHash !== worldSnapshotHash) {
    return { valid: false, reason: `world state changed since bridge validation — world_snapshot_hash diverged` };
  }

  return { valid: true, reason: null };
}

// ---------------------------------------------------------------------------
// Main validation function
// ---------------------------------------------------------------------------

/**
 * Validate a proposal and return the full bridge_response.
 *
 * @param {{
 *   task_id:              string,
 *   agent_id:             string,
 *   role:                 string,
 *   scheduler_sequence:   number,
 *   world_snapshot_hash:  string
 * }} proposal
 * @returns {object}  bridge_response per proposal.schema.json
 */
function validate(proposal) {
  const evaluatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const { task_id, agent_id, role, scheduler_sequence, world_snapshot_hash } = proposal;
  const neededRole = role;

  // Run all 6 checks unconditionally (no short-circuit)
  const checks = {
    world_snapshot_match:    checkWorldSnapshot(world_snapshot_hash),
    scheduler_sequence_match: checkSchedulerSequence(scheduler_sequence),
    task_schedulable:         checkTaskSchedulable(task_id, neededRole),
    agent_active:             checkAgentActive(agent_id),
    slot_available:           checkSlotAvailable(task_id, role),
    review_gate:              checkReviewGate(task_id, role),
  };

  // A check with ok=null (N/A) does not block validation.
  // Only ok=false is a blocking failure.
  const failures = Object.entries(checks)
    .filter(([, r]) => r.ok === false)
    .map(([name]) => name);

  const valid = failures.length === 0;

  // Read token TTL from policy
  const policy  = readJson(POLICY_PATH);
  const ttlSecs = policy?.score_parameters?.bridge_token_ttl_seconds ?? 60;

  // Issue bridge_token only if valid
  let bridgeToken = null;
  let expiresAt   = null;

  if (valid) {
    bridgeToken = computeBridgeToken(task_id, agent_id, role, world_snapshot_hash, evaluatedAt);
    const expiresMs = new Date(evaluatedAt).getTime() + ttlSecs * 1000;
    expiresAt = new Date(expiresMs).toISOString().replace(/\.\d+Z$/, 'Z');
  }

  // First failure reason for quick display
  const firstFailure = failures[0]
    ? checks[failures[0]]?.reason ?? `check "${failures[0]}" failed`
    : null;

  return {
    valid,
    reason:       firstFailure,
    bridge_token: bridgeToken,
    expires_at:   expiresAt,
    evaluated_at: evaluatedAt,
    proposal,
    checks,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const command = argv[0];

if (!command || command.startsWith('--')) {
  console.error('Usage: node integrity-bridge.mjs <validate|verify-token> [options]');
  process.exit(2);
}

// ---------------------------------------------------------------------------
// verify-token command (used by lease-manager.mjs acquire --bridge-token)
// ---------------------------------------------------------------------------

if (command === 'verify-token') {
  const token       = arg('--token');
  const taskId      = arg('--task');
  const agentId     = arg('--agent');
  const role        = arg('--role');
  const snapHash    = arg('--world-snapshot-hash');
  const evalAt      = arg('--evaluated-at');

  if (!token || !taskId || !agentId || !role || !snapHash || !evalAt) {
    console.error('verify-token requires: --token --task --agent --role --world-snapshot-hash --evaluated-at');
    process.exit(2);
  }

  const policy  = readJson(POLICY_PATH);
  const ttlSecs = policy?.score_parameters?.bridge_token_ttl_seconds ?? 60;

  const result = verifyBridgeToken({
    token, taskId, agentId, role,
    worldSnapshotHash: snapHash,
    evaluatedAt:       evalAt,
    ttlSeconds:        ttlSecs,
  });

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify({ ok: result.valid, ...result }) + '\n');
  } else {
    if (result.valid) console.log('OK: bridge_token is valid');
    else              console.error(`FAIL: ${result.reason}`);
  }
  process.exit(result.valid ? 0 : 1);
}

if (command !== 'validate') {
  console.error(`Unknown command: "${command}". Use: validate | verify-token`);
  process.exit(2);
}

// ── Read proposal ──────────────────────────────────────────────────
let proposal;

const proposalFile = arg('--proposal-file');

if (proposalFile) {
  if (!fs.existsSync(proposalFile)) {
    const msg = `Proposal file not found: ${proposalFile}`;
    if (JSON_OUT) process.stdout.write(JSON.stringify({ valid: false, reason: msg }) + '\n');
    else console.error(`FAIL: ${msg}`);
    process.exit(2);
  }
  try { proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8')); }
  catch (e) {
    const msg = `Proposal file is not valid JSON: ${e.message}`;
    if (JSON_OUT) process.stdout.write(JSON.stringify({ valid: false, reason: msg }) + '\n');
    else console.error(`FAIL: ${msg}`);
    process.exit(2);
  }
} else if (arg('--task')) {
  // Build proposal from individual CLI flags
  const taskId    = arg('--task');
  const agentId   = arg('--agent');
  const role      = arg('--role');
  const seqStr    = arg('--scheduler-sequence');
  const snapHash  = arg('--world-snapshot-hash');

  if (!taskId || !agentId || !role || !seqStr || !snapHash) {
    console.error('validate --task requires: --agent --role --scheduler-sequence --world-snapshot-hash');
    process.exit(2);
  }

  proposal = {
    task_id:             taskId,
    agent_id:            agentId,
    role,
    scheduler_sequence:  parseInt(seqStr, 10),
    world_snapshot_hash: snapHash,
  };
} else {
  // Read from stdin
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    console.error('No input: pass proposal via stdin, --proposal-file, or CLI flags');
    process.exit(2);
  }
  try { proposal = JSON.parse(raw); }
  catch (e) {
    const msg = `Stdin is not valid JSON: ${e.message}`;
    if (JSON_OUT) process.stdout.write(JSON.stringify({ valid: false, reason: msg }) + '\n');
    else console.error(`FAIL: ${msg}`);
    process.exit(2);
  }
}

// ── Validate required proposal fields ──────────────────────────────
const REQUIRED = ['task_id', 'agent_id', 'role', 'scheduler_sequence', 'world_snapshot_hash'];
const missing  = REQUIRED.filter(f => !(f in proposal) || proposal[f] === null || proposal[f] === undefined);
if (missing.length) {
  const msg = `Proposal missing required fields: ${missing.join(', ')}`;
  if (JSON_OUT) process.stdout.write(JSON.stringify({ valid: false, reason: msg }) + '\n');
  else console.error(`FAIL: ${msg}`);
  process.exit(2);
}

// ── Run validation ──────────────────────────────────────────────────
const response = validate(proposal);

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(response, null, 2) + '\n');
} else {
  const WIDTH = 60;
  const icon  = response.valid ? '✓' : '✗';
  console.log('');
  console.log('NOVA 2.5 Integrity Bridge');
  console.log('─'.repeat(WIDTH));
  console.log(`Task      : ${proposal.task_id}`);
  console.log(`Agent     : ${proposal.agent_id}`);
  console.log(`Role      : ${proposal.role}`);
  console.log(`Seq       : ${proposal.scheduler_sequence}`);
  console.log(`WS Hash   : ${proposal.world_snapshot_hash.slice(0, 16)}…`);
  console.log('─'.repeat(WIDTH));
  console.log('');

  for (const [name, check] of Object.entries(response.checks)) {
    const icon2 = check.ok === true ? '  ✓' : check.ok === false ? '  ✗' : '  –';
    console.log(`${icon2}  [${name}] ${check.reason ?? ''}`);
  }

  console.log('');
  if (response.valid) {
    console.log(`${icon}  VALID — bridge_token issued`);
    console.log(`  token:      ${response.bridge_token?.slice(0, 16)}…`);
    console.log(`  expires_at: ${response.expires_at}`);
    console.log(`  evaluated:  ${response.evaluated_at}`);
  } else {
    console.log(`${icon}  INVALID — ${response.reason}`);
  }
  console.log('');
}

process.exit(response.valid ? 0 : 1);
