# NOVA 2.5 Agent Onboarding

Paste this file into every new agent session before asking the agent to work on
the engine.

The goal is simple: many independent CLI agents may work on NOVA 2.5 in
parallel, but they must all obey the same task, lock, review, and truth-layer
contract.

This file is instructions only. It is not system truth.

## Project Snapshot

NOVA 2.5 is a Rust workspace for a modular voxel sandbox/RPG engine.

Phase 0 foundation is complete:

- `nova-core`: math, time, events, typed handles
- `nova-ecs`: sparse-set ECS and world storage
- `nova-world`: voxel data, chunks, biomes, procedural worldgen
- `nova-render`: wgpu renderer, camera, tile renderer, egui UI
- `nova-engine`: MVP binary and game loop

Phase 1 is active:

- terrain backbone
- lighting
- physics
- chunk streaming
- performance hardening

Use [docs/ROADMAP.md](../docs/ROADMAP.md) as the generated human view of
`registry.json`. It is task state display, not task authority, and agents must
not edit it by hand.

## Truth Layers

Operational truth lives only here:

1. `TASK_EVENTS.jsonl`
   - event history
   - append-only
   - write only through `.task-locks/event-writer.mjs` — never directly

2. `.task-locks/transitions.yaml`
   - state machine rules
   - allowed roles and transitions
   - do not duplicate rules locally

3. `.task-locks/registry.json`
   - derived task projection
   - current task status and locks
   - rebuilt by `replayer.mjs` — read-only for agents

4. `.task-locks/genesis.json`
   - bootstrap task manifest
   - static initial task set
   - not mutable runtime state

Everything else is documentation, interface, or tooling.

## Integrity Tool Chain

These tools implement and verify the event-log lifecycle. All are in `.task-locks/`:

| Tool | Purpose | When to run |
|---|---|---|
| `audit.mjs` | Verify hash chain, index continuity, schema | Before any write; in CI |
| `replayer.mjs` | Rebuild `registry.json` from events | After any new event |
| `replayer.mjs --verify` | Check if `registry.json` is current | Before reading state |
| `event-writer.mjs` | Append one validated event | Only authorized write path |
| `snapshot-writer.mjs` | Checkpoint: snapshot + `SNAPSHOT_CREATED` event | Periodically |

```bash
# Verify chain
node .task-locks/audit.mjs

# Check registry is current
node .task-locks/replayer.mjs --verify

# Write an event (example: PROJECTION_REBUILT)
echo '{"event_type":"PROJECTION_REBUILT","engine_version":1,"timestamp":"...","role":"system","notes":"event_count=3"}' \
  | node .task-locks/event-writer.mjs --json
```

Markdown files are never authoritative input for CI, task existence, locks, or
task state.

## Required First Reads

Before doing any work, read these files in this order:

1. `.agents/constraints.md`
2. `.agents/bootstrap.json`
3. `.agents/roles.md`
4. `ONBOARDING.md`
5. `.task-locks/registry.json`
6. `.task-locks/transitions.yaml`
7. `.agents/docs/AGENT_WORKFLOW.md`
8. `.agents/docs/REVIEW_CHECKLIST.md` when acting as `REVIEW`

After reading, summarize:

- chosen role
- chosen task ID
- current task state
- lock status
- intended scope
- verification commands you will run

If any required state cannot be verified from the truth layers, stop.

## Valid Roles

Every agent must act as exactly one role:

- `IMPLEMENTATION`
- `REFACTOR`
- `REVIEW`
- `ARCHITECT`

The role must be declared in the PR. Role behavior is defined in
[.agents/roles.md](roles.md) and transition permission is defined in
`.task-locks/transitions.yaml`.

Do not infer role permissions from prose.

## How To Pick Work

If a human assigned a task ID, use that task ID.

If no task ID was assigned:

1. Pull latest `main`.
2. Open `.task-locks/registry.json`.
3. Find a task with:
   - `status: "TODO"`
   - `implementation_lock: null`
   - `review_lock: null`
