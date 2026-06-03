# Execution Model

## How a Task Progresses

```
TODO
 └─ IMPLEMENTATION claims → IN_PROGRESS
     ├─ sends HEARTBEAT (extends lock)
     ├─ requests REFACTOR → REFACTOR_CLAIMED → back to REVIEW_LOCKED
     ├─ requests REVIEW → REVIEW_LOCKED
     │   ├─ REVIEW approves → APPROVED
     │   │   └─ ARCHITECT merges → MERGED  (terminal)
     │   └─ REVIEW rejects → IN_PROGRESS (lock restored)
     └─ lock expires → EXPIRED  (terminal)
```

All state changes happen through events. All events are recorded by CI.

---

## Locks

`implementation_lock` and `review_lock` are fields in `registry.json`.
They record which agent holds current responsibility for a task.

Locks have a TTL. The default is defined in `.task-locks/transitions.yaml`
(`ttl_seconds` per event type). If a lock expires, the task becomes `EXPIRED`.

Locks are NOT files. Do not create lock files anywhere in the repository.

---

## Heartbeat

If your work will take longer than the lock TTL (default 6 hours), send a
heartbeat before it expires. Post the keyword `HEARTBEAT` as a PR comment.
CI records a `TASK_HEARTBEAT` event and extends the lock.

---

## Expired Tasks

An expired task cannot be reclaimed directly. It requires a fork.
Only the ARCHITECT role can issue a `TASK_FORKED` event.
Forks follow the canonical suffix rule: `TASK-0042` → `TASK-0042-a`.
Nested forks (`TASK-0042-a-a`) are forbidden.

---

## What CI Does (Summary)

1. Parses your PR declaration (role, task ID, model).
2. Validates against `registry.json` and `.task-locks/transitions.yaml`.
3. Records the appropriate event to `TASK_EVENTS.jsonl`.
4. Rebuilds `registry.json` from the event log.

You do not trigger this manually. Opening or merging a PR triggers it.
