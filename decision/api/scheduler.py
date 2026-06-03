"""
scheduler.py — FastAPI endpoints for the Scheduler Layer.

Architecture:
    GET  endpoints read directly from .task-locks/scheduler/*.json
    (queue.json, assignments.json, runtime_status.json, scheduler_report.json).
    Zero subprocess overhead for read operations.

    POST /scheduler/run          triggers scheduler.mjs
    POST /scheduler/priority     writes TASK_PRIORITY_SET via event-writer.mjs
    DELETE /scheduler/priority/{task_id}  writes TASK_PRIORITY_CLEARED

Endpoints:
    GET  /scheduler/queue              Current scored task queue
    GET  /scheduler/assignments        Current agent-task recommendations
    GET  /scheduler/runtime-status     Monitoring view (IN_PROGRESS, REFACTOR_CLAIMED)
    GET  /scheduler/report             Last scheduler run report
    GET  /scheduler/policy             Current scheduler_policy.json
    GET  /scheduler/task/{task_id}     Score breakdown for a single task
    POST /scheduler/run                Trigger scheduler.mjs
    POST /scheduler/priority           Set task priority (TASK_PRIORITY_SET)
    POST /scheduler/priority/clear     Clear task priority (TASK_PRIORITY_CLEARED)

Boundary rule: NEVER writes to TASK_EVENTS.jsonl directly.
               Priority events go through event-writer.mjs.
               Schedule execution goes through scheduler.mjs.
"""

from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

log = logging.getLogger("comm.scheduler")

# ---------------------------------------------------------------------------
# Paths — configured once by server.py
# ---------------------------------------------------------------------------

_PROJECT_ROOT:   Path | None = None
_SCHED_DIR:      Path | None = None
_WRITER_PATH:    Path | None = None
_SCHEDULER:      Path | None = None
_INTEGRITY_GATE: Path | None = None
_BRIDGE:         Path | None = None

# Valid Fibonacci execution cost values
VALID_EXECUTION_COSTS: frozenset[int] = frozenset({1, 2, 3, 5, 8, 13, 21})


def configure(project_root: Path) -> None:
    """Called once by server.py after path resolution."""
    global _PROJECT_ROOT, _SCHED_DIR, _WRITER_PATH, _SCHEDULER, _INTEGRITY_GATE, _BRIDGE
    _PROJECT_ROOT   = project_root
    _SCHED_DIR      = project_root / ".task-locks" / "scheduler"
    _WRITER_PATH    = project_root / ".task-locks" / "event-writer.mjs"
    _SCHEDULER      = project_root / ".task-locks" / "scheduler.mjs"
    _INTEGRITY_GATE = project_root / ".task-locks" / "integrity-gate.mjs"
    _BRIDGE         = project_root / ".task-locks" / "integrity-bridge.mjs"
    log.info("Scheduler gate configured  sched_dir=%s", _SCHED_DIR)


def _require_configured() -> Path:
    if _SCHED_DIR is None:
        raise HTTPException(status_code=500, detail="scheduler module not configured")
    return _SCHED_DIR


# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------


