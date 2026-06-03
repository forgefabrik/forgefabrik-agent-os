#!/usr/bin/env bash
# send.sh — Write a user message to core/inbox.md
# Decision Fabric message stream | decision/
#
# Usage:
#   ./cli/send.sh "Topic"               → interactive: paste text, Ctrl+D to save
#   echo "text" | ./cli/send.sh "Topic" → pipe mode
#   ./cli/send.sh --show                → print current inbox.md
#
# Returns: ref timestamp (use as reply_to in reply.sh or POST /ai)
#
# Boundary: this script NEVER touches TASK_EVENTS.jsonl or registry.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INBOX="$COMM_DIR/core/inbox.md"
META="$COMM_DIR/core/meta.json"

# ── show mode ───────────────────────────────────────────────────────────────
if [[ "${1:-}" == "--show" ]]; then
  if [[ ! -f "$INBOX" ]]; then
    echo "inbox.md does not exist yet: $INBOX" >&2
    exit 1
  fi
  cat "$INBOX"
  exit 0
fi

# ── topic ───────────────────────────────────────────────────────────────────
TOPIC="${1:-}"
if [[ -z "$TOPIC" ]]; then
  printf "Topic: " >&2
  read -r TOPIC
fi
if [[ -z "$TOPIC" ]]; then
  echo "Error: topic must not be empty." >&2
  exit 1
fi

# ── text from stdin ─────────────────────────────────────────────────────────
if [[ -t 0 ]]; then
  echo "" >&2
  echo "Enter message — Ctrl+D to save:" >&2
  echo "────────────────────────────────" >&2
fi

TEXT="$(cat)"

if [[ -z "$TEXT" ]]; then
  echo "Error: no text provided." >&2
  exit 1
fi

# ── timestamps ──────────────────────────────────────────────────────────────
ISO="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
REF="$(date -u '+%Y-%m-%d|%H:%M:%S')"

# ── ensure core/ exists ─────────────────────────────────────────────────────
mkdir -p "$(dirname "$INBOX")"

# ── append entry ────────────────────────────────────────────────────────────
{
  printf "\n+++\n"
  printf "topic: %s\n" "$TOPIC"
  printf "timestamp: %s\n" "$ISO"
  printf "ref: %s\n" "$REF"
  printf "role: user\n"
  printf "+++\n\n"
  printf "%s\n" "$TEXT"
} >> "$INBOX"

# ── update meta.json (best-effort, no hard failure) ─────────────────────────
if command -v python3 &>/dev/null && [[ -f "$META" ]]; then
  python3 - "$META" "$TOPIC" "user" "$REF" <<'PYEOF'
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

# ── confirmation ─────────────────────────────────────────────────────────────
echo "" >&2
echo "────────────────────────────────" >&2
printf "Saved → %s\n" "$INBOX" >&2
printf "ref:%s\n" "$REF"
