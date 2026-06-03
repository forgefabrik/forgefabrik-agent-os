#!/usr/bin/env bash
# show.sh — Display inbox, outbox, or both
# Decision Fabric message stream | decision/
#
# Usage:
#   ./cli/show.sh                  → both inbox + outbox, compact view
#   ./cli/show.sh --inbox          → inbox only
#   ./cli/show.sh --outbox         → outbox only
#   ./cli/show.sh --topic "Axiom"  → filter entries by topic substring
#   ./cli/show.sh --raw            → raw file dump, no formatting
#   ./cli/show.sh --tail 5         → last 5 entries (combined)
#   ./cli/show.sh --stats          → thread statistics from meta.json
#   ./cli/show.sh --json           → all entries as JSON (pipe-friendly)
#   ./cli/show.sh --json --inbox   → inbox entries only as JSON
#
# Boundary: this script NEVER touches TASK_EVENTS.jsonl or registry.json.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
INBOX="$COMM_DIR/core/inbox.md"
OUTBOX="$COMM_DIR/core/outbox.md"
META="$COMM_DIR/core/meta.json"

# ── argument parsing ─────────────────────────────────────────────────────────
MODE="all"
TOPIC_FILTER=""
TAIL_N=0
RAW=false
STATS=false
JSON=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --inbox)   MODE="inbox"         ; shift ;;
    --outbox)  MODE="outbox"        ; shift ;;
    --topic)   TOPIC_FILTER="${2:-}"; shift 2 ;;
    --tail)    TAIL_N="${2:-0}"     ; shift 2 ;;
    --raw)     RAW=true             ; shift ;;
    --stats)   STATS=true           ; shift ;;
    --json)    JSON=true            ; shift ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# *//'
      exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

# ── stats mode ───────────────────────────────────────────────────────────────
if $STATS; then
  if ! command -v python3 &>/dev/null; then
    echo "Error: python3 required for --stats" >&2
    exit 1
  fi
  python3 - "$INBOX" "$OUTBOX" "$META" <<'PYEOF'
import json, sys, os, re

inbox_path, outbox_path, meta_path = sys.argv[1], sys.argv[2], sys.argv[3]

