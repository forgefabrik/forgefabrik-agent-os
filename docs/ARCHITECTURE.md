# event-os-core — Architecture

> **A deterministic, event-sourced operating system with cryptographic state binding, economic coordination, and an optional local LLM cognitive overlay.**

---

## Overview

event-os-core is not a task manager or a scheduler. It is a layered state machine where every decision is a pure function over a frozen world snapshot, every state change is an immutable append to a hash-chained event log, and every lease acquisition is a cryptographically validated two-phase commit.

## Decision Fabric Shift

```text
EVENTS = HISTORY LAYER
DECISIONS = ACTIVE CONTROL LAYER
REPLAY = VERIFICATION LAYER
UI = CYBERNETIC CONTROL PLANE
```

The public control-plane model is now:

```text
LLM suggestion
  -> decision_engine.mjs
  -> integrity-bridge
  -> lease-manager commit
  -> TASK_EVENTS.jsonl
  -> replayer
  -> COI decision stream
```

`decision_engine.mjs` is the public entrypoint for deterministic decision
computation. During the migration window it wraps `scheduler.mjs`, which remains
the compatibility implementation target for queue, assignment, and runtime
status artifacts.

The Cybernetic Operations Interface (COI) is served from
`decision/ui/dashboard.html` at `http://localhost:7337/`.

```
F(world_snapshot) → deterministic_schedule → bridge_validation → atomic_commit
```

Each step in this pipeline is either **pure** (no side effects, fully replayable) or **cryptographically bound** (tied to a specific, verifiable world state).

---

## Layer Stack

```
L0  EVENT CORE          TASK_EVENTS.jsonl
     ↓                  append-only · hash-chained · single writer
L1  ENGINE              audit · replayer · event-writer · integrity-bridge · lease-manager
     ↓                  deterministic · replayable · atomic
L2  SCHEDULER           scheduler.mjs · scheduler_policy.json
     ↓                  pure function over frozen world state
L3  ECONOMY             bid_projection.mjs · market_state.json
     ↓                  deterministic read-only projection of bid events
L4  TAP                 tap_engine.mjs · context_builder.mjs · llm_client.mjs
     ↓                  read-only · advisory output only · never decides
L5  LLM DAEMON          LM Studio (llmster) · Qwen3 0.8B IQ4_XS default
                        external process · stateless API consumer
```

---

## Hard Boundaries

### L0 — EVENT CORE (absolute)

```
Only authorized writer: .task-locks/event-writer.mjs
```

- `TASK_EVENTS.jsonl` is append-only. No event may ever be edited or deleted.
- Every event carries a SHA-256 hash chained to the previous event.
- The genesis hash is a constant derived from `genesis.json`.
- Any break in the chain is detected by `audit.mjs` and blocks all operations.

### L1 — ENGINE (deterministic + atomic)

- `audit.mjs` — read-only chain verifier
- `replayer.mjs` — pure function: `events → registry.json`
- `event-writer.mjs` — the single authorized TASK_EVENTS.jsonl writer
- `integrity-bridge.mjs` — proposal validator; issues single-use bridge tokens
- `lease-manager.mjs` — atomic lease executor with WRITE.lock
- `consistency-checker.mjs` — read-only layer consistency verifier
- `repair-manager.mjs` — write actor that applies consistency corrections

**No wall-clock time in decisions.** All timing uses `event_index` distance.

### L2 — SCHEDULER (pure function)

```
scheduler(world_snapshot) → queue.json
```

- Reads: `registry.json`, `agents/registry.json`, `agents/leases.json`, `scheduler_policy.json`, `economy/market_state.json`
- Writes: `scheduler/queue.json`, `scheduler/assignments.json`, `scheduler/runtime_status.json`, `scheduler/scheduler_report.json`
- **Never touches `TASK_EVENTS.jsonl`.** Never acquires leases.
- Computes a `world_snapshot_hash = SHA-256(event_head_hash:head_index:registry_hash:agent_hash:leases_hash:policy_hash:market_hash)`
- The hash binds every queue entry to a specific frozen world state.

