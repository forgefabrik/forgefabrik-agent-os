"""
routes.py - Message endpoints for the Decision Fabric API.

Read architecture:
    All GET endpoints read from the in-memory projection cache
    (api/projection.py).  Zero file I/O per GET request — the Node
    projection engine keeps the cache up to date.

Write architecture:
    POST /user and POST /ai write append-only entries to core/inbox.md
    and core/outbox.md.  The Node projection engine detects the file
    changes (debounced) and rebuilds the projection cache automatically.

SSE:
    GET /events now pushes typed events (thread_update, stats_update,
    full_sync) sourced from core/last_event.json — not a generic ping.

Endpoints
---------
POST /user                  Write a user message → core/inbox.md
POST /ai                    Write an AI response → core/outbox.md
GET  /stream/inbox          All inbox entries (from projection cache)
GET  /stream/outbox         All outbox entries (from projection cache)
GET  /messages              Inbox + outbox combined (from projection cache)
GET  /meta                  Thread metadata (from projection cache)
GET  /stats                 Message counts and last activity (from cache)
GET  /thread/{topic}        All messages for one topic (from cache)
GET  /projection            Full projection.json — for debugging / sync
GET  /events                Typed SSE stream (thread_update | stats_update | full_sync)

Boundary rule: NEVER touches TASK_EVENTS.jsonl, registry.json,
snapshots/, or transitions.yaml.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

try:
    from sse_starlette.sse import EventSourceResponse as _EventSourceResponse
    _SSE_AVAILABLE = True
except ImportError:
    _EventSourceResponse = None  # type: ignore[assignment]
    _SSE_AVAILABLE = False

from .schema import (
    AIMessage,
    MessageEntry,
    UserMessage,
    build_entry,
    now_ref,
)
from . import projection as _proj

log = logging.getLogger("comm.routes")

router = APIRouter(tags=["Messages"])

# File paths — still needed for the append-only POST operations
_INBOX:  Path | None = None
_OUTBOX: Path | None = None
_META:   Path | None = None


def configure(inbox: Path, outbox: Path, meta: Path) -> None:
    """Called once by server.py after path resolution."""
    global _INBOX, _OUTBOX, _META
    _INBOX  = inbox
    _OUTBOX = outbox
    _META   = meta


# ---------------------------------------------------------------------------
# Internal helpers (write path only)
# ---------------------------------------------------------------------------


def _require(path: Optional[Path], label: str) -> Path:
    if path is None:
        raise HTTPException(status_code=500, detail=f"{label} path not configured.")
    return path


def _append(path: Path, content: str) -> None:
    """Append-only write — the projection engine watches this file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(content)


# ---------------------------------------------------------------------------
# Write endpoints  (unchanged from v2 — still append to raw files)
# ---------------------------------------------------------------------------


@router.post("/user", summary="Save user message → core/inbox.md")
def post_user(msg: UserMessage) -> dict:
    """Write a user message to core/inbox.md.

    The Node projection engine detects the file change and rebuilds the
    projection cache within ~300 ms.
    """
    inbox = _require(_INBOX, "inbox.md")
    iso, ref = now_ref()

    entry = build_entry(
        fm={
            "topic":     msg.topic,
            "timestamp": iso,
            "ref":       ref,
            "role":      "user",
            "agent_role": msg.agent_role,
        },
        body=msg.text,
    )
    _append(inbox, entry)
    log.info("user message written  ref=%s  topic=%r", ref, msg.topic)
    return {"status": "ok", "ref": ref, "file": "core/inbox.md"}


@router.post("/ai", summary="Save AI response → core/outbox.md")
def post_ai(msg: AIMessage) -> dict:
    """Write an AI response to core/outbox.md.

    The Node projection engine detects the file change and rebuilds the
    projection cache within ~300 ms.
    """
    outbox = _require(_OUTBOX, "outbox.md")
    iso, ref = now_ref()

    entry = build_entry(
        fm={
            "topic":     msg.topic,
            "timestamp": iso,
            "ref":       ref,
            "reply_to":  msg.reply_to,
            "role":      "ai",
            "agent_role": msg.agent_role,
        },
        body=msg.text,
    )
    _append(outbox, entry)
    log.info("ai reply written  ref=%s  topic=%r  reply_to=%s", ref, msg.topic, msg.reply_to)
    return {"status": "ok", "ref": ref, "file": "core/outbox.md"}


# ---------------------------------------------------------------------------
# Read endpoints — ALL read from the projection cache (zero file I/O)
# ---------------------------------------------------------------------------


