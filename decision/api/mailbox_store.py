"""
mailbox_store.py - SQLite-backed mailbox memory for the COI.

The Markdown inbox/outbox files are treated as legacy import sources. Runtime
reads and writes go through SQLite so long exchanges stay searchable,
timestamped, and role-addressable without turning giant text files into the
working data store.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from .schema import MessageEntry, parse_entries

_DB: Path | None = None
_INBOX: Path | None = None
_OUTBOX: Path | None = None


def configure(db_path: Path, inbox: Path, outbox: Path) -> None:
    global _DB, _INBOX, _OUTBOX
    _DB = db_path
    _INBOX = inbox
    _OUTBOX = outbox
    init_db()


def _db() -> Path:
    if _DB is None:
        raise RuntimeError("mailbox_store.configure() not called")
    return _DB


def connect() -> sqlite3.Connection:
    path = _db()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              topic TEXT NOT NULL,
              timestamp TEXT NOT NULL,
              ref TEXT NOT NULL UNIQUE,
              role TEXT NOT NULL CHECK(role IN ('user', 'ai')),
              agent_role TEXT NOT NULL DEFAULT 'unassigned',
              reply_to TEXT,
              legacy INTEGER NOT NULL DEFAULT 0,
              text TEXT NOT NULL,
              created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_ref ON messages(ref)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_messages_agent_role ON messages(agent_role)")
        conn.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS message_fts
            USING fts5(topic, text, agent_role, content='messages', content_rowid='id')
            """
        )
        conn.execute(
            """
            CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
              INSERT INTO message_fts(rowid, topic, text, agent_role)
              VALUES (new.id, new.topic, new.text, new.agent_role);
            END
            """
        )
        conn.execute(
            """
            CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
              INSERT INTO message_fts(message_fts, rowid, topic, text, agent_role)
              VALUES ('delete', old.id, old.topic, old.text, old.agent_role);
            END
            """
        )
        conn.execute(
            """
            CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
              INSERT INTO message_fts(message_fts, rowid, topic, text, agent_role)
              VALUES ('delete', old.id, old.topic, old.text, old.agent_role);
              INSERT INTO message_fts(rowid, topic, text, agent_role)
              VALUES (new.id, new.topic, new.text, new.agent_role);
            END
            """
        )
    migrate_markdown_once()


def _row_to_entry(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "topic": row["topic"],
        "timestamp": row["timestamp"],
        "ref": row["ref"],
        "role": row["role"],
        "agent_role": row["agent_role"],
        "reply_to": row["reply_to"],
        "legacy": bool(row["legacy"]),
        "text": row["text"],
    }


def _insert_entry(conn: sqlite3.Connection, entry: MessageEntry) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO messages
          (topic, timestamp, ref, role, agent_role, reply_to, legacy, text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry.topic,
            entry.timestamp,
            entry.ref,
            entry.role,
            entry.agent_role or "unassigned",
            entry.reply_to,
            1 if entry.legacy else 0,
            entry.text,
        ),
    )


def migrate_markdown_once() -> None:
    with connect() as conn:
        count = conn.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
        if count:
            return
        for path in (_INBOX, _OUTBOX):
            if path and path.exists():
                for entry in parse_entries(path.read_text(encoding="utf-8")):
                    _insert_entry(conn, entry)


def _now() -> tuple[str, str]:
    now = datetime.now(timezone.utc)
    iso = now.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    ref = now.strftime("%Y-%m-%d|%H:%M:%S.%f")
    return iso, ref


def add_message(
    *,
    topic: str,
    text: str,
    role: str,
    agent_role: str = "unassigned",
    reply_to: Optional[str] = None,
) -> dict[str, Any]:
    iso, ref = _now()
    with connect() as conn:
        conn.execute(
            """
            INSERT INTO messages
              (topic, timestamp, ref, role, agent_role, reply_to, legacy, text)
            VALUES (?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (topic, iso, ref, role, agent_role or "unassigned", reply_to, text),
        )
    return {"status": "ok", "ref": ref, "file": "core/mailbox.sqlite3"}


def inbox() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM messages WHERE role='user' ORDER BY timestamp, id").fetchall()
        return [_row_to_entry(r) for r in rows]


def outbox() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM messages WHERE role='ai' ORDER BY timestamp, id").fetchall()
        return [_row_to_entry(r) for r in rows]


def timeline() -> list[dict[str, Any]]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM messages ORDER BY timestamp, id").fetchall()
        return [_row_to_entry(r) for r in rows]


def stats() -> dict[str, Any]:
    with connect() as conn:
        row = conn.execute(
            """
            SELECT
              SUM(CASE WHEN role='user' THEN 1 ELSE 0 END) AS inbox_count,
              SUM(CASE WHEN role='ai' THEN 1 ELSE 0 END) AS outbox_count,
              COUNT(DISTINCT topic) AS thread_count,
              COUNT(*) AS total_count,
              MAX(ref) AS last_ref
            FROM messages
            """
        ).fetchone()
    inbox_count = int(row["inbox_count"] or 0)
    outbox_count = int(row["outbox_count"] or 0)
    return {
        "inbox_count": inbox_count,
        "outbox_count": outbox_count,
        "total_count": int(row["total_count"] or 0),
        "thread_count": int(row["thread_count"] or 0),
        "last_ref": row["last_ref"],
        "reply_rate": round(outbox_count / inbox_count, 4) if inbox_count else 0.0,
        "axiom_density": 0.0,
    }


def meta() -> dict[str, Any]:
    threads: dict[str, Any] = {}
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT topic, COUNT(*) AS count, MAX(timestamp) AS last_at
            FROM messages
            GROUP BY topic
            ORDER BY last_at DESC
            """
        ).fetchall()
    for row in rows:
        threads[row["topic"]] = {
            "count": row["count"],
            "last_at": row["last_at"],
        }
    return {
        "schema_version": "sqlite-mailbox-v1",
        "last_ref": stats()["last_ref"],
        "threads": threads,
        "storage": "sqlite",
    }


def thread(topic: str) -> dict[str, Any]:
    term = f"%{topic.lower()}%"
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM messages
            WHERE lower(topic) LIKE ?
            ORDER BY timestamp, id
            """,
            (term,),
        ).fetchall()
    messages = [_row_to_entry(r) for r in rows]
    return {"topic": topic, "count": len(messages), "messages": messages}
