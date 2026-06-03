# NOVA 2.5 — Agent Workflow

**Version:** 3.0 (Event-Sourced)
**Last Updated:** 2026-06-03

Complete step-by-step workflow for AI agents working on NOVA 2.5.

---

## Prerequisites: Read These First

Before claiming any task, read:

1. [AGENTS.md](../../AGENTS.md) - deprecated compatibility notice
2. [.task-locks/registry.json](../../.task-locks/registry.json) - current task state (status, locks)
3. [.task-locks/transitions.yaml](../../.task-locks/transitions.yaml) - state machine
4. [TASK_GOVERNANCE.md](TASK_GOVERNANCE.md) - lock system reference

---

## Step 1: Find an Available Task

```bash
# Read .task-locks/registry.json to find tasks with:
#   status: TODO
#   implementation_lock: null
```

Open `.task-locks/registry.json`. Find a task where:
- `status` is `TODO`
- `implementation_lock` is `null`
- Your role matches the allowed transitions in `transitions.yaml`

**Never claim:**
- Tasks in `EXPIRED` state (terminal — request ARCHITECT to create a fork)
- Tasks in `MERGED` state (terminal)
- Tasks with an active `implementation_lock` held by another agent

Task existence is validated exclusively against `.task-locks/registry.json`.
Markdown task files are documentation-only.

---

## Step 2: Create a Branch

```bash
git checkout main
git pull origin main
git checkout -b feat/TASK-XXXX-short-description
```

Branch naming rules (hard fail if violated):
- `feat/TASK-0001-entity-allocator` ← IMPLEMENTATION
- `refactor/TASK-0001-memory-layout` ← REFACTOR
- `review/TASK-0001-final` ← REVIEW (no separate branch usually)
- `hotfix/TASK-0025-ci-failure` ← emergency

The branch name must contain the exact task ID.

---

## Step 3: Open a PR with Agent Declaration

Open a draft PR immediately (before writing any code). This **claims the task lock**.

Use the template at `.github/AGENT_PR_TEMPLATE.md`. The declaration block is mandatory:

```markdown
## Agent Declaration

**Role:** IMPLEMENTATION
**Task ID:** TASK-0001
**Model:** Claude 3.5 Sonnet
```

All three fields are required. Missing any field = PR immediately blocked.

**What happens when you open the PR:**
1. `agent-validation.yml` runs and validates your declaration against `registry.json`.
2. If valid, `task-lock.yml` calls `.task-locks/event-writer.mjs` which validates,
   computes the hash chain, and appends `TASK_CLAIMED` to `TASK_EVENTS.jsonl`.
3. `projection-builder.yml` runs `replayer.mjs` to rebuild `registry.json` —
   your `implementation_lock` appears.
4. The task is now exclusively yours.

If the task is already claimed (another agent got there first), you will see:
```
❌ Task 'TASK-0001' is locked by agent 'agent-gpt4-01' (role: IMPLEMENTATION).
Lock expires at: 2026-06-02T16:30:00Z
```

Choose a different TODO task or wait for the lock to expire.

---

## Step 4: Implement the Task

Follow the task's ACCEPTANCE criteria exactly. Work within scope — no
FORBIDDEN items, no future-phase features (see `AGENTS.md` RULE 5: PHASE GATING).

### Documentation and generated views

Update documentation when the implementation changes what humans need to know.
This is documentation maintenance, not task-state mutation.

Use these locations:

- `docs/ARCHITECTURE_PRINCIPLES.md` for stable architecture principles and
  product/engine direction that is not task state.
- `.agents/docs/` for agent workflow, review, ownership, and contribution
  protocol changes.

Do not edit `docs/ROADMAP.md` by hand. It is generated from
`.task-locks/registry.json` by `.task-locks/roadmap-projection.mjs` and must
match that projection exactly.

