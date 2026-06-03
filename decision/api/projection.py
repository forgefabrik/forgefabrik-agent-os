"""
projection.py — Python projection reader and SSE broadcaster.

Provides the in-memory projection cache and the typed SSE broadcast layer
that replaces per-request file parsing throughout routes.py.

Architecture:
    Node projection engine writes  →  core/projection.json
                                   →  core/last_event.json
    _ProjectionCache watches mtime →  broadcasts typed event to all SSE queues
    routes.py reads cache          →  zero file I/O per GET request

SSE event shape (from last_event.json):
    {"type": "full_sync",      "reason": "…",  "sequence": N, "at": "ISO"}
    {"type": "thread_update",  "topic": "…",   "sequence": N, "at": "ISO"}
    {"type": "stats_update",   "reason": "…",  "sequence": N, "at": "ISO"}
    {"type": "ping",                            "sequence": 0, "at": "ISO"}

Boundary: NEVER reads or writes TASK_EVENTS.jsonl, registry.json,
          snapshots/, or transitions.yaml.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator, Optional

log = logging.getLogger("comm.projection")

# ---------------------------------------------------------------------------
# Paths (resolved relative to decision/)
# ---------------------------------------------------------------------------

_BASE: Path | None = None
_PROJ_PATH: Path | None = None
_EVENT_PATH: Path | None = None


def configure(base: Path) -> None:
    """Called once by server.py after path resolution."""
    global _BASE, _PROJ_PATH, _EVENT_PATH
    _BASE       = base
    _PROJ_PATH  = base / "core" / "projection.json"
    _EVENT_PATH = base / "core" / "last_event.json"


def _proj_path() -> Path:
    if _PROJ_PATH is None:
        raise RuntimeError("projection.configure() not called")
    return _PROJ_PATH


def _event_path() -> Path:
    if _EVENT_PATH is None:
        raise RuntimeError("projection.configure() not called")
    return _EVENT_PATH


# ---------------------------------------------------------------------------
# Fallback projection (used when projection.json doesn't exist yet)
# ---------------------------------------------------------------------------

_EMPTY_PROJECTION: dict[str, Any] = {
    "schema_version": "3.0",
    "engine":         "fallback",
    "generated_at":   None,
    "sequence":       0,
    "stats": {
        "inbox_count":    0,
        "outbox_count":   0,
        "total_count":    0,
        "thread_count":   0,
        "last_ref":       None,
        "reply_rate":     0.0,
        "axiom_density":  0.0,
    },
    "threads":  {},
    "inbox":    [],
    "outbox":   [],
    "timeline": [],
}


# ---------------------------------------------------------------------------
# Projection cache — singleton, holds the last good read from disk
# ---------------------------------------------------------------------------

class _ProjectionCache:
    """In-memory cache of the last successfully read projection.json."""

    def __init__(self) -> None:
        self._data: dict[str, Any] = dict(_EMPTY_PROJECTION)
        self._mtime: float = 0.0
        self._lock = asyncio.Lock()

    # ── Sync read (used during startup) ────────────────────────────────────

    def load_sync(self) -> bool:
        """Read projection.json from disk synchronously.

        Returns True if the file was found and parsed, False otherwise.
        """
        path = _proj_path()
        if not path.exists():
            log.debug("projection.json not found — using empty fallback")
            return False
        try:
            raw   = path.read_text(encoding="utf-8")
            data  = json.loads(raw)
            mtime = path.stat().st_mtime
            self._data  = data
            self._mtime = mtime
            log.info(
                "Projection loaded  seq=%s  threads=%s  inbox=%s  outbox=%s",
                data.get("sequence", 0),
                data.get("stats", {}).get("thread_count", 0),
                data.get("stats", {}).get("inbox_count", 0),
                data.get("stats", {}).get("outbox_count", 0),
            )
            return True
        except Exception as exc:
            log.warning("Failed to load projection.json: %s", exc)
            return False

    # ── Async refresh (used by background watcher) ─────────────────────────

    async def refresh_if_changed(self) -> bool:
        """Non-blocking refresh: re-read projection.json only if mtime changed.

        Returns True if a new version was loaded.
        """
        path = _proj_path()
        try:
            mtime = path.stat().st_mtime
        except FileNotFoundError:
            return False

        if mtime == self._mtime:
            return False  # nothing changed

        try:
            raw  = await asyncio.get_event_loop().run_in_executor(
                None, path.read_text, "utf-8"
            )
            data = json.loads(raw)
        except Exception as exc:
            log.warning("Failed to refresh projection.json: %s", exc)
            return False

        async with self._lock:
            self._data  = data
            self._mtime = mtime

        log.debug("Projection refreshed  seq=%s", data.get("sequence", 0))
        return True

    # ── Accessors (all return copies to avoid mutation) ────────────────────

    def get(self) -> dict[str, Any]:
        return dict(self._data)

    def stats(self) -> dict[str, Any]:
        return dict(self._data.get("stats", _EMPTY_PROJECTION["stats"]))

    def threads(self) -> dict[str, Any]:
        return dict(self._data.get("threads", {}))

    def thread(self, topic: str) -> Optional[dict[str, Any]]:
        """Case-insensitive topic lookup — returns the thread or None."""
        threads = self._data.get("threads", {})
        # Exact match first
        if topic in threads:
            return dict(threads[topic])
        # Substring / case-insensitive fallback (mirrors existing /thread/{topic})
        term = topic.lower()
        for key, val in threads.items():
            if term in key.lower():
                return dict(val)
        return None

    def inbox(self) -> list[dict[str, Any]]:
        return list(self._data.get("inbox", []))

    def outbox(self) -> list[dict[str, Any]]:
        return list(self._data.get("outbox", []))

    def meta(self) -> dict[str, Any]:
        """Return a meta.json-compatible shape (backward compat)."""
        threads_raw = self._data.get("threads", {})
        # Build the meta.json shape that the old API returned
        threads_meta: dict[str, Any] = {}
        for topic, t in threads_raw.items():
            threads_meta[topic] = {
                "last_user": t.get("last_user"),
                "last_ai":   t.get("last_ai"),
                "count":     t.get("count", 0),
            }
        return {
            "schema_version": self._data.get("schema_version", "3.0"),
            "last_ref":       self._data.get("stats", {}).get("last_ref"),
            "threads":        threads_meta,
            "sequence":       self._data.get("sequence", 0),
            "generated_at":   self._data.get("generated_at"),
        }

    def sequence(self) -> int:
        return int(self._data.get("sequence", 0))

    def timeline(self) -> list[dict[str, Any]]:
        return list(self._data.get("timeline", []))


# Module-level singleton
cache = _ProjectionCache()


# ---------------------------------------------------------------------------
# SSE broadcaster — one asyncio.Queue per connected client
# ---------------------------------------------------------------------------

class _SSEBroadcaster:
    """Manages per-client asyncio queues for typed SSE push events.

    Clients subscribe via subscribe() / unsubscribe().  The background
    watcher calls broadcast() whenever a new projection is available.
    """

    def __init__(self) -> None:
        self._queues: list[asyncio.Queue[dict[str, Any]]] = []

    def subscribe(self) -> asyncio.Queue[dict[str, Any]]:
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=32)
        self._queues.append(q)
        log.debug("SSE subscriber added  total=%d", len(self._queues))
        return q

    def unsubscribe(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        try:
            self._queues.remove(q)
        except ValueError:
            pass
        log.debug("SSE subscriber removed  total=%d", len(self._queues))

    async def broadcast(self, event: dict[str, Any]) -> None:
        dead: list[asyncio.Queue[dict[str, Any]]] = []
        for q in self._queues:
            try:
                q.put_nowait(event)
            except asyncio.QueueFull:
                # Slow consumer — drop the event for this client (no back-pressure)
                log.debug("SSE queue full, event dropped for one subscriber")
            except Exception as exc:
                log.debug("SSE broadcast error: %s", exc)
                dead.append(q)
        for q in dead:
            self.unsubscribe(q)

    @property
    def subscriber_count(self) -> int:
        return len(self._queues)


# Module-level singleton
broadcaster = _SSEBroadcaster()


# ---------------------------------------------------------------------------
# Background projection watcher
# ---------------------------------------------------------------------------

async def _projection_watcher_loop() -> None:
    """Async background task.

    Polls projection.json mtime every 500 ms.  On change:
      1. Refresh in-memory cache.
      2. Read last_event.json for the typed event hint.
      3. Broadcast the typed event to all SSE subscribers.

    Also sends a heartbeat ping every 15 s to keep SSE connections alive.
    """
    _heartbeat_interval = 30   # ticks × 500 ms = 15 s
    tick = 0

    while True:
        await asyncio.sleep(0.5)
        tick += 1

        try:
            changed = await cache.refresh_if_changed()
            if changed:
                event = _load_last_event()
                await broadcaster.broadcast(event)

            elif tick % _heartbeat_interval == 0:
                # Keep-alive ping
                await broadcaster.broadcast({
                    "type": "ping",
                    "sequence": cache.sequence(),
                    "at": _iso_now(),
                })
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            log.warning("Projection watcher error: %s", exc)


def _load_last_event() -> dict[str, Any]:
    """Read core/last_event.json; fall back to a full_sync event on error."""
    path = _event_path()
    try:
        raw = path.read_text(encoding="utf-8")
        data = json.loads(raw)
        # Ensure required fields are present
        data.setdefault("type",     "full_sync")
        data.setdefault("sequence", cache.sequence())
        data.setdefault("at",       _iso_now())
        return data
    except Exception as exc:
        log.debug("Could not read last_event.json: %s", exc)
        return {
            "type":     "full_sync",
            "reason":   "event_read_error",
            "sequence": cache.sequence(),
            "at":       _iso_now(),
        }


def _iso_now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# SSE generator — yields dicts ready for sse-starlette
# ---------------------------------------------------------------------------

async def sse_generator(
    request: Any,
) -> AsyncGenerator[dict[str, Any], None]:
    """Async generator that yields SSE events for one connected client.

    Yields:
        {"event": "<type>", "data": "<json-string>"}

    Automatically unsubscribes when the client disconnects.
    """
    q = broadcaster.subscribe()

    # Send an initial full_sync so the client has a consistent baseline
    initial: dict[str, Any] = {
        "type":     "full_sync",
        "reason":   "connected",
        "sequence": cache.sequence(),
        "at":       _iso_now(),
    }
    yield {"event": initial["type"], "data": json.dumps(initial)}

    try:
        while True:
            # Check for client disconnect without blocking indefinitely
            if await request.is_disconnected():
                break

            try:
                # Wait up to 1 s for a queued event
                event = await asyncio.wait_for(q.get(), timeout=1.0)
            except asyncio.TimeoutError:
                continue

            event_type = event.pop("type", "update")
            yield {"event": event_type, "data": json.dumps(event)}
    finally:
        broadcaster.unsubscribe(q)


# ---------------------------------------------------------------------------
# Lifespan helpers — called from server.py lifespan context manager
# ---------------------------------------------------------------------------

_watcher_task: asyncio.Task[None] | None = None


def start_background_watcher() -> None:
    """Schedule the projection watcher as a background asyncio task.

    Must be called from within a running event loop (e.g. FastAPI lifespan).
    """
    global _watcher_task
    if _watcher_task is not None and not _watcher_task.done():
        return  # already running
    _watcher_task = asyncio.create_task(
        _projection_watcher_loop(),
        name="projection-watcher",
    )
    log.info("Projection watcher started")


def stop_background_watcher() -> None:
    """Cancel the background watcher (called on shutdown)."""
    global _watcher_task
    if _watcher_task is not None:
        _watcher_task.cancel()
        _watcher_task = None
        log.info("Projection watcher stopped")


@asynccontextmanager
async def lifespan_context():
    """Async context manager for use in FastAPI app lifespan.

    Example in server.py::

        from contextlib import asynccontextmanager
        from api import projection as proj_module

        @asynccontextmanager
        async def lifespan(app):
            async with proj_module.lifespan_context():
                yield
    """
    # Synchronous cold-start read so the first request is never stale
    cache.load_sync()
    start_background_watcher()
    try:
        yield
    finally:
        stop_background_watcher()