class SetPriorityRequest(BaseModel):
    """Payload for POST /scheduler/priority."""

    task_id:         str
    priority_weight: float
    execution_cost:  int
    agent:           str
    role:            str
    timestamp:       str
    engine_version:  int
    reason:          Optional[str] = None

    @field_validator("priority_weight")
    @classmethod
    def weight_positive(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("priority_weight must be > 0")
        return v

    @field_validator("execution_cost")
    @classmethod
    def cost_fibonacci(cls, v: int) -> int:
        if v not in VALID_EXECUTION_COSTS:
            raise ValueError(
                f"execution_cost must be a Fibonacci value: {sorted(VALID_EXECUTION_COSTS)}"
            )
        return v

    @field_validator("timestamp")
    @classmethod
    def timestamp_iso(cls, v: str) -> str:
        import re
        if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", v):
            raise ValueError(f"timestamp must be ISO-8601, got: {v!r}")
        return v


class ClearPriorityRequest(BaseModel):
    """Payload for POST /scheduler/priority/clear."""

    task_id:        str
    agent:          str
    role:           str
    timestamp:      str
    engine_version: int
    reason:         Optional[str] = None

    @field_validator("timestamp")
    @classmethod
    def timestamp_iso(cls, v: str) -> str:
        import re
        if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", v):
            raise ValueError(f"timestamp must be ISO-8601, got: {v!r}")
        return v


class ProposeRequest(BaseModel):
    """Payload for POST /scheduler/propose — submits a scheduling proposal to integrity-bridge.mjs."""

    task_id:             str
    agent_id:            str
    role:                str
    scheduler_sequence:  int
    world_snapshot_hash: str

    @field_validator("role")
    @classmethod
    def role_valid(cls, v: str) -> str:
        valid = {"IMPLEMENTATION", "REFACTOR", "REVIEW", "ARCHITECT"}
        if v not in valid:
            raise ValueError(f'"{v}" is not a valid role')
        return v

    @field_validator("world_snapshot_hash")
    @classmethod
    def hash_valid(cls, v: str) -> str:
        import re
        if not re.match(r"^[a-f0-9]{64}$", v):
            raise ValueError("world_snapshot_hash must be a 64-char lowercase hex string")
        return v

    @field_validator("scheduler_sequence")
    @classmethod
    def seq_positive(cls, v: int) -> int:
        if v < 1:
            raise ValueError("scheduler_sequence must be >= 1")
        return v


class RunSchedulerRequest(BaseModel):
    """Payload for POST /scheduler/run."""

    timestamp: Optional[str] = None  # inject "now" for deterministic testing


# ---------------------------------------------------------------------------
# Subprocess helper
# ---------------------------------------------------------------------------

def _run_node(
    script: Path,
    args: list[str],
    stdin_data: str | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    cmd = ["node", str(script), "--json"] + args
    try:
        result = subprocess.run(
            cmd,
            input=stdin_data.encode("utf-8") if stdin_data else None,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return {"ok": False, "error": "node binary not found.", "code": "ERR_NODE_MISSING"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"{script.name} timed out ({timeout}s)", "code": "ERR_TIMEOUT"}

    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    stderr = result.stderr.decode("utf-8", errors="replace").strip()
    if stderr:
        log.warning("%s stderr: %s", script.name, stderr[:300])

    try:
        return json.loads(stdout)
    except (json.JSONDecodeError, ValueError):
        return {
            "ok":    False,
            "error": f"{script.name} returned non-JSON output",
            "code":  "ERR_BAD_OUTPUT",
            "raw":   stdout[:300],
        }


def _http_status_for(result: dict[str, Any]) -> int:
    code = result.get("code", "")
    if code in ("ERR_NODE_MISSING", "ERR_TIMEOUT", "ERR_BAD_OUTPUT"):
        return 503
    if code in ("ERR_VALIDATION",):
        return 400
    return 500


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/scheduler", tags=["Scheduler"])
decision_router = APIRouter(prefix="/decision-engine", tags=["Decision Engine"])


# ---------------------------------------------------------------------------
# GET /scheduler/queue
# ---------------------------------------------------------------------------

@router.get("/queue", summary="Current scored task queue")
async def get_queue() -> JSONResponse:
    """
    Return the current ``scheduler/queue.json``.

    The queue is ordered by score descending and includes score component
    breakdowns (priority_weight, urgency_factor, dependency_pressure,
    trust_ceiling, execution_cost) for full auditability.

    Rebuild with ``POST /scheduler/run`` to refresh.
    """
    sched_dir = _require_configured()
    data = _read_json(sched_dir / "queue.json")
    if data is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": "queue.json not found — run POST /scheduler/run first"},
        )
    return JSONResponse(status_code=200, content={"ok": True, **data})


@decision_router.get("/queue", summary="Current decision queue")
async def get_decision_queue() -> JSONResponse:
    return await get_queue()


# ---------------------------------------------------------------------------
# GET /scheduler/assignments
# ---------------------------------------------------------------------------

@router.get("/assignments", summary="Current agent-task recommendations")
async def get_assignments() -> JSONResponse:
    """
    Return ``scheduler/assignments.json``.

    Advisory only — agents should consult this before calling
    ``POST /agents/leases/acquire``.  Each entry includes the recommended
    agent and a ranked fallback list for resilience.
    """
    sched_dir = _require_configured()
    data = _read_json(sched_dir / "assignments.json")
    if data is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": "assignments.json not found"},
        )
    return JSONResponse(status_code=200, content={"ok": True, **data})


@decision_router.get("/assignments", summary="Current decision assignments")
async def get_decision_assignments() -> JSONResponse:
    return await get_assignments()


# ---------------------------------------------------------------------------
# GET /scheduler/runtime-status
# ---------------------------------------------------------------------------

@router.get("/runtime-status", summary="Monitoring view of active tasks")
async def get_runtime_status() -> JSONResponse:
    """
    Return ``scheduler/runtime_status.json``.

    Shows IN_PROGRESS and REFACTOR_CLAIMED tasks with their lease health
    (heartbeat recency), sorted by lease health ascending so the most at-risk
    tasks surface first.
    """
    sched_dir = _require_configured()
    data = _read_json(sched_dir / "runtime_status.json")
    if data is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": "runtime_status.json not found"},
        )
    return JSONResponse(status_code=200, content={"ok": True, **data})


