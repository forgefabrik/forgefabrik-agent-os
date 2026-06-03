#!/bin/bash
# tap/run.sh — Run TAP analysis
# Usage: bash tap/run.sh [observe|suggest] [--task TASK-XXXX]

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

MODE="${1:-suggest}"
TASK_ARG="${2:-}"

node tap/tap_engine.mjs --mode "$MODE" $TASK_ARG
