"""
events_gate.py — FastAPI HTTP gate for TASK_EVENTS.jsonl writes.

This module is the explicit adapter layer between the HTTP world and the
truth layer (TASK_EVENTS.jsonl).  It calls .task-locks/event-writer.mjs
via subprocess; it never writes to TASK_EVENTS.jsonl directly.

Architecture position:
    UI / agents / CLI
         ↓  POST /events/write
    events_gate.py  (validation + subprocess gate)
         ↓  stdin JSON  ↓  stdout JSON
    event-writer.mjs  (lock + hash + append)
         ↓
    TASK_EVENTS.jsonl

Boundary contract:
    - This module NEVER writes to TASK_EVENTS.jsonl directly.
    - This module NEVER reads registry.json or snapshots.
    - All hash computation lives in event-writer.mjs (single source of truth).
    - The communication layer (inbox.md / outbox.md) is a separate concern;
      this endpoint is the bridge to the TASK_EVENTS truth layer only.

Endpoints:
    POST /events/write      Write a task event through event-writer.mjs.
    GET  /events/head       Return the current HEAD event (last line in log).
    GET  /events/status     Return chain length + HEAD hash (lightweight health).

    GET  /trust             Return the current trust report (trust-report.json).
    GET  /trust/gate        Full integrity-gate read: trust + projection data.
    POST /trust/refresh     Force-rebuild trust-report.json via trust-report.mjs.
"""

from __future__ import annotations

import json
import logging
import subprocess
import sys
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator, model_validator

log = logging.getLogger("comm.events_gate")

# ---------------------------------------------------------------------------
# Paths — configured once by server.py
# ---------------------------------------------------------------------------

_PROJECT_ROOT: Path | None = None
_WRITER_PATH:  Path | None = None
_EVENTS_PATH:  Path | None = None

# Node binary: prefer the one on PATH, fall back to 'node'
_NODE = sys.executable.replace('python', 'node') if False else 'node'


_TRUST_SCRIPT:  Path | None = None
_INTEGRITY_GATE: Path | None = None
_TRUST_REPORT_PATH: Path | None = None


def configure(project_root: Path) -> None:
    """Called once by server.py after path resolution."""
    global _PROJECT_ROOT, _WRITER_PATH, _EVENTS_PATH
    global _TRUST_SCRIPT, _INTEGRITY_GATE, _TRUST_REPORT_PATH
    _PROJECT_ROOT      = project_root
    _WRITER_PATH       = project_root / '.task-locks' / 'event-writer.mjs'
    _EVENTS_PATH       = project_root / 'TASK_EVENTS.jsonl'
    _TRUST_SCRIPT      = project_root / '.task-locks' / 'trust-report.mjs'
    _INTEGRITY_GATE    = project_root / '.task-locks' / 'integrity-gate.mjs'
    _TRUST_REPORT_PATH = project_root / 'decision' / 'core' / 'trust-report.json'
    log.info(
        "Events gate configured  writer=%s  events=%s",
        _WRITER_PATH, _EVENTS_PATH,
    )


def _require_configured() -> tuple[Path, Path]:
    if _WRITER_PATH is None or _EVENTS_PATH is None:
        raise HTTPException(status_code=500, detail="events_gate not configured")
    return _WRITER_PATH, _EVENTS_PATH


# ---------------------------------------------------------------------------
# Known event types (mirrors event.schema.json enum — must stay in sync)
# ---------------------------------------------------------------------------

KNOWN_EVENT_TYPES: frozenset[str] = frozenset({
    "ENGINE_INITIALIZED",
    "TASK_CLAIMED",
    "TASK_HEARTBEAT",
    "TASK_REVIEW_REQUESTED",
    "TASK_REFACTOR_REQUESTED",
    "TASK_REFACTOR_COMPLETE",
    "TASK_APPROVED",
    "TASK_REJECTED",
    "TASK_MERGED",
    "TASK_LOCK_EXPIRED",
    "TASK_ARCHITECT_OVERRIDE",
    "TASK_FORKED",
    "PROJECTION_REBUILT",
    "SNAPSHOT_CREATED",
    # Agent Runtime Layer (schema_version 1.2.0)
    "AGENT_REGISTERED",
    "TASK_RELEASED",
    "LEASE_RENEWED",
    "LEASE_EXPIRED",
    # Scheduler Layer (schema_version 1.3.0)
    "TASK_PRIORITY_SET",
    "TASK_PRIORITY_CLEARED",
    # Idea Factory Layer
    "IDEA_SUBMITTED",
    "ARCHITECTURE_GENERATED",
    "TASK_GRAPH_CREATED",
    "TASK_CREATED",
    "TASK_BID_SUBMITTED",
    "TASK_BID_WON",
    "TASK_PRICE_DISCOVERED",
})

# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------


class EventPayload(BaseModel):
    """
    Event payload submitted to POST /events/write.

    Computed fields (event_index, prev_event_hash, event_hash) are injected
    by event-writer.mjs and must NOT be supplied by callers.  If present,
    they are silently stripped before forwarding to the writer.

    All other fields match the event.schema.json property definitions.
    """

    # Top-level required fields
    event_type:      str
    engine_version:  int
    timestamp:       str

    # Task-scope fields (null for system meta-events)
    task_id:         Optional[str]   = None
    agent:           Optional[str]   = None
    role:            Optional[str]   = None
    model:           Optional[str]   = None
    branch:          Optional[str]   = None
    pr_number:       Optional[int]   = None
    forked_from:     Optional[str]   = None
    fork_suffix:     Optional[str]   = None
    override_reason: Optional[str]   = None
    notes:           Optional[str]   = None
    snapshot_index:  Optional[int]   = None
    # Scheduler Layer (schema_version 1.3.0)
    priority_weight: Optional[float] = None
    execution_cost:  Optional[float] = None
    reason:          Optional[str]   = None
    # Idea Factory Layer
    idea_id:          Optional[str]       = None
    content:          Optional[str]       = None
    source:           Optional[str]       = None
    architecture_id:  Optional[str]       = None
    architecture:     Optional[dict[str, Any]] = None
    task_graph:       Optional[list[Any]] = None
    parent_idea:      Optional[str]       = None
    description:      Optional[str]       = None
    module:           Optional[str]       = None
    bid_id:           Optional[str]       = None
    bid_strength:     Optional[float]     = None
    cost_offer:       Optional[float]     = None
    confidence:       Optional[float]     = None
    winning_bid_id:   Optional[str]       = None
    price_multiplier: Optional[float]     = None

    @field_validator("event_type")
    @classmethod
    def event_type_in_enum(cls, v: str) -> str:
        if v not in KNOWN_EVENT_TYPES:
            raise ValueError(
                f'"{v}" is not a known event_type. '
                f'Valid types: {sorted(KNOWN_EVENT_TYPES)}'
            )
        return v

    @field_validator("engine_version")
    @classmethod
    def engine_version_positive(cls, v: int) -> int:
        if v < 1:
            raise ValueError("engine_version must be >= 1")
        return v

    @field_validator("timestamp")
    @classmethod
    def timestamp_iso(cls, v: str) -> str:
        import re
        if not re.match(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}', v):
            raise ValueError(f"timestamp must be ISO-8601 (YYYY-MM-DDTHH:MM:SS…), got: {v!r}")
        return v

    def to_writer_payload(self) -> dict[str, Any]:
        """Return a dict safe to pass to event-writer.mjs (no computed fields)."""
        return {k: v for k, v in self.model_dump().items()}


class EventWriteResponse(BaseModel):
    """Response from POST /events/write on success."""
    ok:          bool
    event:       dict[str, Any]
    writer_path: str


class EventWriteError(BaseModel):
    """Response from POST /events/write on failure."""
    ok:    bool = False
    error: str
    code:  Optional[str] = None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/events", tags=["Event Gate"])


# ---------------------------------------------------------------------------
# POST /events/write
# ---------------------------------------------------------------------------