def count_entries(path):
    if not os.path.exists(path):
        return 0
    content = open(path, encoding='utf-8').read()
    # Count +++ markers: each entry has exactly two +++ lines
    parts = content.split('\n+++\n')
    # [preamble, fm1, body1, fm2, body2, ...]
    # entries = (len(parts) - 1) // 2
    return max(0, (len(parts) - 1) // 2)

inbox_count  = count_entries(inbox_path)
outbox_count = count_entries(outbox_path)

meta = {}
if os.path.exists(meta_path):
    try:
        meta = json.loads(open(meta_path, encoding='utf-8').read())
    except Exception:
        pass

threads  = meta.get('threads', {})
last_ref = meta.get('last_ref', '—')

print(f"{'COMMUNICATION LAYER STATS':}")
print(f"{'─' * 40}")
print(f"  Inbox messages : {inbox_count}")
print(f"  Outbox messages: {outbox_count}")
print(f"  Total messages : {inbox_count + outbox_count}")
print(f"  Threads        : {len(threads)}")
print(f"  Last activity  : {last_ref}")

if threads:
    print()
    print(f"  {'THREAD':<44}  IN  OUT  TOTAL")
    print(f"  {'─' * 58}")
    for topic, t in threads.items():
        has_in  = 1 if t.get('last_user') else 0
        has_out = 1 if t.get('last_ai')   else 0
        total   = t.get('count', has_in + has_out)
        short   = topic[:44] if len(topic) > 44 else topic
        print(f"  {short:<44}  {has_in:>2}  {has_out:>3}  {total:>5}")
PYEOF
  exit 0
fi

# ── json mode ─────────────────────────────────────────────────────────────────
if $JSON; then
  if ! command -v python3 &>/dev/null; then
    echo "Error: python3 required for --json" >&2
    exit 1
  fi
  python3 - "$INBOX" "$OUTBOX" "$MODE" "$TOPIC_FILTER" <<'PYEOF'
import json, sys, os, re

inbox_path, outbox_path, mode, topic_filter = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
FM_LINE = re.compile(r'^(\w+):\s*(.+)$', re.MULTILINE)

def parse_file(path):
    if not os.path.exists(path):
        return []
    content = open(path, encoding='utf-8').read()
    parts   = content.split('\n+++\n')
    entries = []
    i = 1
    while i < len(parts) - 1:
        fm_raw = parts[i]
        body   = parts[i + 1].strip()
        i += 2
        fm = {m.group(1): m.group(2) for m in FM_LINE.finditer(fm_raw)}
        if not fm.get('role') or not fm.get('ref'):
            continue
        if topic_filter and topic_filter.lower() not in fm.get('topic', '').lower():
            continue
        entries.append({
            'topic':     fm.get('topic', ''),
            'timestamp': fm.get('timestamp', ''),
            'ref':       fm.get('ref', ''),
            'role':      fm.get('role', ''),
            'reply_to':  fm.get('reply_to'),
            'legacy':    fm.get('legacy', 'false').lower() == 'true',
            'text':      body,
        })
    return entries

result = {}
if mode != 'outbox':
    result['inbox']  = parse_file(inbox_path)
if mode != 'inbox':
    result['outbox'] = parse_file(outbox_path)

print(json.dumps(result, ensure_ascii=False, indent=2))
PYEOF
  exit 0
fi

# ── raw mode ─────────────────────────────────────────────────────────────────
if $RAW; then
  [[ "$MODE" != "outbox" && -f "$INBOX"  ]] && cat "$INBOX"
  [[ "$MODE" != "inbox"  && -f "$OUTBOX" ]] && cat "$OUTBOX"
  exit 0
fi

# ── awk entry parser ─────────────────────────────────────────────────────────
# Prints compact one-block summary per entry:
#   [ROLE] ref | TOPIC
#   preview of first line of body...
parse_file() {
  local file="$1"
  local filter="$2"
  [[ ! -f "$file" ]] && return

  awk -v filter="$filter" '
  function flush(    preview) {
    if (role == "") return
    if (filter != "" && index(topic, filter) == 0) {
      reset(); return
    }
    preview = body
    sub(/\n.*/, "", preview)          # first line only
    sub(/^[ \t]+/, "", preview)       # strip leading whitespace
    if (length(preview) > 72) preview = substr(preview, 1, 72) "…"
    printf "[%s] %s\n  %s\n  %s\n\n", toupper(role), ref, topic, preview
    reset()
  }
  function reset() { role=""; topic=""; ref=""; reply_to=""; body=""; state=1 }
  BEGIN  { state=0; role=""; topic=""; ref=""; reply_to=""; body="" }
  /^\+\+\+$/ {
    if      (state == 0) { state = 1 }            # enter first frontmatter
    else if (state == 1) { state = 2 }            # close frontmatter, enter body
    else if (state == 2) { flush(); state = 1 }   # new entry, flush previous
    next
  }
  state == 1 {
    if      (/^topic: /)    topic    = substr($0, 8)
    else if (/^ref: /)      ref      = substr($0, 6)
    else if (/^role: /)     role     = substr($0, 7)
    else if (/^reply_to: /) reply_to = substr($0, 11)
    next
  }
  state == 2 { body = body $0 "\n"; next }
  END { flush() }
  ' "$file"
}

# ── header line ──────────────────────────────────────────────────────────────
hr() { printf '%.0s─' {1..60}; printf '\n'; }

OUTPUT=""

if [[ "$MODE" != "outbox" ]]; then
  OUTPUT+="$(printf '\n'; hr; echo '  INBOX'; hr; parse_file "$INBOX" "$TOPIC_FILTER")"
fi
if [[ "$MODE" != "inbox" ]]; then
  OUTPUT+="$(printf '\n'; hr; echo '  OUTBOX'; hr; parse_file "$OUTBOX" "$TOPIC_FILTER")"
fi

# ── tail filter ───────────────────────────────────────────────────────────────
if [[ "$TAIL_N" -gt 0 ]]; then
  # count entries (separated by blank lines after content), naive tail
  echo "$OUTPUT" | grep -E '^\[(USER|AI)\]' | tail -n "$TAIL_N"
else
  echo "$OUTPUT"
fi
