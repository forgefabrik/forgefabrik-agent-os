# Agent Constraints

This file defines behavior constraints only.

It does not define state, workflow logic, task ownership, lock rules, or transitions.

## Allowed Behavior

- read the truth layers
- respect role boundaries
- respect lock boundaries
- operate only on the assigned task
- verify `docs/ROADMAP.md` matches the registry projection when reviewing or merging
- update `.agents/docs/` when agent workflow or governance guidance changes
- emit events only through the approved system path:
  `.task-locks/event-writer.mjs` (CLI/CI) or
  `POST /events/write` (HTTP gate → event-writer.mjs)
- fail fast on inconsistencies

## Forbidden Behavior

- creating local task lists
- creating local lock rules
- creating local transition logic
- editing registry.json directly
- editing TASK_EVENTS.jsonl directly (must use event-writer.mjs)
- editing docs/ROADMAP.md directly
- treating docs as authority
- using docs updates as task claims, lock claims, or transition changes
- using cached assumptions as truth
- inferring new rules from prose

## Safety Rule

If the agent cannot verify a state from the truth layers, it must stop.

Do not guess.

## Consistency Rule

If the agent sees a mismatch between:
- TASK_EVENTS.jsonl
- transitions.yaml
- registry.json

then the system is inconsistent and must be rejected.

## Scope Rule

The agent only acts inside its declared role and task scope.

No broad-system behavior is allowed unless explicitly granted by the authoritative transition rules.
