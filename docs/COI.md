# Cybernetic Operations Interface

The default Event OS UI is the Cybernetic Operations Interface (COI), served by
the Decision Fabric API from `decision/ui/dashboard.html`.

```bash
cd decision
python api/server.py
```

Open:

```text
http://localhost:7337/
```

## Control Model

```text
EVENTS = HISTORY LAYER
DECISIONS = ACTIVE CONTROL LAYER
REPLAY = VERIFICATION LAYER
UI = CYBERNETIC CONTROL PLANE
```

## UI Modules

- Decision Stream: live SSE-backed event fabric view.
- Control Tactics: decision-cycle execution and queue inspection.
- State Intelligence: registry, leases, agents, trust, and snapshot hashes.
- TAP OS Console: simulation, explanation, replay targeting, and DSE prompts.

## Compatibility

`.task-locks/decision_engine.mjs` is the public decision engine entrypoint. It
currently wraps `.task-locks/scheduler.mjs` while scheduler-named artifacts
migrate to decision terminology.