### L3 — ECONOMY (deterministic projection)

```
bid_projection(TASK_BID_SUBMITTED events) → market_state.json
```

- Reads bid events from the event log, computes `market_pressure_multiplier` per task.
- Multiplier applied to `execution_cost` in the scheduler: `effective_cost = base_cost × multiplier`.
- **No decision authority.** Bids are advisory price signals, not auction outcomes.
- Fully replayable: same events always produce the same market state.

### L4 — TAP (read-only · advisory)

```
TAP: READ → ANALYZE → SUGGEST
```

- Reads all projections (registry, queue, agents, leases, economy).
- Calls L5 LLM with structured context.
- Writes only `tap/suggestions.json`.
- **Never writes events.** Never acquires leases. Never modifies scheduler state.
- LLM output is suggestions only; humans/operators decide whether to act.

### Mailbox Memory (communication only)

The COI mailbox stores long-form user context and AI replies in append-only
Markdown files under `decision/core/`.

Mailbox frontmatter separates two concepts:

- `role`: message direction (`user` or `ai`).
- `agent_role`: intended role context (`IMPLEMENTATION`, `REFACTOR`,
  `REVIEW`, `ARCHITECT`, `system`, or `unassigned`).

`agent_role` is routing metadata only. It is useful when asking specifically
for reviewer or architect feedback, but it never grants task authority, never
claims locks, never approves work, and never writes to `TASK_EVENTS.jsonl`.

### L5 — LLM DAEMON (external · stateless)

- LM Studio (llmster) running at `http://localhost:1234`.
- Default model: `Qwen3-Zero-Coder-Reasoning-V2-0.8B-NEO-EX-IQ4_XS`.
- Optional exploration model: `Qwen3-Zero-Coder-Reasoning-V2-0.8B-NEO-EX-IQ3_M`.
- Receives structured JSON context, returns structured JSON suggestions.
- Completely isolated from the event core — cannot reach `TASK_EVENTS.jsonl`.
- Model authority is planning-only: idea normalization, architecture proposals,
  bid intent normalization, and explanations. Replay-critical outputs are
  produced by deterministic engine code only.

---

## Two-Phase Commit Protocol

```
PROPOSE   agent reads queue.json → submits proposal to integrity-bridge
VALIDATE  bridge checks B1-B6 → issues bridge_token if all pass
COMMIT    lease-manager.acquire --bridge-token → atomic commit
```

### Bridge Token

```
bridge_token = SHA-256(task_id:agent_id:role:world_snapshot_hash:evaluated_at:commit_nonce)
```

- Valid for `bridge_token_ttl_seconds` (default 60 s).
- Single-use: nonce is consumed on first successful commit.
- If world state changes between propose and commit (any event written), the `world_snapshot_hash` diverges and the token is automatically invalid.

### Bridge Checks (B1-B6)

| Check | What it verifies |
|-------|-----------------|
| B1 | `world_snapshot_hash` matches current world state |
| B2 | `scheduler_sequence` matches current scheduler run |
| B3 | Task is still in a schedulable state |
| B4 | Agent is still `ACTIVE` |
| B5 | No active lease occupies the `(task_id, role_category)` slot |
| B6 | `review_legal = true` (REVIEW/ARCHITECT roles only) |

---

## Scoring Formula

The scheduler uses a two-tier deterministic scoring model:

```
urgency_norm    = min(1.0, (head_event_index - task.last_event_index) / halflife_events)
dep_norm        = min(1.0, blocked_count / max_dep_pressure)
trust_norm      = trust_ceiling  [0,1]
effective_cost  = execution_cost * market_pressure_multiplier
cost_inv_norm   = log(2) / log(effective_cost + 1)  [0,1]

within_score_fp = floor(1e6 × (0.35U + 0.25D + 0.25T + 0.15C))
final_score_fp  = within_score_fp × priority_multiplier

sort: priority_multiplier DESC → final_score_fp DESC → last_event_index ASC → task_id ASC
```

