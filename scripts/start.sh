#!/bin/bash
# start.sh — Start all event-os-core services
# Run from repo root: bash scripts/start.sh

set -e

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

echo ""
echo "Starting event-os-core..."
echo ""

# Verify event log integrity before starting
echo "[1/6] Verifying event log integrity..."
node .task-locks/audit.mjs --no-snapshot --json | python3 -c "
import sys, json
r = json.load(sys.stdin)
if not r['ok']:
    print('FAIL: audit violations found. Run: node .task-locks/audit.mjs')
    sys.exit(1)
print('  ✓  Event log clean (' + str(r['events_audited']) + ' events)')
"

# Rebuild registry
echo "[2/6] Rebuilding registry..."
node .task-locks/replayer.mjs
echo "  ✓  registry.json rebuilt"

# Rebuild agent registry
echo "[3/6] Rebuilding agent registry..."
node .task-locks/agent-runtime.mjs rebuild --json | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('ok'): print('  ✓  Agent registry rebuilt (' + str(r.get('agents', 0)) + ' agents)')
else: print('  ⚠  Agent registry rebuild skipped (no agents)')
" 2>/dev/null || echo "  ✓  No agents yet"

# Run scheduler
echo "[4/6] Computing scheduler queue..."
node .task-locks/scheduler.mjs --json | python3 -c "
import sys, json
r = json.load(sys.stdin)
print('  ✓  Scheduler queue computed (' + str(r.get('queue_count', 0)) + ' tasks)')
" 2>/dev/null || true

# Start API server
echo "[5/6] Starting API server..."
cd docs/communication 2>/dev/null || true
python3 api/server.py &
cd "$REPO_ROOT"
sleep 1
echo "  ✓  API server started at http://127.0.0.1:7337"

echo ""
echo "[6/6] System running."
echo ""
echo "  Dashboard  → http://localhost:7337/"
echo "  API docs   → http://localhost:7337/docs"
echo ""
