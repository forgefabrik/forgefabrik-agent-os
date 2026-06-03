#!/usr/bin/env bash
# reply.sh — Write an AI response to core/outbox.md
# Decision Fabric message stream | decision/
#
# Usage (pipe only — no interactive mode for AI output):
#   echo "response" | ./cli/reply.sh "Topic" "ref:2026-06-10|14:32:07"
#   cat response.md | ./cli/reply.sh "Topic" "2026-06-10|14:32:07"
#   ./cli/reply.sh --show
#
# Returns: own ref timestamp (usable as reply_to for follow-up references)
#
# Boundary: this script NEVER touches TASK_EVENTS.jsonl or registry.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUTBOX="$COMM_DIR/core/outbox.md"
META="$COMM_DIR/core/meta.json"

# ── show mode ───────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--show" ]]; then
  if [[ ! -f "$OUTBOX" ]]; then
    echo "outbox.md does not exist yet: $OUTBOX" >&2
    exit 1
  fi
  cat "$OUTBOX"
  exit 0
fi

# ── arguments ───────────────────────────────────────────────────────────────
TOPIC="${1:-}"
REPLY_TO="${2:-}"

if [[ -z "$TOPIC" ]]; then
  echo "Error: topic is required." >&2
  echo "Usage: echo 'text' | ./cli/reply.sh 'Topic' 'ref:YYYY-MM-DD|HH:MM:SS'" >&2
  exit 1
fi

if [[ -z "$REPLY_TO" ]]; then
  echo "Error: reply_to ref is required." >&2
  echo "Usage: echo 'text' | ./cli/reply.sh 'Topic' 'ref:YYYY-MM-DD|HH:MM:SS'" >&2
  exit 1
fi

# Normalize ref: strip leading "ref:" if present
REPLY_TO="${REPLY_TO#ref:}"

# ── text from stdin (no interactive mode — pipe only) ───────────────────────
if [[ -t 0 ]]; then
  echo "Error: reply.sh expects stdin input (pipe mode only)." >&2
  echo "Example: echo 'response' | ./cli/reply.sh 'Topic' 'ref:2026-06-10|14:32:07'" >&2
  exit 1
fi

TEXT="$(cat)"

if [[ -z "$TEXT" ]]; then
  echo "Error: no text on stdin." >&2
  exit 1
fi

# ── timestamps ──────────────────────────────────────────────────────────────
ISO="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
REF="$(date -u '+%Y-%m-%d|%H:%M:%S')"

# ── ensure core/ exists ─────────────────────────────────────────────────────
mkdir -p "$(dirname "$OUTBOX")"

# ── append entry ────────────────────────────────────────────────────────────
{
  printf "\n+++\n"
  printf "topic: %s\n" "$TOPIC"
  printf "timestamp: %s\n" "$ISO"
  printf "ref: %s\n" "$REF"
  printf "reply_to: %s\n" "$REPLY_TO"
  printf "role: ai\n"
  printf "+++\n\n"
  printf "%s\n" "$TEXT"
} >> "$OUTBOX"

# ── update meta.json (best-effort) ──────────────────────────────────────────
if command -v python3 &>/dev/null && [[ -f "$META" ]]; then
  python3 - "$META" "$TOPIC" "ai" "$REF" <<'PYEOF'
import json, sys
meta_file, topic, role, ref = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    data = json.loads(open(meta_file).read())
except Exception:
    data = {"schema_version": "2.0", "last_ref": None, "threads": {}}
data["last_ref"] = ref
t = data.setdefault("threads", {}).setdefault(topic, {"last_user": None, "last_ai": None, "count": 0})
t["last_" + role] = ref
t["count"] = t.get("count", 0) + 1
open(meta_file, "w").write(json.dumps(data, ensure_ascii=False, indent=2))
PYEOF
fi

# ── return own ref ───────────────────────────────────────────────────────────
printf "ref:%s\n" "$REF"
