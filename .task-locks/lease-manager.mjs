/**
 * lease-manager.mjs — Agent Runtime lease lifecycle for NOVA 2.5
 *
 * Manages the .task-locks/agents/leases.json file and emits the corresponding
 * Agent Runtime events (LEASE_RENEWED, TASK_RELEASED, LEASE_EXPIRED) through
 * event-writer.mjs.  acquire() is the only operation that does NOT emit an
 * event — lease creation is implied by the pre-existing TASK_CLAIMED event.
 *
 * Gate contract (from task_runtime_state.schema.json):
 *   REVIEW/ARCHITECT leases may only be acquired when review_legal = true.
 *   review_legal = claim_bound AND stability_bound AND finalization_bound.
 *
 * Operations:
 *   acquire   — create a new ACTIVE lease (validates review gate for REVIEW role)
 *   renew     — extend expires_at, emit LEASE_RENEWED
 *   release   — mark RELEASED, emit TASK_RELEASED
 *   expire    — scan for overdue leases, mark EXPIRED, emit LEASE_EXPIRED per lease
 *   gate      — compute and print the review gate for a task (read-only)
 *
 * Usage (CLI):
 *   node .task-locks/lease-manager.mjs acquire  --agent <id> --task <id> --role <ROLE> [--ttl <s>] [--timestamp <ISO>] [--json]
 *   node .task-locks/lease-manager.mjs renew    --agent <id> --task <id> [--ttl <s>] [--timestamp <ISO>] [--json]
 *   node .task-locks/lease-manager.mjs release  --agent <id> --task <id> [--timestamp <ISO>] [--json]
 *   node .task-locks/lease-manager.mjs expire   [--timestamp <ISO>] [--json]
 *   node .task-locks/lease-manager.mjs gate     --task <id> [--json]
 *
 * Exit codes:
 *   0 — success
 *   1 — validation or gate failure
 *   2 — usage error or required file missing
 *
 * No npm dependencies. Pure Node.js ≥ 18.
 *
 * Boundary: reads TASK_EVENTS.jsonl, registry.json, snapshots/*.json.
 *           writes ONLY .task-locks/agents/leases.json.
 *           calls event-writer.mjs via subprocess for all event emissions.
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
const AGENTS_DIR   = path.join(LOCKS_DIR, 'agents');

const EVENTS_PATH     = path.join(PROJECT_ROOT, 'TASK_EVENTS.jsonl');
const REGISTRY_PATH   = path.join(LOCKS_DIR, 'registry.json');
const TRANSITIONS_YAML = path.join(LOCKS_DIR, 'transitions.yaml');
const LEASES_PATH     = path.join(AGENTS_DIR, 'leases.json');
const SNAPSHOTS_DIR   = path.join(LOCKS_DIR, 'snapshots');
const WRITER_PATH     = path.join(LOCKS_DIR, 'event-writer.mjs');
const WRITE_LOCK_FILE = path.join(LOCKS_DIR, 'WRITE.lock');
const BRIDGE_PATH     = path.join(LOCKS_DIR, 'integrity-bridge.mjs');

// ---------------------------------------------------------------------------
// TTL defaults (seconds) — sourced from transitions.yaml values
// ---------------------------------------------------------------------------

const TTL_IMPLEMENTATION_S = 21600;  // 6 h
const TTL_REFACTOR_S       =  7200;  // 2 h
const TTL_REVIEW_S         =  3600;  // 1 h

/** Return the default TTL for a given role, in seconds. */
function defaultTtl(role) {
  if (role === 'REFACTOR') return TTL_REFACTOR_S;
  if (role === 'REVIEW' || role === 'ARCHITECT') return TTL_REVIEW_S;
  return TTL_IMPLEMENTATION_S;
}

/** Map role → role_category (per lease.schema.json). */
function roleCategory(role) {
  if (role === 'REVIEW' || role === 'ARCHITECT') return 'review_lock';
  return 'implementation_lock';
}

// ---------------------------------------------------------------------------
// Hash helpers
// ---------------------------------------------------------------------------