@router.get(
    "/stream/inbox",
    summary="All inbox entries (projection cache)",
    response_model=list[MessageEntry],
)
def stream_inbox() -> list[MessageEntry]:
    """Return all inbox entries from the in-memory projection cache."""
    return [MessageEntry(**e) for e in _proj.cache.inbox()]


@router.get(
    "/stream/outbox",
    summary="All outbox entries (projection cache)",
    response_model=list[MessageEntry],
)
def stream_outbox() -> list[MessageEntry]:
    """Return all outbox entries from the in-memory projection cache."""
    return [MessageEntry(**e) for e in _proj.cache.outbox()]


@router.get("/messages", summary="Inbox + outbox combined (projection cache)")
def get_messages() -> dict:
    """Return both inbox and outbox from the projection cache."""
    return {
        "inbox":  _proj.cache.inbox(),
        "outbox": _proj.cache.outbox(),
    }


# ---------------------------------------------------------------------------
# Meta / stats
# ---------------------------------------------------------------------------


@router.get("/meta", summary="Thread metadata (projection cache)")
def get_meta() -> dict:
    """Return thread metadata in the classic meta.json shape (backward compat).

    Source: in-memory projection cache — no disk I/O.
    """
    return _proj.cache.meta()


@router.get("/stats", summary="Message counts and last activity (projection cache)")
def get_stats() -> dict:
    """Return inbox count, outbox count, thread count, last_ref.

    Source: in-memory projection cache — no disk I/O.
    """
    stats = _proj.cache.stats()
    meta  = _proj.cache.meta()
    return {
        "inbox_count":   stats["inbox_count"],
        "outbox_count":  stats["outbox_count"],
        "thread_count":  stats["thread_count"],
        "last_ref":      stats["last_ref"],
        "reply_rate":    stats.get("reply_rate", 0.0),
        "axiom_density": stats.get("axiom_density", 0.0),
        # List of thread topic strings — used by the dashboard for autocomplete
        "threads":       list(meta.get("threads", {}).keys()),
    }


@router.get(
    "/thread/{topic}",
    summary="All messages for a topic (projection cache)",
)
def get_thread(topic: str) -> dict:
    """Return all inbox + outbox messages for the given topic,
    merged chronologically.

    Topic matching is case-insensitive / substring.
    Source: in-memory projection cache — no disk I/O.
    """
    term = topic.lower()
    threads = _proj.cache.threads()

    # Collect all matching threads
    matched: list[dict] = []
    for key, t in threads.items():
        if term in key.lower():
            matched.append(t)

    if not matched:
        return {"topic": topic, "count": 0, "messages": []}

    # Merge messages from all matching threads and sort chronologically
    messages: list[dict] = []
    for t in matched:
        messages.extend(t.get("messages", []))
    messages.sort(key=lambda m: m.get("ref", ""))

    return {
        "topic":    topic,
        "count":    len(messages),
        "messages": messages,
    }


@router.get("/projection", summary="Full projection cache (debug / sync)")
def get_projection() -> dict:
    """Return the complete projection.json contents.

    Useful for debugging, external consumers, and cold-start sync.
    This endpoint is NOT used by the standard dashboard — the dashboard
    uses the individual slice endpoints (/stream/inbox, /meta, etc.).
    """
    return _proj.cache.get()


# ---------------------------------------------------------------------------
# SSE — typed push events from the projection broadcaster
# ---------------------------------------------------------------------------


@router.get(
    "/events",
    summary="Typed SSE stream (thread_update | stats_update | full_sync)",
)
async def sse_events(request: Request):
    """Server-Sent Events endpoint.

    Pushes typed events when the projection cache changes:

    * ``thread_update``  — a specific thread was modified
    * ``stats_update``   — only counts changed, no new messages
    * ``full_sync``      — multiple things changed; client should re-fetch all
    * ``ping``           — keep-alive (every ~15 s)

    Connect from JavaScript::

        const es = new EventSource('/events');
        es.addEventListener('thread_update', e => {
            const { topic, sequence } = JSON.parse(e.data);
            fetchThread(topic);
        });
        es.addEventListener('full_sync', () => poll());
        es.addEventListener('stats_update', () => loadStats());

    Returns 501 if sse-starlette is not installed.
    """
    if not _SSE_AVAILABLE or _EventSourceResponse is None:
        return JSONResponse(
            {"error": "SSE unavailable: pip install sse-starlette"},
            status_code=501,
        )
    return _EventSourceResponse(
        _proj.sse_generator(request),
    )
