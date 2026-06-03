# Contribution Protocol (Event Sourced)

## System Model

All contributions are events.

No direct state mutation exists.

---

## Valid Contribution Flow

1. Agent performs action
2. CI writes event to TASK_EVENTS.jsonl
3. Projection builder rebuilds registry.json
4. CI validates consistency

---

## Documentation Maintenance And Views

Agents should update documentation when their change alters what future humans
or agents need to know.

Use:

- `docs/ARCHITECTURE_PRINCIPLES.md` for stable architecture principles.
- `.agents/docs/` for agent workflow, review criteria, ownership rules, and
  contribution protocol.

Do not edit `docs/ROADMAP.md` by hand. It is a generated view of
`.task-locks/registry.json`.

Documentation updates are descriptive only. They do not claim tasks, assign
ownership, define locks, or change transitions.

---

## Commit Policy

Commit messages are linted only.
They are NOT part of system state.

---

## Authority

- events = truth
- transitions.yaml = rules
- registry.json = projection
- ROADMAP.md = generated view
- other docs = explanation
