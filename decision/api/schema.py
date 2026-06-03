"""
schema.py - Message validation models for the Decision Fabric API.

Entry format used in core/inbox.md and core/outbox.md:

    +++
    topic: <string>
    timestamp: <ISO-8601 UTC>
    ref: <YYYY-MM-DD|HH:MM:SS>
    role: user | ai
    agent_role: IMPLEMENTATION | REFACTOR | REVIEW | ARCHITECT | system | unassigned
    reply_to: <ref>          # ai entries only
    +++

    <body text>
"""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, field_validator

# Key: value inside a frontmatter block
_FM_LINE = re.compile(r"^(\w+):\s*(.+)$", re.MULTILINE)


# ---------------------------------------------------------------------------
# Inbound request models (API → server)
# ---------------------------------------------------------------------------


class UserMessage(BaseModel):
    """Payload for POST /user — writes an entry to core/inbox.md."""

    topic: str
    text: str
    agent_role: str = "unassigned"

    @field_validator("topic", "text", "agent_role")
    @classmethod
    def not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field must not be empty.")
        return v.strip()


class AIMessage(BaseModel):
    """Payload for POST /ai — writes an entry to core/outbox.md."""

    topic: str
    text: str
    reply_to: str  # ref of the inbox.md entry this answers
    agent_role: str = "unassigned"

    @field_validator("topic", "text", "reply_to", "agent_role")
    @classmethod
    def not_empty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Field must not be empty.")
        return v.strip()


# ---------------------------------------------------------------------------
# Outbound response models (server → client)
# ---------------------------------------------------------------------------


class MessageEntry(BaseModel):
    """A single parsed entry from inbox.md or outbox.md."""

    topic: str
    timestamp: str
    ref: str
    role: str                     # "user" | "ai"
    agent_role: str = "unassigned"
    reply_to: Optional[str]       # ai entries only
    legacy: bool = False
    text: str


# ---------------------------------------------------------------------------
# Frontmatter parser
# ---------------------------------------------------------------------------


def _parse_frontmatter(block: str) -> dict[str, str]:
    """Parse a YAML-like frontmatter string into a plain dict."""
    result: dict[str, str] = {}
    for m in _FM_LINE.finditer(block):
        result[m.group(1).strip()] = m.group(2).strip()
    return result


def parse_entries(path_content: str) -> list[MessageEntry]:
    """
    Parse all entries from an inbox.md or outbox.md file.

    Each entry is bracketed by +++ markers:

        +++
        key: value
        +++

        body text

    Lines before the first +++ block (file header comments) are ignored.
    """
    # Split on the entry separator "\n+++\n".
    # Result: [preamble, fm1, body1, fm2, body2, ...]
    parts = path_content.split("\n+++\n")

    entries: list[MessageEntry] = []

    # parts[0] is the file header — skip it.
    # Subsequent parts alternate: frontmatter, body.
    i = 1
    while i < len(parts) - 1:
        fm_raw = parts[i]
        body   = parts[i + 1].strip()
        i += 2

        fm = _parse_frontmatter(fm_raw)
        if not fm.get("role") or not fm.get("ref"):
            continue  # skip malformed or header-only blocks

        entries.append(
            MessageEntry(
                topic=fm.get("topic", ""),
                timestamp=fm.get("timestamp", ""),
                ref=fm.get("ref", ""),
                role=fm.get("role", ""),
                agent_role=fm.get("agent_role", "unassigned"),
                reply_to=fm.get("reply_to"),
                legacy=fm.get("legacy", "false").lower() == "true",
                text=body,
            )
        )

    return entries


# ---------------------------------------------------------------------------
# Frontmatter writer
# ---------------------------------------------------------------------------


def now_ref() -> tuple[str, str]:
    """Return (ISO timestamp, ref key) for the current UTC moment."""
    now = datetime.now(timezone.utc)
    iso = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    ref = now.strftime("%Y-%m-%d|%H:%M:%S")
    return iso, ref


def build_entry(fm: dict[str, str], body: str) -> str:
    """Serialise a frontmatter dict + body into the +++ format."""
    fm_lines = "\n".join(f"{k}: {v}" for k, v in fm.items() if v)
    return f"\n+++\n{fm_lines}\n+++\n\n{body}\n"