@decision_router.get("/runtime-status", summary="Decision runtime status")
async def get_decision_runtime_status() -> JSONResponse:
    return await get_runtime_status()


# ---------------------------------------------------------------------------
# GET /scheduler/report
# ---------------------------------------------------------------------------

@router.get("/report", summary="Last scheduler run metadata")
async def get_report() -> JSONResponse:
    """Return ``scheduler/scheduler_report.json`` — last run metadata."""
    sched_dir = _require_configured()
    data = _read_json(sched_dir / "scheduler_report.json")
    if data is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": "scheduler_report.json not found"},
        )
    return JSONResponse(status_code=200, content={"ok": True, **data})


@decision_router.get("/report", summary="Last decision engine run metadata")
async def get_decision_report() -> JSONResponse:
    return await get_report()


# ---------------------------------------------------------------------------
# GET /scheduler/policy
# ---------------------------------------------------------------------------

@router.get("/policy", summary="Current scheduler policy configuration")
async def get_policy() -> JSONResponse:
    """Return ``scheduler/scheduler_policy.json``."""
    sched_dir = _require_configured()
    data = _read_json(sched_dir / "scheduler_policy.json")
    if data is None:
        return JSONResponse(
            status_code=404,
            content={"ok": False, "error": "scheduler_policy.json not found"},
        )
    return JSONResponse(status_code=200, content={"ok": True, **data})


@decision_router.get("/policy", summary="Current decision policy configuration")
async def get_decision_policy() -> JSONResponse:
    return await get_policy()


# ---------------------------------------------------------------------------
# GET /scheduler/task/{task_id}
# ---------------------------------------------------------------------------

@router.get("/task/{task_id}", summary="Score breakdown for a single task")
async def get_task_score(task_id: str) -> JSONResponse:
    """
    Return the queue entry for a specific task_id, including full score
    component breakdown and ranked candidate list.
    """
    sched_dir = _require_configured()
    queue_data = _read_json(sched_dir / "queue.json")
    if queue_data is None:
        raise HTTPException(status_code=404, detail="queue.json not found — run POST /scheduler/run first")

    entry = next(
        (e for e in queue_data.get("queue", []) if e.get("task_id") == task_id),
        None,
    )
    if entry is None:
        # Check if the task exists in runtime_status
        rt_data = _read_json(sched_dir / "runtime_status.json")
        if rt_data:
            rt_entry = next(
                (m for m in rt_data.get("monitored", []) if m.get("task_id") == task_id),
                None,
            )
            if rt_entry:
                return JSONResponse(
                    status_code=200,
                    content={"ok": True, "task_id": task_id, "in_queue": False, "monitored": rt_entry},
                )

        raise HTTPException(
            status_code=404,
            detail=f"Task '{task_id}' not found in queue or runtime status",
        )

    return JSONResponse(
        status_code=200,
        content={"ok": True, "task_id": task_id, "in_queue": True, **entry},
    )


@decision_router.get("/task/{task_id}", summary="Decision breakdown for a single task")
async def get_decision_task_score(task_id: str) -> JSONResponse:
    return await get_task_score(task_id)


# ---------------------------------------------------------------------------
# POST /scheduler/propose — submit a scheduling proposal to integrity-bridge
# ---------------------------------------------------------------------------

