# NOVA 2.5 — Onboarding

This is the single human entry point for the system.

## System Model

The system is event-sourced and deterministic.

There are exactly three authoritative truth layers:

1. TASK_EVENTS.jsonl
   - immutable event log
   - source of truth for history
   - append-only, every line is one event

2. .task-locks/transitions.yaml
   - deterministic state rules
   - source of truth for allowed transitions

3. .task-locks/registry.json
   - derived projection
   - read-only current state snapshot
   - rebuilt by CI from TASK_EVENTS.jsonl via replayer.mjs

Everything else is documentation, interface, tooling, or generated view.

`docs/ROADMAP.md` is generated from `.task-locks/registry.json`. Do not edit it
by hand.

Documentation may be updated when work changes what humans or agents need to
know:

- `docs/ARCHITECTURE_PRINCIPLES.md` for stable architecture principles
- `.agents/docs/` for agent workflow and governance guidance

Documentation is descriptive only. It never claims work, assigns ownership,
defines locks, or changes transition rules.

## Core Rules

- State is never edited directly.
- Events are appended only — and only through event-writer.mjs.
- Transition rules live only in transitions.yaml.
- registry.json is derived only — rebuilt by replayer.mjs.
- docs/ROADMAP.md is derived only.
- Markdown files are never authoritative.

## LLM Boundary

Default local TAP model:

`Qwen3-Zero-Coder-Reasoning-V2-0.8B-NEO-EX-IQ4_XS`

Optional exploration model:

`Qwen3-Zero-Coder-Reasoning-V2-0.8B-NEO-EX-IQ3_M`

The LLM is a planning-only layer. It may normalize ideas, propose
architectures, explain decisions, and normalize bid intent. It must never be
used as authority for scheduler scoring, bridge validation, lease commits,
direct task creation, or direct `TASK_EVENTS.jsonl` writes.

If an output must be replayable, the deterministic engine must produce it.

## Mailbox Role Routing

The mailbox is append-only communication memory. It is not an authority layer.

Mailbox entries use two separate role fields:

- `role`: message direction, either `user` or `ai`.
- `agent_role`: intended audience or context role:
  `IMPLEMENTATION`, `REFACTOR`, `REVIEW`, `ARCHITECT`, `system`, or
  `unassigned`.

Use `agent_role=REVIEW` when asking for reviewer-oriented analysis. Use
`agent_role=ARCHITECT` when asking for architecture or final-governance
judgment. This does not claim a task, create a lock, approve work, or change
the event log. It only helps humans and agents understand who the message is
for.

## Integrity Tool Chain

The following tools form the validated event-log lifecycle. All live in
`.task-locks/`:

### audit.mjs — hash chain verifier
Reads TASK_EVENTS.jsonl and verifies every event:
- JSON parseable
- event_index sequential (no gaps)
- prev_event_hash chain intact
- event_hash recomputed correctly (SHA-256 of canonical core + prev hash)
- per-type required fields present (mirrors event.schema.json allOf)
- genesis_hash in snapshot_0.json verified

```bash
node .task-locks/audit.mjs            # human-readable
node .task-locks/audit.mjs --json     # JSON output for CI
node .task-locks/audit.mjs --verbose  # one line per event
```

Exit 0 = clean. Exit 1 = violations found.

### replayer.mjs — deterministic state rebuilder
Replays TASK_EVENTS.jsonl from genesis through transitions.yaml and writes
registry.json. Pure function: same input always yields the same output.

```bash
node .task-locks/replayer.mjs          # rebuild registry.json
node .task-locks/replayer.mjs --verify # check if registry.json is current
node .task-locks/replayer.mjs --dry-run # print to stdout, no write
```

### event-writer.mjs — ONLY authorized write path
The single validated entry point for appending to TASK_EVENTS.jsonl.
Validates payload, acquires file lock, computes event_index + prev_event_hash
+ event_hash, appends atomically, releases lock.

```bash
echo '{"event_type":"PROJECTION_REBUILT","engine_version":1,...}' \
  | node .task-locks/event-writer.mjs --json

node .task-locks/event-writer.mjs --event /tmp/ev.json --rebuild
node .task-locks/event-writer.mjs --event /tmp/ev.json --dry-run
```

**Never write to TASK_EVENTS.jsonl by any other means.**

### snapshot-writer.mjs — checkpoint creator
Runs audit + replayer verification, writes snapshots/snapshot_N.json,
appends a SNAPSHOT_CREATED event to TASK_EVENTS.jsonl.

```bash
node .task-locks/snapshot-writer.mjs --timestamp 2026-06-03T12:00:00Z
node .task-locks/snapshot-writer.mjs --dry-run
```

### Hash algorithm (verified, immutable)
```
event_hash = SHA-256(
  JSON.stringify(sortedKeys(event minus event_hash minus prev_event_hash))
  + prev_event_hash_value
)

genesis_hash = SHA-256(JSON.stringify(sortedKeys(genesis.json)))
  = 1eb7528ebb64a57fb9b8b567bc9b613911aa3c213e7aaf731ce3fbdc77584eb1
```

Both algorithms are documented in `.task-locks/event.schema.json`
(`$comment` and `event_hash` description fields).

## Agent Workflow

1. Read the truth layers.
2. Resolve role.
3. Bind to task.
4. Check lock state.
5. Execute only allowed actions.
6. Emit events through event-writer.mjs (or the FastAPI gate POST /events/write).
7. Rebuild projection with replayer.mjs after writing.

## Allowed Roles

- IMPLEMENTATION
- REFACTOR
- REVIEW
- ARCHITECT

## Forbidden Actions

- editing registry.json by hand
- editing TASK_EVENTS.jsonl by hand or directly (use event-writer.mjs)
- defining state logic outside transitions.yaml
- using Markdown as a source of truth
- creating parallel assignment systems
- creating parallel lock systems
- calling event-writer.mjs --no-lock outside of CI retry loops

## Human Guidance

Use this file to understand the system at a high level.

Use `.task-locks/registry.json` to see current state.

Use `.task-locks/transitions.yaml` to understand allowed transitions.

Use `TASK_EVENTS.jsonl` to inspect history.

Run `node .task-locks/audit.mjs` to verify chain integrity at any time.

## Mental Model

```
Events → event-writer.mjs → TASK_EVENTS.jsonl
                                    ↓
                 replayer.mjs (transitions.yaml)
                                    ↓
                          registry.json
                                    ↓
               roadmap-projection.mjs → docs/ROADMAP.md
```

No other model is valid.
