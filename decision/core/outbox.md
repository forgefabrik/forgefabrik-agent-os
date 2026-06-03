# outbox.md — AI Output Log
# Communication Layer v2 | docs/communication/
#
# RULES (append-only — this section never changes)
# ==================================================
# AUTHOR   : only AI (or system processes) write here
# FORMAT   : YAML frontmatter block + body text per entry, separated by +++
# APPEND   : never edit or delete existing entries
# REPLY_TO : every entry must reference an inbox.md entry via reply_to
# NO CI    : this file is outside the Truth Layer (TASK_EVENTS.jsonl)
#            no projection-builder reads here, no transitions depend on this
# ==================================================
#
# ENTRY FORMAT:
#
#   +++
#   topic: <topic string>
#   timestamp: <ISO-8601 UTC>
#   ref: <own timestamp-key>
#   reply_to: <ref of the inbox.md entry this answers>
#   role: ai
#   +++
#
#   <response body>
#
# ==================================================

# ── LEGACY (pre-v2 migration from docs/TALK2AI/MSG4USER.md) ────────────────

# MSG4USER — AI Response Log
# Erstellt: (see docs/TALK2AI/MSG4USER.md for original)
# No AI entries were present in MSG4USER.md at migration time.