@router.post(
    "/propose",
    summary="Validate a scheduling proposal and issue a bridge_token (STEP 3 commit phase)",
)
async def propose(payload: ProposeRequest) -> JSONResponse:
    """
    Submit a scheduling proposal to ``integrity-bridge.mjs validate``.

    The agent must derive the proposal from the current ``queue.json``:

    * ``task_id``             — from the queue entry the agent intends to claim
    * ``agent_id``            — the agent's registered identity
    * ``role``                — needed_role from the queue entry
    * ``scheduler_sequence``  — from ``scheduler_report.scheduler_sequence``
    * ``world_snapshot_hash`` — from ``queue.world_snapshot.world_snapshot_hash``

    The bridge runs six checks (B1-B6).  If all pass it issues a ``bridge_token``
    that the agent MUST pass to ``POST /agents/leases/acquire`` as:

    .. code-block:: json

        {
          "bridge_token":   "<64-hex>",
          "bridge_snapshot": "<world_snapshot_hash>",
          "bridge_evaluated_at": "<ISO>"
        }

    The bridge_token expires after ``bridge_token_ttl_seconds`` (default 60 s).
    If the world state changes between propose and acquire (any event written,
    leases.json updated, etc.) the token is automatically invalidated.

    Returns ``200`` with ``valid=true`` on success, ``422`` if the proposal
    fails validation, ``503`` if the bridge script is unavailable.
    """
    if _BRIDGE is None:
        raise HTTPException(status_code=500, detail="scheduler module not configured")

    if not _BRIDGE.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "integrity-bridge.mjs not found", "code": "ERR_BRIDGE_MISSING"},
        )

    proposal_json = json.dumps({
        "task_id":             payload.task_id,
        "agent_id":            payload.agent_id,
        "role":                payload.role,
        "scheduler_sequence":  payload.scheduler_sequence,
        "world_snapshot_hash": payload.world_snapshot_hash,
    })

    result = _run_node(_BRIDGE, ["validate"], stdin_data=proposal_json)

    if result.get("code") in ("ERR_NODE_MISSING", "ERR_TIMEOUT", "ERR_BAD_OUTPUT"):
        return JSONResponse(status_code=503, content=result)

    # valid=true → 200, valid=false → 422 (Unprocessable Entity — proposal was
    # structurally correct but semantically rejected by the bridge)
    if not result.get("valid", False):
        return JSONResponse(
            status_code=422,
            content={
                "ok":     False,
                "valid":  False,
                "reason": result.get("reason"),
                "checks": result.get("checks", {}),
            },
        )

    log.info(
        "Bridge proposal accepted: task=%s agent=%s token=%s…",
        payload.task_id,
        payload.agent_id,
        (result.get("bridge_token") or "")[:16],
    )

    return JSONResponse(status_code=200, content={"ok": True, **result})


@decision_router.post(
    "/propose",
    summary="Validate a decision proposal and issue a bridge_token",
)
async def propose_decision(payload: ProposeRequest) -> JSONResponse:
    return await propose(payload)


# ---------------------------------------------------------------------------
# GET /scheduler/gate — trust-gated scheduler output
# ---------------------------------------------------------------------------

@router.get(
    "/gate",
    summary="Trust-gated scheduler queue (via integrity-gate.mjs)",
)
async def get_scheduler_gate() -> JSONResponse:
    """
    Return ``scheduler/queue.json`` and ``scheduler_report.json`` through
    the integrity gate (``integrity-gate.mjs --resource scheduler``).

    The gate verifies the event chain trust status before serving data:

    * ``trust=verified``  — data is clean; queue is served
    * ``trust=degraded``  — chain is intact but has soft warnings; queue served
    * ``trust=invalid``   — chain is broken; 503 returned, no queue data

    This is the recommended endpoint for external consumers that need
    cryptographic assurance that the scheduler output was computed from
    a valid event chain.
    """
    if _INTEGRITY_GATE is None:
        raise HTTPException(status_code=500, detail="scheduler module not configured")

    if not _INTEGRITY_GATE.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "integrity-gate.mjs not found", "code": "ERR_GATE_MISSING"},
        )

    result = _run_node(_INTEGRITY_GATE, ["--resource", "scheduler"])

    trust = result.get("trust", "unknown")
    if trust in ("invalid", "corrupt"):
        return JSONResponse(
            status_code=503,
            content={
                "ok":     False,
                "trust":  trust,
                "reason": result.get("reason"),
                "data":   None,
            },
        )

    return JSONResponse(
        status_code=200,
        content={
            "ok":    True,
            "trust": trust,
            "data":  result.get("data"),
        },
    )


@decision_router.get("/gate", summary="Trust-gated decision queue")
async def get_decision_gate() -> JSONResponse:
    return await get_scheduler_gate()


# ---------------------------------------------------------------------------
# POST /scheduler/run
# ---------------------------------------------------------------------------

@router.post("/run", summary="Trigger scheduler.mjs to rebuild queue and assignments")
async def run_scheduler(payload: RunSchedulerRequest) -> JSONResponse:
    """
    Run ``scheduler.mjs`` to recompute the task queue, assignments, and
    runtime status from the current registry state.

    Returns the scheduler run report (sequence, queue_count, warnings).

    Pass ``timestamp`` to override the scheduler's "now" for deterministic
    testing (format: ``YYYY-MM-DDTHH:MM:SSZ``).
    """
    if _SCHEDULER is None:
        raise HTTPException(status_code=500, detail="scheduler module not configured")

    if not _SCHEDULER.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "scheduler.mjs not found", "code": "ERR_SCHEDULER_MISSING"},
        )

    args: list[str] = []
    if payload.timestamp:
        args += ["--timestamp", payload.timestamp]

    result = _run_node(_SCHEDULER, args)

    # scheduler.mjs exits 1 on warnings, 0 on full success — both are usable
    if result.get("code") in ("ERR_NODE_MISSING", "ERR_TIMEOUT", "ERR_BAD_OUTPUT"):
        return JSONResponse(status_code=503, content=result)

    log.info(
        "Scheduler run: sequence=%s queue=%s warnings=%s",
        result.get("scheduler_sequence"),
        result.get("queue_count"),
        result.get("warnings"),
    )

    return JSONResponse(status_code=200, content={"ok": True, **result})


