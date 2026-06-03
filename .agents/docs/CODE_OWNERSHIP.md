# Code Ownership

Ownership is NOT static.

It is derived from task state.

---

## Source of Truth

Ownership is determined by:

- implementation_lock.agent
- review_lock.agent
- task status in registry.json

---

## Rule

No file-based ownership mapping exists.

All ownership is runtime-derived.
