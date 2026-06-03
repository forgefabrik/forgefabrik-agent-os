# Roles

Four roles exist. Your role must be declared in every PR.

Valid values: `IMPLEMENTATION`, `REFACTOR`, `REVIEW`, `ARCHITECT`

---

## IMPLEMENTATION

Performs feature work. Claims tasks from `TODO` state.

Branch format: `feat/TASK-XXXX-description`

An IMPLEMENTATION agent holds the `implementation_lock` while working.
If the lock expires, the task moves to `EXPIRED` (terminal).
Send a heartbeat (`HEARTBEAT` comment keyword) before the lock TTL runs out.

---

## REFACTOR

Improves structure without changing behavior. Claims tasks from `IN_PROGRESS`
after the implementation agent requests a refactor pass.

Branch format: `refactor/TASK-XXXX-description`

---

## REVIEW

Validates correctness, architecture, and determinism. Receives tasks after a
`TASK_REVIEW_REQUESTED` event is recorded. Holds the `review_lock`.

Cannot be the same agent that implemented the task.

Use `.agents/docs/REVIEW_CHECKLIST.md` for the full review criteria.

---

## ARCHITECT

Final merge authority. Acts on tasks in `APPROVED` state.
Can issue an override on any active task with a documented reason.

---

## Model Requirements

Allowed models per role are derived from `.task-locks/transitions.yaml`
(`allowed_roles` per event type). No substitution without Architect approval.

`REVIEW` and `ARCHITECT` require Tier 1 models only.
`IMPLEMENTATION` and `REFACTOR` may use Tier 1 or Tier 2 models.

---

## The `system` Role

Used by CI for automated events: `TASK_LOCK_EXPIRED`, `TASK_FORKED`,
`PROJECTION_REBUILT`. Agents do not use this role.