Never use Markdown to claim a task, prove task existence, define locks, or define
state transitions. Those remain exclusive to `TASK_EVENTS.jsonl`,
`.task-locks/transitions.yaml`, and `.task-locks/registry.json`.
**Code requirements (all mandatory):**
```bash
cargo check          # no compile errors
cargo fmt            # formatted
cargo clippy -- -D warnings  # no warnings
cargo test           # all tests pass
```

**Determinism requirements:**
- Use `ChaCha8Rng::seed_from_u64(seed)` — never `thread_rng()` or `rand::random()`
- Never call `SystemTime::now()`, `Instant::now()`, `chrono::Local::now()`
- Use `BTreeMap` in determinism-critical crates (ECS, world gen) — not `HashMap`

**Commit format (hard fail if wrong):**
```
[type] scope: description (TASK-XXXX)
```
Examples:
```
[ecs] sparse-set: add insert and remove methods (TASK-0002)
[core] arena: implement generational handle allocation (TASK-0008)
[render] quad: upload vertex buffers to GPU (TASK-0013)
```

Exempt from format check: merge commits (`Merge ...`), system commits (`[system] ...`).

---

## Step 5: Send Heartbeats

While working, post a PR comment every 30 minutes containing the word `HEARTBEAT`.
`task-lock.yml` detects this and extends your `implementation_lock` TTL.

```markdown
🔄 HEARTBEAT [TASK-0001]
Status: 60% complete — EntityId packing done, writing benchmarks
No blockers.
```

If you miss the 6-hour TTL without a heartbeat, your lock will be expired
(TASK_LOCK_EXPIRED event written, task → EXPIRED terminal state).

---

## Step 6: Request Review

When implementation is complete and all tests pass:

```markdown
Implementation complete. Ready for review.

✅ cargo check
✅ cargo test
✅ cargo fmt
✅ cargo clippy
✅ Determinism: using ChaCha8Rng, no SystemTime calls

@copilot request-review TASK-0001
```

**What happens:**
1. `task-lock.yml` writes `TASK_REVIEW_REQUESTED` event.
2. Projection builder transitions task to `REVIEW_LOCKED`.
3. Your `implementation_lock` is **transferred** (you can no longer push new commits).
4. The `review_lock` is created for the REVIEW agent.

---

## Step 7 (Optional): Refactor Phase

If a REFACTOR agent is needed before review, post:

```markdown
This code would benefit from cleanup before review.

Suggested refactor scope:
- Lifetime simplification in entity.rs lines 42-78
- Naming consistency for EntityAllocator methods

@copilot transition-to-refactor TASK-0001
```

The REFACTOR agent works on the same branch. No new functionality allowed.

---

## Step 8: REVIEW Agent Workflow

*For agents acting as REVIEW agents only.*

**Model requirement:** ONLY Claude 3.5 Sonnet or GPT-4 Turbo. No substitutes.

1. Find tasks with `status: REVIEW_LOCKED` in `registry.json`.
2. Submit a GitHub PR review (not just a comment).
3. `review-gate.yml` validates:
   - You are not the implementation author.
   - Task is in `REVIEW_LOCKED` state.
   - Your model is approved for REVIEW role.
4. Use the checklist in `REVIEW_CHECKLIST.md`.
5. Post your decision:

```markdown
## Review Agent Decision: APPROVED

**Role:** REVIEW
**Model:** Claude 3.5 Sonnet
**Task:** TASK-0001

### Architecture ✅
- [x] No cross-layer violations
- [x] Phase gate respected
- [x] No hidden globals

### Determinism ✅
- [x] ChaCha8Rng used, no system time
- [x] BTreeMap for ordered iteration

### Tests ✅
- [x] Edge cases covered
- [x] Benchmarks meet targets

**Decision:** APPROVED
```

If rejecting, cite specific `AGENTS.md` rules:

```markdown
**Decision:** NEEDS_FIXES

Architecture violation: nova-ecs imports nova-ai (AGENTS.md RULE 1).
Remove the dependency — this requires an RFC if the design truly needs it.
```