@router.post(
    "/write",
    summary="Write a task event through event-writer.mjs",
    response_model=EventWriteResponse,
    responses={
        400: {"model": EventWriteError, "description": "Validation failure"},
        500: {"model": EventWriteError, "description": "Writer subprocess error"},
        503: {"model": EventWriteError, "description": "event-writer.mjs not found"},
    },
)
async def write_event(payload: EventPayload) -> JSONResponse:
    """
    Validate and append one event to TASK_EVENTS.jsonl.

    The caller supplies all event fields **except** ``event_index``,
    ``prev_event_hash``, and ``event_hash`` — these are computed by
    ``event-writer.mjs``.

    On success returns the complete written event (with all computed fields).

    **Rate / concurrency:** The writer holds an advisory file lock
    (`.task-locks/WRITE.lock`).  Concurrent calls are serialised; the
    endpoint may block for up to ~6 s waiting for the lock.

    **Boundary:** This endpoint never reads or writes communication-layer
    files (inbox.md / outbox.md).  Use ``POST /user`` or ``POST /ai`` for
    communication messages.
    """
    writer_path, events_path = _require_configured()

    # ── Check writer script exists ─────────────────────────────────────
    if not writer_path.exists():
        log.error("event-writer.mjs not found at %s", writer_path)
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": f"event-writer.mjs not found at {writer_path}", "code": "ERR_WRITER_MISSING"},
        )

    # ── Serialise payload for stdin ────────────────────────────────────
    writer_input = json.dumps(payload.to_writer_payload()).encode("utf-8")

    # ── Invoke event-writer.mjs ────────────────────────────────────────
    try:
        result = subprocess.run(
            ["node", str(writer_path), "--json"],
            input=writer_input,
            capture_output=True,
            timeout=30,
        )
    except FileNotFoundError:
        log.error("node binary not found on PATH")
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "node binary not found. Install Node.js ≥ 18.", "code": "ERR_NODE_MISSING"},
        )
    except subprocess.TimeoutExpired:
        log.error("event-writer.mjs timed out after 30 s")
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "event-writer.mjs timed out (30 s)", "code": "ERR_WRITER_TIMEOUT"},
        )

    stdout_text = result.stdout.decode("utf-8", errors="replace").strip()
    stderr_text = result.stderr.decode("utf-8", errors="replace").strip()

    if stderr_text:
        log.warning("event-writer.mjs stderr: %s", stderr_text)

    # ── Parse writer output ────────────────────────────────────────────
    try:
        writer_result: dict[str, Any] = json.loads(stdout_text)
    except (json.JSONDecodeError, ValueError):
        log.error("event-writer.mjs non-JSON stdout: %r", stdout_text)
        return JSONResponse(
            status_code=500,
            content={
                "ok":    False,
                "error": "event-writer.mjs returned non-JSON output",
                "code":  "ERR_WRITER_BAD_OUTPUT",
                "raw":   stdout_text[:500],
            },
        )

    # ── Handle writer failure ──────────────────────────────────────────
    if not writer_result.get("ok"):
        error_msg = writer_result.get("error", "unknown writer error")
        error_code = writer_result.get("code", "ERR_WRITER_FAILED")
        log.warning("event-writer.mjs rejected event: [%s] %s", error_code, error_msg)
        http_status = 400 if error_code in ("ERR_VALIDATION", "ERR_INVALID_JSON") else 500
        return JSONResponse(
            status_code=http_status,
            content={"ok": False, "error": error_msg, "code": error_code},
        )

    # ── Success ────────────────────────────────────────────────────────
    written_event = writer_result.get("event", {})
    log.info(
        "Event written: type=%s idx=%s hash=%s…",
        written_event.get("event_type"),
        written_event.get("event_index"),
        str(written_event.get("event_hash", ""))[:16],
    )

    return JSONResponse(
        status_code=200,
        content={
            "ok":          True,
            "event":       written_event,
            "writer_path": str(writer_path),
        },
    )


# ---------------------------------------------------------------------------
# GET /events/head
# ---------------------------------------------------------------------------

@router.get(
    "/head",
    summary="Return the current HEAD event (last event in the log)",
)
async def get_head() -> JSONResponse:
    """
    Return the last event in TASK_EVENTS.jsonl.

    Useful for clients that need to know the current chain tip before
    composing a new event, or for health checks.
    """
    _, events_path = _require_configured()

    if not events_path.exists():
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": "TASK_EVENTS.jsonl not found"},
        )

    try:
        raw = events_path.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not read event log: {e}")

    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    if not lines:
        return JSONResponse(
            status_code=200,
            content={"ok": True, "line_count": 0, "head": None},
        )

    try:
        head = json.loads(lines[-1])
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=500, detail=f"HEAD event is not valid JSON: {e}")

    return JSONResponse(
        status_code=200,
        content={"ok": True, "line_count": len(lines), "head": head},
    )


# ---------------------------------------------------------------------------
# GET /events/status
# ---------------------------------------------------------------------------

@router.get(
    "/status",
    summary="Return event log chain length and HEAD hash",
)
async def get_status() -> JSONResponse:
    """
    Lightweight chain status — line count + HEAD hash.

    Does not validate the chain (use ``audit.mjs`` for full verification).
    """
    _, events_path = _require_configured()

    if not events_path.exists():
        return JSONResponse(
            status_code=200,
            content={"ok": True, "exists": False, "line_count": 0, "head_hash": None},
        )

    try:
        raw = events_path.read_text(encoding="utf-8")
    except OSError as e:
        raise HTTPException(status_code=500, detail=str(e))

    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    head_hash: Optional[str] = None

    if lines:
        try:
            last = json.loads(lines[-1])
            head_hash = last.get("event_hash")
        except json.JSONDecodeError:
            head_hash = None

    return JSONResponse(
        status_code=200,
        content={
            "ok":         True,
            "exists":     True,
            "line_count": len(lines),
            "head_hash":  head_hash,
        },
    )


