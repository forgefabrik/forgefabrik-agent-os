## Agent Declaration (MANDATORY)

Role: IMPLEMENTATION | REFACTOR | REVIEW | ARCHITECT
Task ID: TASK-XXXX
Model: <model name>

Branch must follow:
feat/TASK-XXXX-description

---

## Rules

- No TASK_LOCKS.md exists anymore
- All validation is performed against registry.json
- All transitions are governed by transitions.yaml
- Task state is not claimed in this PR — it is validated

---

## Hard Requirements

- Role must be declared
- Task ID must exist in registry.json
- Model must be approved for role
- Branch must include Task ID