---

## Step 9: ARCHITECT Merge

*For agents acting as ARCHITECT only.*

1. Task must be `APPROVED` in `registry.json`.
2. All CI checks must pass (cargo build, tests, review-gate).
3. Merge with `--no-ff`:

```bash
git merge --no-ff feat/TASK-0001-entity-allocator \
  -m "[ARCHITECT] Merge TASK-0001: Entity Allocator (TASK-0001)"
```

`task-lock.yml` detects the merge and writes `TASK_MERGED` event.
Projection builder transitions task to `MERGED` (terminal), releases all locks.

---

## Failure & Recovery

### TTL Expired (EXPIRED state)

If your lock expires:
1. Task is now in `EXPIRED` (terminal). You cannot reclaim it.
2. A GitHub issue `⏰ Lock Expired: TASK-XXXX` is opened.
3. An ARCHITECT writes a `TASK_FORKED` event: `TASK-0001 → TASK-0001-a`.
4. The forked task starts as `TODO` — anyone may claim it.
5. Your work on the branch is preserved. The new agent may continue from it.

### Review Rejected (NEEDS_FIXES)

1. `task-lock.yml` writes `TASK_REJECTED` event.
2. Projection builder restores your `implementation_lock` (task → `IN_PROGRESS`).
3. Address the review feedback.
4. Re-request review: post `@copilot request-review TASK-XXXX` again.

### Architect Override

If an agent is unresponsive and blocking the critical path, only an ARCHITECT
may force-release a lock by writing a `TASK_ARCHITECT_OVERRIDE` event.
The `override_reason` field is mandatory and permanently recorded.

---

## Model Requirements

| Role | Approved Models |
|------|----------------|
| IMPLEMENTATION | Claude 3.5 Sonnet, GPT-4 Turbo (Tier 1); Llama 70B+, Mistral Medium (Tier 2) |
| REFACTOR | Claude 3.5 Sonnet, GPT-4 Turbo only |
| REVIEW | **ONLY** Claude 3.5 Sonnet or GPT-4 Turbo |
| ARCHITECT | **ONLY** Claude 3.5 Sonnet or GPT-4 Turbo |

Wrong model for role = PR blocked by `agent-validation.yml`.

---

## CI Workflows Summary

| Workflow | Trigger | Reads | Writes |
|----------|---------|-------|--------|
| `agent-validation.yml` | PR open/update | `registry.json`, `transitions.yaml` | — |
| `task-lock.yml` | PR, comment, schedule | `registry.json` | `TASK_EVENTS.jsonl` via `event-writer.mjs` |
| `projection-builder.yml` | Push to main, schedule | `TASK_EVENTS.jsonl`, `transitions.yaml` | `registry.json` via `replayer.mjs` |
| `event-append-check.yml` | PR + push to main | `TASK_EVENTS.jsonl` (before/after) | — |
| `review-gate.yml` | PR review | `registry.json`, `transitions.yaml` | — |
| `validate-config.yml` | Workflow changes | `TASK_EVENTS.jsonl`, `transitions.yaml` | — |

**One-sentence rule:** `task-lock.yml` writes events (via `event-writer.mjs`).
`projection-builder.yml` writes state (via `replayer.mjs`). Everything else only reads.

## Integrity Tools (available locally)

| Tool | Command | Purpose |
|---|---|---|
| `audit.mjs` | `node .task-locks/audit.mjs` | Verify hash chain + schema |
| `replayer.mjs` | `node .task-locks/replayer.mjs` | Rebuild registry.json |
| `replayer.mjs --verify` | `node .task-locks/replayer.mjs --verify` | Check if registry is current |
| `snapshot-writer.mjs` | `node .task-locks/snapshot-writer.mjs` | Write checkpoint snapshot |
| `event-writer.mjs` | `node .task-locks/event-writer.mjs --event ev.json` | Append validated event |

Run `audit.mjs --json` in CI to get a machine-readable integrity report.