**Priority tiers** (discrete multipliers): P0=1× | P1=2× | P2=4× | P3=8×

No wall-clock time. No floats without explicit rounding. Total ordering guaranteed.

---

## Consistency Contract

Six rules govern consistency between the three authoritative layers (`EVENT_LOG > TASK_REGISTRY > LEASE_STORE`):

| Rule | Condition | Category |
|------|-----------|----------|
| R1 | Active lease + task terminal | INVALID |
| R2 | LEASE_EXPIRED event not synced | INVALID |
| R3 | Duplicate active slot | INVALID |
| R4 | Active review lease + gate invalid | INVALID |
| R5 | Agent registry stale | STALE |
| R6 | Lease store stale | STALE |
| R7 | Lease approaching expiry | WARNING |
| R8 | Agent heartbeat TTL exceeded | INVALID |

`consistency-checker.mjs` detects. `repair-manager.mjs` corrects. The checker never writes. The repairer never classifies.

---

## Governance Metrics

These measure system health over time, not just point-in-time consistency:

| Metric | Warning | Critical |
|--------|---------|----------|
| `lease_expiry_rate` | > 5% | > 20% |
| `repair_frequency` | > 10/day | > 100/day |
| `registry_rebuild_frequency` | > 20/day | — |
| `drift_density` | > 1% | > 10% |

A system with `drift_density > 10%` is formally consistent but operationally broken.

---

## File Layout

```
event-os-core/
│
├── TASK_EVENTS.jsonl         ← L0: event log (append-only, single writer)
│
├── .task-locks/              ← L1: engine layer
│   ├── audit.mjs
│   ├── replayer.mjs
│   ├── event-writer.mjs
│   ├── integrity-bridge.mjs
│   ├── lease-manager.mjs
│   ├── consistency-checker.mjs
│   ├── repair-manager.mjs
│   ├── scheduler.mjs         ← L2: scheduler
│   ├── agent-runtime.mjs
│   ├── agents/               ← agent registry + leases + reputation
│   ├── scheduler/            ← queue + assignments + policy
│   ├── snapshots/            ← registry snapshots
│   ├── genesis.json
│   ├── registry.json
│   ├── transitions.yaml
│   └── consistency.rules.yaml
│
├── economy/                  ← L3: economic overlay
│   ├── bid_projection.mjs
│   ├── market_state.json
│   └── pricing_model.json
│
├── tap/                      ← L4: TAP cognitive layer (read-only)
│   ├── context_builder.mjs
│   ├── tap_engine.mjs
│   ├── llm_client.mjs
│   └── suggestions.json
│
├── llm/                      ← L5: LLM client adapter
│   └── lmstudio_client.mjs
│
├── sim/                      ← simulation / testing
│   ├── world_simulator.mjs
│   ├── lease_race_engine.mjs
│   └── scenario_loader.json
│
├── config/                   ← system configuration
│   ├── world.config.json
│   └── system_limits.json
│
├── scripts/                  ← operations
│   ├── start.sh
│   ├── stop.sh
│   └── healthcheck.sh
│
├── lmstudio/                 ← LM Studio setup
│   ├── install.sh
│   ├── daemon_config.json
│   └── model_manifest.json
│
├── docs/
│   ├── ARCHITECTURE.md       ← this file
│   ├── SCHEDULER_SPEC.md
│   ├── ECONOMY_SPEC.md
│   └── TAP_SPEC.md
│
├── Dockerfile
└── docker-compose.yml
```

---

## Key Properties

| Property | Guarantee |
|----------|-----------|
| Replayability | `F(events) → identical registry.json` on any node, any time |
| Temporal safety | Every lease is valid in exactly one world state |
| No double-lease | WRITE.lock + bridge nonce prevents concurrent acquisition |
| Deterministic scoring | Same inputs → identical `queue.json` (bit-reproducible) |
| Auditability | Every scheduling decision explained by `components` breakdown |
| LLM isolation | TAP/LLM has zero write path to any authoritative layer |