@decision_router.post("/run", summary="Trigger the decision engine")
async def run_decision_engine(payload: RunSchedulerRequest) -> JSONResponse:
    return await run_scheduler(payload)


# ---------------------------------------------------------------------------
# POST /scheduler/priority
# ---------------------------------------------------------------------------

@router.post("/priority", summary="Set task priority (TASK_PRIORITY_SET event)")
async def set_priority(payload: SetPriorityRequest) -> JSONResponse:
    """
    Write a ``TASK_PRIORITY_SET`` event via ``event-writer.mjs``, then
    trigger ``scheduler.mjs`` to refresh the queue.

    ``execution_cost`` must be a Fibonacci value: 1, 2, 3, 5, 8, 13, 21.
    ``priority_weight`` must be > 0 (default is 1.0 when absent).
    """
    if _WRITER_PATH is None or _SCHEDULER is None:
        raise HTTPException(status_code=500, detail="scheduler module not configured")

    if not _WRITER_PATH.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "event-writer.mjs not found", "code": "ERR_WRITER_MISSING"},
        )

    event_payload = {
        "event_type":     "TASK_PRIORITY_SET",
        "engine_version":  payload.engine_version,
        "timestamp":       payload.timestamp,
        "task_id":         payload.task_id,
        "agent":           payload.agent,
        "role":            payload.role,
        "model":           None,
        "priority_weight": payload.priority_weight,
        "execution_cost":  float(payload.execution_cost),
        "reason":          payload.reason,
    }

    result = _run_node(_WRITER_PATH, [], stdin_data=json.dumps(event_payload))

    if not result.get("ok"):
        return JSONResponse(status_code=_http_status_for(result), content=result)

    # Refresh queue in background (best-effort)
    if _SCHEDULER.exists():
        _run_node(_SCHEDULER, [], timeout=20)

    return JSONResponse(status_code=200, content={
        "ok":    True,
        "event": result.get("event", {}),
    })


@decision_router.post("/priority", summary="Set decision priority")
async def set_decision_priority(payload: SetPriorityRequest) -> JSONResponse:
    return await set_priority(payload)


# ---------------------------------------------------------------------------
# POST /scheduler/priority/clear
# ---------------------------------------------------------------------------

@router.post("/priority/clear", summary="Clear task priority (TASK_PRIORITY_CLEARED event)")
async def clear_priority(payload: ClearPriorityRequest) -> JSONResponse:
    """
    Write a ``TASK_PRIORITY_CLEARED`` event, resetting the task to default
    scheduler priority (weight=1.0, cost=1).
    """
    if _WRITER_PATH is None:
        raise HTTPException(status_code=500, detail="scheduler module not configured")

    if not _WRITER_PATH.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "event-writer.mjs not found", "code": "ERR_WRITER_MISSING"},
        )

    event_payload = {
        "event_type":     "TASK_PRIORITY_CLEARED",
        "engine_version":  payload.engine_version,
        "timestamp":       payload.timestamp,
        "task_id":         payload.task_id,
        "agent":           payload.agent,
        "role":            payload.role,
        "model":           None,
        "priority_weight": None,
        "execution_cost":  None,
        "reason":          payload.reason,
    }

    result = _run_node(_WRITER_PATH, [], stdin_data=json.dumps(event_payload))

    if not result.get("ok"):
        return JSONResponse(status_code=_http_status_for(result), content=result)

    # Refresh queue
    if _SCHEDULER and _SCHEDULER.exists():
        _run_node(_SCHEDULER, [], timeout=20)

    return JSONResponse(status_code=200, content={
        "ok":    True,
        "event": result.get("event", {}),
    })


@decision_router.post("/priority/clear", summary="Clear decision priority")
async def clear_decision_priority(payload: ClearPriorityRequest) -> JSONResponse:
    return await clear_priority(payload)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _read_json(p: Path) -> dict[str, Any] | None:
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