4. Prefer the lowest-numbered available task.
5. Choose a narrow implementation scope for that task.
6. Record the actual scope in the PR title and body.

The registry decides whether a task exists. The roadmap only displays the
projected task queue.

If multiple agents start at once, race safely:

- each agent opens a draft PR with its declaration
- CI validates the task and writes the lock event
- if another agent wins the lock first, choose another `TODO` task

Never create a private task list.
Never claim a task by editing files manually.

## Claim Protocol

For `IMPLEMENTATION`, create a branch:

```bash
git checkout main
git pull origin main
git checkout -b feat/TASK-XXXX-short-scope
```

Open a draft PR immediately, before large code changes.

The PR must include:

```markdown
## Agent Declaration

Role: IMPLEMENTATION
Task ID: TASK-XXXX
Model: <model name>
```

The task is not claimed until CI accepts the declaration and records the event.

Do not edit:

- `TASK_EVENTS.jsonl` directly — use `event-writer.mjs` or the CI workflow
- `.task-locks/registry.json` — rebuilt by `replayer.mjs`
- `.task-locks/snapshots/*` — written by `snapshot-writer.mjs`

These are written only by the authorized tool chain, never by hand.

## Working Rules

Work only inside the declared task scope.

Allowed:

- implement the requested engine feature
- add focused tests
- update product or architecture prose when it explains the implemented feature
- update agent documentation only when the task is explicitly governance-related

Forbidden:

- broad unrelated refactors
- hidden state caches
- local lock systems
- local transition logic
- direct registry edits
- writing to TASK_EVENTS.jsonl directly (use event-writer.mjs)
- direct roadmap edits
- treating Markdown as operational truth
- implementing future phases unless the task says so

If you discover a governance mismatch, stop normal implementation and report it
as a governance issue.

## Verification Baseline

For Rust engine work, run the strongest reasonable subset:

```bash
cargo fmt --all --check
cargo check --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

If a command cannot be run, say why in the PR and in your final message.

For governance/workflow work, additionally validate affected YAML/JSON and
event-system invariants locally when possible.

## Review Protocol

When implementation is complete:

1. Ensure the branch is pushed.
2. Ensure tests/checks are reported.
3. Request review through the workflow described in
   `.agents/docs/AGENT_WORKFLOW.md`.

`REVIEW` agents must:

- use `.agents/docs/REVIEW_CHECKLIST.md`
- not be the implementation author
- review bugs, architecture violations, determinism, tests, and scope
- leave a clear approve or needs-fixes decision

`ARCHITECT` agents are final merge authority only when the task is `APPROVED`
and CI is green.

## Parallel Agent Safety

Multiple agents may work at the same time if all of this is true:

- each agent has a different task ID
- each agent has its own branch
- each agent has its own PR declaration
- no agent edits generated state by hand
- all agents re-read `registry.json` after pulling latest `main`

If two agents collide on one task, the registry wins. The losing agent must stop
or choose a different `TODO` task.

## Default Agent Startup Response

When you receive this onboarding, respond with:

```text
Loaded NOVA 2.5 onboarding.

I will now:
1. Read constraints, roles, bootstrap, registry, and transitions.
2. Select or verify one TODO task.
3. Declare one role and one model.
4. Create a task branch.
5. Open a draft PR with the required declaration.
6. Work only inside that task scope.
7. Run verification before requesting review.

I will not edit TASK_EVENTS.jsonl, registry.json, snapshots, or transition rules
unless the task is explicitly a governance task and the workflow permits it.
```

Then perform the reads and continue.

## Stop Conditions

Stop immediately if:

- `TASK_EVENTS.jsonl`, `transitions.yaml`, and `registry.json` disagree
- the task does not exist in `registry.json`
- the task is locked by another agent
- the task is terminal
- your role is not allowed for the next transition
- CI or local validation shows unverifiable state
- the requested work requires changing governance rules without an explicit
  governance task

Do not guess. Do not invent local truth. Do not continue on inconsistent state.