# ---------------------------------------------------------------------------
# Trust Layer endpoints  (trust-report.mjs / integrity-gate.mjs)
# ---------------------------------------------------------------------------

def _require_trust_configured() -> tuple[Path, Path, Path]:
    if _TRUST_SCRIPT is None or _INTEGRITY_GATE is None or _TRUST_REPORT_PATH is None:
        raise HTTPException(status_code=500, detail="trust gate not configured")
    return _TRUST_SCRIPT, _INTEGRITY_GATE, _TRUST_REPORT_PATH


@router.get(
    "/trust",
    summary="Return current trust report (trust-report.json)",
)
async def get_trust() -> JSONResponse:
    """
    Return the latest ``core/trust-report.json``.

    The trust report is generated by ``trust-report.mjs`` and contains:

    * ``status``        — ``verified`` | ``degraded`` | ``invalid``
    * ``chain_valid``   — hash chain integrity
    * ``snapshot_valid``— latest snapshot is consistent with live chain
    * ``registry_valid``— registry.json event_count matches chain
    * ``axiom_density`` — ARCHITECT_OVERRIDE / total task events (0–1)
    * ``head_hash``     — current HEAD event hash

    If the file is missing, returns ``status: "unknown"``.
    """
    _, _, report_path = _require_trust_configured()

    if not report_path.exists():
        return JSONResponse(
            status_code=200,
            content={
                "status":  "unknown",
                "reason":  "trust-report.json not found — run POST /trust/refresh",
            },
        )
    try:
        report = json.loads(report_path.read_text(encoding="utf-8"))
        return JSONResponse(status_code=200, content=report)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Could not read trust-report.json: {e}")


@router.get(
    "/trust/gate",
    summary="Integrity-gate read: trust verification + projection data",
)
async def get_trust_gate() -> JSONResponse:
    """
    Call ``integrity-gate.mjs`` to get trust status + projection data in one
    response.  The gate re-checks ``trust-report.json`` freshness (max 60 s)
    and rebuilds it if stale before returning data.

    Response shape::

        {
          "trust":          "verified" | "degraded" | "invalid",
          "chain_valid":    bool,
          "axiom_density":  float,
          "snapshot":       int,
          "event_head":     int,
          "data":           { ...projection... } | null
        }

    Dashboard should read this endpoint before rendering task-state UI.
    """
    _, gate_path, _ = _require_trust_configured()

    if not gate_path.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "integrity-gate.mjs not found", "trust": "unknown"},
        )

    try:
        result = subprocess.run(
            ["node", str(gate_path), "--resource", "projection"],
            capture_output=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "integrity-gate.mjs timed out", "trust": "unknown"},
        )
    except FileNotFoundError:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "node binary not found", "trust": "unknown"},
        )

    stdout_text = result.stdout.decode("utf-8", errors="replace").strip()
    try:
        gate_result: dict[str, Any] = json.loads(stdout_text)
    except (json.JSONDecodeError, ValueError):
        return JSONResponse(
            status_code=500,
            content={
                "ok":    False,
                "error": "integrity-gate.mjs non-JSON output",
                "trust": "unknown",
                "raw":   stdout_text[:300],
            },
        )

    return JSONResponse(
        status_code=200 if gate_result.get("trust") in ("verified", "degraded") else 503,
        content=gate_result,
    )


@router.post(
    "/trust/refresh",
    summary="Force-rebuild trust-report.json via trust-report.mjs",
)
async def post_trust_refresh() -> JSONResponse:
    """
    Trigger an immediate rebuild of ``core/trust-report.json`` by running
    ``trust-report.mjs``.

    Use this after appending new events to ensure the trust panel reflects
    the latest chain state without waiting for the next scheduled refresh.
    """
    trust_script, _, _ = _require_trust_configured()

    if not trust_script.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "trust-report.mjs not found"},
        )

    try:
        result = subprocess.run(
            ["node", str(trust_script), "--json"],
            capture_output=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "trust-report.mjs timed out"},
        )
    except FileNotFoundError:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "node binary not found"},
        )

    stdout_text = result.stdout.decode("utf-8", errors="replace").strip()
    try:
        report: dict[str, Any] = json.loads(stdout_text)
    except (json.JSONDecodeError, ValueError):
        return JSONResponse(
            status_code=500,
            content={"ok": False, "error": "trust-report.mjs non-JSON output", "raw": stdout_text[:300]},
        )

    log.info("Trust report refreshed: status=%s", report.get("status"))
    return JSONResponse(
        status_code=200,
        content={"ok": True, "report": report},
    )