function sha256(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

/**
 * Compute a deterministic lease_id.
 * Algorithm: SHA-256(task_id + ':' + agent_id + ':' + acquired_at)
 */
function computeLeaseId(taskId, agentId, acquiredAt) {
  return sha256(`${taskId}:${agentId}:${acquiredAt}`);
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
// registry.json helper
// ---------------------------------------------------------------------------

function readRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    throw new Error(`registry.json not found at ${REGISTRY_PATH}`);
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

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
// Event writer subprocess
// ---------------------------------------------------------------------------

/**
 * Emit one event via event-writer.mjs (subprocess, --no-lock because
 * the caller already holds WRITE.lock).
 *
 * @param {object} payload  — event fields (without computed fields)
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
  try {
    return JSON.parse(stdout);
  } catch {
    return { ok: false, error: `event-writer non-JSON output: ${stdout.slice(0, 200)}`, code: 'ERR_WRITER_OUTPUT' };
  }
}

// ---------------------------------------------------------------------------
// Bridge token verification (delegates to integrity-bridge.mjs)
// ---------------------------------------------------------------------------

/**
 * Verify a bridge_token by calling integrity-bridge.mjs verify-token.
 *
 * The bridge is called BEFORE acquiring the WRITE.lock to avoid holding
 * the lock during the subprocess call.
 *
 * @param {{
 *   token:             string,
 *   taskId:            string,
 *   agentId:           string,
 *   role:              string,
 *   worldSnapshotHash: string,
 *   evaluatedAt:       string,
 * }} params
 * @returns {{ ok: boolean, reason: string | null }}
 */
function verifyBridgeTokenViaSubprocess({ token, taskId, agentId, role, worldSnapshotHash, evaluatedAt }) {
  if (!fs.existsSync(BRIDGE_PATH)) {
    return { ok: false, reason: 'integrity-bridge.mjs not found — bridge validation skipped is not allowed' };
  }
  const result = spawnSync(
    process.execPath,
    [
      BRIDGE_PATH, 'verify-token', '--json',
      '--token',               token,
      '--task',                taskId,
      '--agent',               agentId,
      '--role',                role,
      '--world-snapshot-hash', worldSnapshotHash,
      '--evaluated-at',        evaluatedAt,
    ],
    { encoding: 'utf8', timeout: 15_000 }
  );

  if (result.error) {
    return { ok: false, reason: `Bridge subprocess error: ${result.error.message}` };
  }

  const stdout = (result.stdout ?? '').trim();
  try {
    const parsed = JSON.parse(stdout);
    return { ok: parsed.ok === true, reason: parsed.reason ?? null };
  } catch {
    return { ok: false, reason: `Bridge returned non-JSON: ${stdout.slice(0, 100)}` };
  }
}

// ---------------------------------------------------------------------------
// Review gate computation
// ---------------------------------------------------------------------------

/**
 * Parse TASK_EVENTS.jsonl and collect:
 *   claimEvents     — TASK_CLAIMED for taskId
 *   heartbeatEvents — TASK_HEARTBEAT for taskId
 *   reviewRequests  — TASK_REVIEW_REQUESTED for taskId
 *   snapshotEvents  — all SNAPSHOT_CREATED events (any task)
 *
 * @param {string} taskId
 * @returns {Promise<{
 *   claimEvents: object[],
 *   heartbeatEvents: object[],
 *   reviewRequests: object[],
 *   snapshotEvents: object[]
 * }>}
 */
async function scanEventsForTask(taskId) {
  const claimEvents    = [];
  const heartbeatEvents = [];
  const reviewRequests  = [];
  const snapshotEvents  = [];

  if (!fs.existsSync(EVENTS_PATH)) {
    return { claimEvents, heartbeatEvents, reviewRequests, snapshotEvents };
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(EVENTS_PATH, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const rawLine of rl) {
    const line = rawLine.trim();
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }

    switch (ev.event_type) {
      case 'TASK_CLAIMED':
        if (ev.task_id === taskId) claimEvents.push(ev);
        break;
      case 'TASK_HEARTBEAT':
        if (ev.task_id === taskId) heartbeatEvents.push(ev);
        break;
      case 'TASK_REVIEW_REQUESTED':
        if (ev.task_id === taskId) reviewRequests.push(ev);
        break;
      case 'SNAPSHOT_CREATED':
        snapshotEvents.push(ev);
        break;
    }
  }

  return { claimEvents, heartbeatEvents, reviewRequests, snapshotEvents };
}

/**
 * Load a snapshot file and return its data, or null if missing/unreadable.
 * @param {number} index
 * @returns {object|null}
 */
function loadSnapshot(index) {
  const p = path.join(SNAPSHOTS_DIR, `snapshot_${index}.json`);
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

/**
 * Compute the three-part review gate for taskId.
 *
 * @param {string} taskId
 * @param {object} registry  — current registry.json contents
 * @returns {Promise<import('./agents/task_runtime_state.schema.json')['definitions']['review_gate']>}
 */
async function computeReviewGate(taskId, registry) {
  const { claimEvents, heartbeatEvents, reviewRequests, snapshotEvents } =
    await scanEventsForTask(taskId);

  // ── Claim event ───────────────────────────────────────────────────
  const lastClaim = claimEvents[claimEvents.length - 1] ?? null;
  const claimEventIndex = lastClaim ? lastClaim.event_index : 0;

  // ── Find a qualifying snapshot ────────────────────────────────────
  // We look for the most recent snapshot that satisfies all three bounds.
  // Iterate snapshot_events from newest to oldest.
  const sortedSnapshots = [...snapshotEvents].sort(
    (a, b) => b.event_index - a.event_index
  );

  let bestSnapshot      = null;
  let claimBound        = false;
  let finalizationBound = false;
  let stabilityBound    = false;
  let boundSnapshotIndex = null;
  let snapshotEventCount = null;
  let triggerEventType   = null;
  let triggerEventIndex  = null;
  let snapshotImplHeartbeatAgeSeconds = null;

  for (const snapshotEv of sortedSnapshots) {
    const snap = loadSnapshot(snapshotEv.snapshot_index);
    if (!snap) continue;

    const snapEventCount = snap.registry?.event_count ?? 0;

    // ── Claim-bound: snapshot.event_count > claim_event_index ────
    if (snapEventCount <= claimEventIndex) continue;

    // ── Finalization-bound: preceding event is TASK_REVIEW_REQUESTED
    // Find review_requested events for this task with event_index < snapshotEv.event_index
    // and event_index > claimEventIndex — pick the most recent.
    const precedingReview = reviewRequests
      .filter(r => r.event_index < snapshotEv.event_index && r.event_index > claimEventIndex)
      .sort((a, b) => b.event_index - a.event_index)[0] ?? null;

    if (!precedingReview) continue;

    // ── Stability-bound: impl lock was alive at snapshot time ────
    // Find the most recent TASK_HEARTBEAT (or TASK_CLAIMED) for this task
    // with event_index <= snapshotEv.event_index.
    const allHeartbeatsAtSnap = [
      ...(lastClaim ? [lastClaim] : []),
      ...heartbeatEvents,
    ]
      .filter(h => h.event_index <= snapshotEv.event_index)
      .sort((a, b) => b.event_index - a.event_index);

    const lastHeartbeatAtSnap = allHeartbeatsAtSnap[0] ?? null;

    // Determine TTL at snapshot time based on last claim role
    const claimRole = lastClaim?.role ?? 'IMPLEMENTATION';
    const implTtlS  = claimRole === 'REFACTOR' ? TTL_REFACTOR_S : TTL_IMPLEMENTATION_S;

    let stableAtSnap = false;
    let heartbeatAgeS = null;

    if (lastHeartbeatAtSnap) {
      const snapTs      = new Date(snapshotEv.timestamp).getTime();
      const heartbeatTs = new Date(lastHeartbeatAtSnap.timestamp).getTime();
      heartbeatAgeS = (snapTs - heartbeatTs) / 1000;
      stableAtSnap  = heartbeatAgeS >= 0 && heartbeatAgeS < implTtlS;
    }

    if (!stableAtSnap) continue;

    // All three bounds satisfied — use this snapshot
    bestSnapshot          = snapshotEv;
    claimBound            = true;
    finalizationBound     = true;
    stabilityBound        = true;
    boundSnapshotIndex    = snapshotEv.snapshot_index;
    snapshotEventCount    = snapEventCount;
    triggerEventType      = precedingReview.event_type;
    triggerEventIndex     = precedingReview.event_index;
    snapshotImplHeartbeatAgeSeconds = heartbeatAgeS;
    break;
  }

  // ── Determine TTL for stability reason string ─────────────────────
  const claimRole = lastClaim?.role ?? 'IMPLEMENTATION';
  const implTtlS  = claimRole === 'REFACTOR' ? TTL_REFACTOR_S : TTL_IMPLEMENTATION_S;

  return {
    claim_bound: {
      satisfied:            claimBound,
      bound_snapshot_index: boundSnapshotIndex,
      claim_event_index:    claimEventIndex,
      snapshot_event_count: snapshotEventCount,
      reason: claimBound
        ? `snapshot_${boundSnapshotIndex} event_count=${snapshotEventCount} > claim_event_index=${claimEventIndex}`
        : `No snapshot found with event_count > ${claimEventIndex} (claim @ idx ${claimEventIndex})`,
    },
    stability_bound: {
      satisfied:                          stabilityBound,
      snapshot_impl_heartbeat_age_seconds: snapshotImplHeartbeatAgeSeconds,
      impl_ttl_seconds:                    implTtlS,
      reason: stabilityBound
        ? `Implementation heartbeat was ${snapshotImplHeartbeatAgeSeconds?.toFixed(1)} s old at snapshot time (TTL ${implTtlS} s)`
        : `No qualifying snapshot found where implementation was alive within TTL ${implTtlS} s`,
    },
    finalization_bound: {
      satisfied:           finalizationBound,
      trigger_event_type:  triggerEventType,
      trigger_event_index: triggerEventIndex,
      reason: finalizationBound
        ? `Snapshot preceded by TASK_REVIEW_REQUESTED at event_index=${triggerEventIndex}`
        : 'No qualifying snapshot was preceded by TASK_REVIEW_REQUESTED for this task',
    },
    review_legal: claimBound && stabilityBound && finalizationBound,
  };
}

// ---------------------------------------------------------------------------
// acquire
// ---------------------------------------------------------------------------

/**
 * Acquire a lease for an agent on a task.
 *
 * @param {{
 *   agentId:       string,
 *   taskId:        string,
 *   role:          string,
 *   ttlSeconds?:   number,
 *   timestamp:     string,
 *   bridgeToken?:  {
 *     token:              string,
 *     worldSnapshotHash:  string,
 *     evaluatedAt:        string,
 *   } | null
 * }} opts
 * @returns {Promise<{ ok: boolean, lease?: object, error?: string, code?: string, gate?: object }>}
 */
export async function acquireLease({ agentId, taskId, role, ttlSeconds, timestamp, bridgeToken = null }) {
  const ttl      = ttlSeconds ?? defaultTtl(role);
  const category = roleCategory(role);

  // ── Bridge token verification (optional — STEP 3 commit phase) ──────
  // If the caller provides a bridge_token (obtained from integrity-bridge.mjs
  // validate), verify it BEFORE acquiring the WRITE.lock.
  //
  // This is OPTIONAL for backward compatibility: agents that call acquire()
  // directly without going through the scheduler+bridge pipeline still work.
  // However, agents that USE the scheduler SHOULD provide a bridge_token to
  // get the TOCTOU guarantee.
  if (bridgeToken !== null && bridgeToken !== undefined) {
    const btVerify = verifyBridgeTokenViaSubprocess({
      token:             bridgeToken.token,
      taskId,
      agentId,
      role,
      worldSnapshotHash: bridgeToken.worldSnapshotHash,
      evaluatedAt:       bridgeToken.evaluatedAt,
    });
    if (!btVerify.ok) {
      return {
        ok:    false,
        error: `Bridge token verification failed: ${btVerify.reason}`,
        code:  'ERR_BRIDGE_TOKEN_INVALID',
      };
    }
  }

  // ── Load current state ──────────────────────────────────────────
  const registry = readRegistry();
  const task     = registry.tasks.find(t => t.task_id === taskId);
  if (!task) {
    return { ok: false, error: `Task "${taskId}" not found in registry.json`, code: 'ERR_TASK_NOT_FOUND' };
  }

  // ── Review gate check ───────────────────────────────────────────
  if (category === 'review_lock') {
    const gate = await computeReviewGate(taskId, registry);
    if (!gate.review_legal) {
      return {
        ok:    false,
        error: `Review gate not satisfied for task ${taskId}`,
        code:  'ERR_REVIEW_GATE',
        gate,
      };
    }
    // Pass the bound_snapshot_index to the lease record
    const acquiredAt = timestamp;
    const expiresAt  = new Date(new Date(acquiredAt).getTime() + ttl * 1000).toISOString();
    const leaseId    = computeLeaseId(taskId, agentId, acquiredAt);

    acquireWriteLock();
    try {
      const store = readLeases();

      // Check for existing ACTIVE lease in this slot
      const existing = store.leases.find(
        l => l.task_id === taskId && l.role_category === category && l.status === 'ACTIVE'
      );
      if (existing) {
        return {
          ok:    false,
          error: `Task ${taskId} already has an ACTIVE ${category} (agent: ${existing.agent_id})`,
          code:  'ERR_SLOT_OCCUPIED',
        };
      }

      /** @type {object} */
      const lease = {
        lease_id:             leaseId,
        agent_id:             agentId,
        task_id:              taskId,
        role,
        role_category:        category,
        acquired_at:          acquiredAt,
        expires_at:           expiresAt,
        last_heartbeat:       acquiredAt,
        status:               'ACTIVE',
        claim_event_index:    gate.claim_bound.claim_event_index,
        bound_snapshot_index: gate.claim_bound.bound_snapshot_index,
        renewal_count:        0,
        released_at:          null,
      };

      store.leases.push(lease);
      writeLeases(store, timestamp);
      return { ok: true, lease, gate };
    } finally {
      releaseWriteLock();
    }
  }

  // ── IMPLEMENTATION / REFACTOR slot ─────────────────────────────
  acquireWriteLock();
  try {
    const store = readLeases();

    const existing = store.leases.find(
      l => l.task_id === taskId && l.role_category === category && l.status === 'ACTIVE'
    );
    if (existing) {
      return {
        ok:    false,
        error: `Task ${taskId} already has an ACTIVE ${category} (agent: ${existing.agent_id})`,
        code:  'ERR_SLOT_OCCUPIED',
      };
    }

    const acquiredAt = timestamp;
    const expiresAt  = new Date(new Date(acquiredAt).getTime() + ttl * 1000).toISOString();
    const leaseId    = computeLeaseId(taskId, agentId, acquiredAt);

    // Determine claim_event_index from registry
    const claimEventIndex = task.last_event_index ?? 0;

    /** @type {object} */
    const lease = {
      lease_id:             leaseId,
      agent_id:             agentId,
      task_id:              taskId,
      role,
      role_category:        category,
      acquired_at:          acquiredAt,
      expires_at:           expiresAt,
      last_heartbeat:       acquiredAt,
      status:               'ACTIVE',
      claim_event_index:    claimEventIndex,
      bound_snapshot_index: null,
      renewal_count:        0,
      released_at:          null,
    };

    store.leases.push(lease);
    writeLeases(store, timestamp);
    return { ok: true, lease };
  } finally {
    releaseWriteLock();
  }
}

// ---------------------------------------------------------------------------
// renew
// ---------------------------------------------------------------------------

/**
 * Renew an active lease, extending its expiry and emitting LEASE_RENEWED.
 *
 * @param {{
 *   agentId:      string,
 *   taskId:       string,
 *   ttlSeconds?:  number,
 *   timestamp:    string,
 *   engineVersion: number,
 * }} opts
 * @returns {{ ok: boolean, lease?: object, error?: string, code?: string }}
 */
export function renewLease({ agentId, taskId, ttlSeconds, timestamp, engineVersion }) {
  acquireWriteLock();
  try {
    const store = readLeases();
    const lease = store.leases.find(
      l => l.agent_id === agentId && l.task_id === taskId && l.status === 'ACTIVE'
    );
    if (!lease) {
      return { ok: false, error: `No ACTIVE lease found for agent=${agentId} task=${taskId}`, code: 'ERR_NO_ACTIVE_LEASE' };
    }

    const ttl = ttlSeconds ?? defaultTtl(lease.role);
    lease.expires_at     = new Date(new Date(timestamp).getTime() + ttl * 1000).toISOString();
    lease.last_heartbeat = timestamp;
    lease.renewal_count  = (lease.renewal_count ?? 0) + 1;

    // Emit LEASE_RENEWED event
    const evResult = emitEvent({
      event_type:     'LEASE_RENEWED',
      engine_version:  engineVersion,
      timestamp,
      task_id:         taskId,
      agent:           agentId,
      role:            lease.role,
      model:           null,
      notes:           `lease_until=${lease.expires_at}`,
    });

    if (!evResult.ok) {
      return { ok: false, error: `LEASE_RENEWED event write failed: ${evResult.error}`, code: evResult.code };
    }

    writeLeases(store, timestamp);
    return { ok: true, lease };
  } finally {
    releaseWriteLock();
  }
}

// ---------------------------------------------------------------------------
// release
// ---------------------------------------------------------------------------

/**
 * Voluntarily release an active lease, emitting TASK_RELEASED.
 *
 * @param {{
 *   agentId:      string,
 *   taskId:       string,
 *   timestamp:    string,
 *   engineVersion: number,
 * }} opts
 * @returns {{ ok: boolean, lease?: object, error?: string, code?: string }}
 */
export function releaseLease({ agentId, taskId, timestamp, engineVersion }) {
  acquireWriteLock();
  try {
    const store = readLeases();
    const lease = store.leases.find(
      l => l.agent_id === agentId && l.task_id === taskId && l.status === 'ACTIVE'
    );
    if (!lease) {
      return { ok: false, error: `No ACTIVE lease found for agent=${agentId} task=${taskId}`, code: 'ERR_NO_ACTIVE_LEASE' };
    }

    // Emit TASK_RELEASED event
    const evResult = emitEvent({
      event_type:     'TASK_RELEASED',
      engine_version:  engineVersion,
      timestamp,
      task_id:         taskId,
      agent:           agentId,
      role:            lease.role,
      model:           null,
    });

    if (!evResult.ok) {
      return { ok: false, error: `TASK_RELEASED event write failed: ${evResult.error}`, code: evResult.code };
    }

    lease.status      = 'RELEASED';
    lease.released_at = timestamp;

    writeLeases(store, timestamp);
    return { ok: true, lease };
  } finally {
    releaseWriteLock();
  }
}

// ---------------------------------------------------------------------------
// checkExpired
// ---------------------------------------------------------------------------

/**
 * Scan for leases whose expires_at is before `timestamp`, mark them EXPIRED,
 * and emit a LEASE_EXPIRED event per expired lease.
 *
 * @param {{
 *   timestamp:    string,
 *   engineVersion: number,
 * }} opts
 * @returns {{ ok: boolean, expired: object[], errors: string[] }}
 */
export function checkExpired({ timestamp, engineVersion }) {
  acquireWriteLock();
  try {
    const store   = readLeases();
    const nowMs   = new Date(timestamp).getTime();
    const expired = [];
    const errors  = [];

    for (const lease of store.leases) {
      if (lease.status !== 'ACTIVE') continue;
      if (new Date(lease.expires_at).getTime() >= nowMs) continue;

      // Emit LEASE_EXPIRED event
      const evResult = emitEvent({
        event_type:     'LEASE_EXPIRED',
        engine_version:  engineVersion,
        timestamp,
        task_id:         lease.task_id,
        agent:           null,
        role:            'system',
        model:           null,
        notes:           `expired_agent=${lease.agent_id} lease_id=${lease.lease_id.slice(0, 16)}`,
      });

      if (!evResult.ok) {
        errors.push(`Failed to emit LEASE_EXPIRED for lease ${lease.lease_id.slice(0, 16)}: ${evResult.error}`);
        continue;
      }

      lease.status      = 'EXPIRED';
      lease.released_at = timestamp;
      expired.push({ agent_id: lease.agent_id, task_id: lease.task_id, lease_id: lease.lease_id });
    }

    if (expired.length > 0 || errors.length === 0) {
      writeLeases(store, timestamp);
    }

    return { ok: errors.length === 0, expired, errors };
  } finally {
    releaseWriteLock();
  }
}

// ---------------------------------------------------------------------------
// CLI interface
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);

/** Parse --key value pairs from argv */
function arg(flag, fallback = null) {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : fallback;
}

const JSON_OUT = argv.includes('--json');

function out(data) {
  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  } else {
    if (data.ok === false) {
      console.error(`FAIL [${data.code ?? 'ERR'}]: ${data.error}`);
    } else {
      console.log(`OK: ${JSON.stringify(data)}`);
    }
  }
}

const command = argv[0];

if (!command || command.startsWith('--')) {
  console.error('Usage: node lease-manager.mjs <acquire|renew|release|expire|gate> [options]');
  process.exit(2);
}

const engineVersion = readEngineVersion();
const timestamp     = arg('--timestamp') ?? new Date().toISOString().replace(/\.\d+Z$/, 'Z');

(async () => {
  switch (command) {

    case 'acquire': {
      const agentId  = arg('--agent');
      const taskId   = arg('--task');
      const role     = arg('--role');
      const ttl      = arg('--ttl') ? parseInt(arg('--ttl'), 10) : undefined;
      if (!agentId || !taskId || !role) {
        console.error('acquire requires: --agent <id> --task <id> --role <ROLE>');
        process.exit(2);
      }
      // Optional bridge token (STEP 3 commit phase)
      const btToken   = arg('--bridge-token');
      const btSnap    = arg('--bridge-snapshot');
      const btEvalAt  = arg('--bridge-evaluated-at');
      const bridgeToken = (btToken && btSnap && btEvalAt)
        ? { token: btToken, worldSnapshotHash: btSnap, evaluatedAt: btEvalAt }
        : null;

      const result = await acquireLease({ agentId, taskId, role, ttlSeconds: ttl, timestamp, bridgeToken });
      out(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'renew': {
      const agentId = arg('--agent');
      const taskId  = arg('--task');
      const ttl     = arg('--ttl') ? parseInt(arg('--ttl'), 10) : undefined;
      if (!agentId || !taskId) {
        console.error('renew requires: --agent <id> --task <id>');
        process.exit(2);
      }
      const result = renewLease({ agentId, taskId, ttlSeconds: ttl, timestamp, engineVersion });
      out(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'release': {
      const agentId = arg('--agent');
      const taskId  = arg('--task');
      if (!agentId || !taskId) {
        console.error('release requires: --agent <id> --task <id>');
        process.exit(2);
      }
      const result = releaseLease({ agentId, taskId, timestamp, engineVersion });
      out(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'expire': {
      const result = checkExpired({ timestamp, engineVersion });
      out(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'gate': {
      const taskId = arg('--task');
      if (!taskId) {
        console.error('gate requires: --task <id>');
        process.exit(2);
      }
      const registry = readRegistry();
      const gate     = await computeReviewGate(taskId, registry);
      out({ ok: true, task_id: taskId, gate });
      process.exit(0);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Use: acquire|renew|release|expire|gate`);
      process.exit(2);
  }
})().catch(err => {
  console.error('[lease-manager] Fatal:', err);
  process.exit(2);
});
