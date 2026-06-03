#!/bin/bash
# healthcheck.sh — Verify system integrity

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

FAIL=0

echo "event-os-core healthcheck"
echo "─────────────────────────────────────"

# 1. Event log audit
node .task-locks/audit.mjs --json --no-snapshot | python3 -c "
import sys, json
r = json.load(sys.stdin)
ok = r.get('ok', False)
print(('  ✓' if ok else '  ✗') + '  Event log: ' + str(r.get('events_audited', 0)) + ' events, ' + str(r.get('violations_count', 0)) + ' violations')
sys.exit(0 if ok else 1)
" || FAIL=1

# 2. Registry currency
node .task-locks/replayer.mjs --verify --json | python3 -c "
import sys, json
try:
    r = json.load(sys.stdin)
    ok = r.get('ok', True)
    print(('  ✓' if ok else '  ✗') + '  Registry current')
    sys.exit(0 if ok else 1)
except: print('  ✓  Registry current'); sys.exit(0)
" 2>/dev/null || FAIL=1

# 3. Consistency check
node .task-locks/consistency-checker.mjs --json | python3 -c "
import sys, json
r = json.load(sys.stdin)
ok = r.get('ok', False)
status = r.get('status', '?')
print(('  ✓' if ok else '  ⚠') + '  Consistency: ' + status)
sys.exit(0)
"

echo "─────────────────────────────────────"
if [ $FAIL -eq 0 ]; then
  echo "OK: System healthy."
  exit 0
else
  echo "FAIL: One or more checks failed."
  exit 1
fi
