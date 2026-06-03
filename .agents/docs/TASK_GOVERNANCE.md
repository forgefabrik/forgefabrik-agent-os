# TASK_GOVERNANCE.md — Lock System Reference

This document is a read-only reference. It has no authority over task state.

## Where Task State Actually Lives

| What you want | Where it actually is |
|---------------|---------------------|
| Current task status | `.task-locks/registry.json` |
| State transition rules | `.task-locks/transitions.yaml` |
| Full task history | `TASK_EVENTS.jsonl` |

No Markdown file is ever read as input to CI or state derivation.

## For Humans

See `ONBOARDING.md` for the human entry point and `.agents/onboarding.md`
for the agent entry sequence.
