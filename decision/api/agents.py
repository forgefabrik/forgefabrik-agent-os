"""
agents.py — FastAPI endpoints for the Agent Runtime Layer.

Architecture:
    GET  endpoints read directly from .task-locks/agents/registry.json,
    leases.json, heartbeats/, and reputation/ (zero subprocess overhead).

    POST endpoints call the appropriate Node.js scripts as subprocesses,
    following the same pattern as events_gate.py:
        register     → event-writer.mjs (AGENT_REGISTERED) + agent-runtime.mjs rebuild
        heartbeat    → event-writer.mjs (TASK_HEARTBEAT or LEASE_RENEWED)
        acquire      → lease-manager.mjs acquire
        renew        → lease-manager.mjs renew
        release      → lease-manager.mjs release
        expire-check → lease-manager.mjs expire

Endpoints:
    GET  /agents                          List all agents
    GET  /agents/leases                   List all leases (active or all)
    GET  /agents/leases/active            List only ACTIVE leases
    GET  /agents/tasks/{task_id}/state    Compute task_runtime_state (ephemeral)
    POST /agents/register                 Register a new agent
    POST /agents/heartbeat                Send a heartbeat / renew lease
    POST /agents/leases/acquire           Acquire a task lease
    POST /agents/leases/renew             Renew an active lease
    POST /agents/leases/release           Release an active lease
    POST /agents/leases/expire-check      Detect and mark expired leases
    GET  /agents/{agent_id}               Get agent details + reputation
    GET  /agents/{agent_id}/leases        Get leases held by an agent

Boundary rule: NEVER writes to TASK_EVENTS.jsonl directly.
               All event writes go through event-writer.mjs.
               All lease mutations go through lease-manager.mjs.
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

log = logging.getLogger("comm.agents")

# ---------------------------------------------------------------------------
# Paths — configured once by server.py
# ---------------------------------------------------------------------------

_PROJECT_ROOT:  Path | None = None
_AGENTS_DIR:    Path | None = None
_WRITER_PATH:   Path | None = None
_LEASE_MGR:     Path | None = None
_AGENT_RUNTIME: Path | None = None
_EVENTS_PATH:   Path | None = None


def configure(project_root: Path) -> None:
    """Called once by server.py after path resolution."""
    global _PROJECT_ROOT, _AGENTS_DIR, _WRITER_PATH, _LEASE_MGR, _AGENT_RUNTIME, _EVENTS_PATH
    _PROJECT_ROOT  = project_root
    _AGENTS_DIR    = project_root / ".task-locks" / "agents"
    _WRITER_PATH   = project_root / ".task-locks" / "event-writer.mjs"
    _LEASE_MGR     = project_root / ".task-locks" / "lease-manager.mjs"
    _AGENT_RUNTIME = project_root / ".task-locks" / "agent-runtime.mjs"
    _EVENTS_PATH   = project_root / "TASK_EVENTS.jsonl"
    log.info(
        "Agents gate configured  agents_dir=%s",
        _AGENTS_DIR,
    )


def _require_configured() -> Path:
    if _AGENTS_DIR is None:
        raise HTTPException(status_code=500, detail="agents module not configured")
    return _AGENTS_DIR


# ---------------------------------------------------------------------------
# Known roles
# ---------------------------------------------------------------------------

KNOWN_ROLES: frozenset[str] = frozenset({
    "IMPLEMENTATION", "REFACTOR", "REVIEW", "ARCHITECT"
})

# ---------------------------------------------------------------------------
# Pydantic request models
# ---------------------------------------------------------------------------


class AgentRegisterRequest(BaseModel):
    """Payload for POST /agents/register."""

    agent_id:      str
    capabilities:  list[str]
    model:         Optional[str] = None
    timestamp:     str
    engine_version: int

    @field_validator("agent_id")
    @classmethod
    def agent_id_nonempty(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("agent_id must not be empty")
        return v.strip()

    @field_validator("capabilities", mode="before")
    @classmethod
    def capabilities_valid(cls, v: list[str]) -> list[str]:
        for cap in v:
            if cap not in KNOWN_ROLES:
                raise ValueError(f'"{cap}" is not a valid role. Valid: {sorted(KNOWN_ROLES)}')
        if not v:
            raise ValueError("capabilities must not be empty")
        return v

    @field_validator("timestamp")
    @classmethod
    def timestamp_iso(cls, v: str) -> str:
        import re
        if not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}", v):
            raise ValueError(f"timestamp must be ISO-8601, got: {v!r}")
        return v


class HeartbeatRequest(BaseModel):
    """Payload for POST /agents/heartbeat."""

    agent_id:      str
    task_id:       str
    role:          str
    timestamp:     str
    engine_version: int
    renew_lease:   bool = False  # if True, also renew the active lease via lease-manager

    @field_validator("role")
    @classmethod
    def role_valid(cls, v: str) -> str:
        if v not in KNOWN_ROLES:
            raise ValueError(f'"{v}" is not a valid role')
        return v


class LeaseAcquireRequest(BaseModel):
    """Payload for POST /agents/leases/acquire."""

    agent_id:    str
    task_id:     str
    role:        str
    ttl_seconds: Optional[int] = None
    timestamp:   str

    @field_validator("role")
    @classmethod
    def role_valid(cls, v: str) -> str:
        if v not in KNOWN_ROLES:
            raise ValueError(f'"{v}" is not a valid role')
        return v


class LeaseRenewRequest(BaseModel):
    """Payload for POST /agents/leases/renew."""

    agent_id:      str
    task_id:       str
    ttl_seconds:   Optional[int] = None
    timestamp:     str
    engine_version: int


class LeaseReleaseRequest(BaseModel):
    """Payload for POST /agents/leases/release."""

    agent_id:      str
    task_id:       str
    timestamp:     str
    engine_version: int


class ExpireCheckRequest(BaseModel):
    """Payload for POST /agents/leases/expire-check."""

    timestamp:     str
    engine_version: int


# ---------------------------------------------------------------------------
# Subprocess helpers
# ---------------------------------------------------------------------------

def _run_node(
    script: Path,
    args: list[str],
    stdin_data: str | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """
    Run a Node.js script as a subprocess with --json flag.
    Returns parsed JSON output or an error dict.
    """
    cmd = ["node", str(script), "--json"] + args
    try:
        result = subprocess.run(
            cmd,
            input=stdin_data.encode("utf-8") if stdin_data else None,
            capture_output=True,
            timeout=timeout,
        )
    except FileNotFoundError:
        return {"ok": False, "error": "node binary not found. Install Node.js ≥ 18.", "code": "ERR_NODE_MISSING"}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": f"{script.name} timed out ({timeout} s)", "code": "ERR_TIMEOUT"}

    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    stderr = result.stderr.decode("utf-8", errors="replace").strip()

    if stderr:
        log.warning("%s stderr: %s", script.name, stderr[:500])

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
    if code in ("ERR_VALIDATION", "ERR_REVIEW_GATE", "ERR_SLOT_OCCUPIED",
                "ERR_NO_ACTIVE_LEASE", "ERR_TASK_NOT_FOUND"):
        return 400
    return 500


# ---------------------------------------------------------------------------
# Registry + lease file readers
# ---------------------------------------------------------------------------

def _read_agent_registry(agents_dir: Path) -> dict[str, Any]:
    reg_path = agents_dir / "registry.json"
    if not reg_path.exists():
        return {"schema_version": "1.0.0", "generated_at": None, "event_count": 0, "agents": []}
    return json.loads(reg_path.read_text(encoding="utf-8"))


def _read_leases(agents_dir: Path) -> dict[str, Any]:
    leases_path = agents_dir / "leases.json"
    if not leases_path.exists():
        return {"schema_version": "1.0.0", "generated_at": None, "leases": []}
    return json.loads(leases_path.read_text(encoding="utf-8"))


def _read_reputation(agents_dir: Path, agent_id: str) -> dict[str, Any] | None:
    safe = agent_id.replace("/", "_").replace("\\", "_")
    p    = agents_dir / "reputation" / f"{safe}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


def _read_heartbeat(agents_dir: Path, agent_id: str) -> dict[str, Any] | None:
    safe = agent_id.replace("/", "_").replace("\\", "_")
    p    = agents_dir / "heartbeats" / f"{safe}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Router
# ---------------------------------------------------------------------------

router = APIRouter(prefix="/agents", tags=["Agent Runtime"])


# ---------------------------------------------------------------------------
# GET /agents — list all agents
# ---------------------------------------------------------------------------

@router.get("", summary="List all registered agents")
async def list_agents(status: Optional[str] = None) -> JSONResponse:
    """
    Return all agents from agents/registry.json.

    Optional ``?status=ACTIVE`` (or ``SUSPENDED``/``DEREGISTERED``) to filter.
    """
    agents_dir = _require_configured()
    reg        = _read_agent_registry(agents_dir)
    agents     = reg.get("agents", [])

    if status:
        agents = [a for a in agents if a.get("status") == status.upper()]

    return JSONResponse(status_code=200, content={
        "ok":           True,
        "count":        len(agents),
        "agents":       agents,
        "generated_at": reg.get("generated_at"),
    })


# ---------------------------------------------------------------------------
# GET /agents/leases — all leases
# ---------------------------------------------------------------------------

@router.get("/leases", summary="List all leases (active and historical)")
async def list_leases(active_only: bool = False) -> JSONResponse:
    """
    Return all leases from agents/leases.json.

    Pass ``?active_only=true`` to return only ACTIVE leases.
    """
    agents_dir = _require_configured()
    store      = _read_leases(agents_dir)
    leases     = store.get("leases", [])

    if active_only:
        leases = [l for l in leases if l.get("status") == "ACTIVE"]

    return JSONResponse(status_code=200, content={
        "ok":           True,
        "count":        len(leases),
        "leases":       leases,
        "generated_at": store.get("generated_at"),
    })


# ---------------------------------------------------------------------------
# GET /agents/leases/active — convenience alias
# ---------------------------------------------------------------------------

@router.get("/leases/active", summary="List only ACTIVE leases")
async def list_active_leases() -> JSONResponse:
    """Convenience alias for GET /agents/leases?active_only=true."""
    agents_dir = _require_configured()
    store      = _read_leases(agents_dir)
    leases     = [l for l in store.get("leases", []) if l.get("status") == "ACTIVE"]

    return JSONResponse(status_code=200, content={
        "ok":     True,
        "count":  len(leases),
        "leases": leases,
    })


# ---------------------------------------------------------------------------
# GET /agents/tasks/{task_id}/state — compute task_runtime_state
# ---------------------------------------------------------------------------

@router.get(
    "/tasks/{task_id}/state",
    summary="Compute ephemeral task_runtime_state (review gate + stability)",
)
async def get_task_runtime_state(task_id: str) -> JSONResponse:
    """
    Call agent-runtime.mjs to compute the ephemeral task_runtime_state document.

    Returns:
    * ``review_gate``  — three-part gate (claim_bound, stability_bound, finalization_bound)
    * ``review_legal`` — composite gate flag
    * ``implementation_stability`` — heartbeat liveness check

    This endpoint performs file I/O (reads TASK_EVENTS.jsonl) and is not cached.
    """
    if _AGENT_RUNTIME is None:
        raise HTTPException(status_code=500, detail="agents module not configured")

    if not _AGENT_RUNTIME.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "agent-runtime.mjs not found", "code": "ERR_RUNTIME_MISSING"},
        )

    result = _run_node(_AGENT_RUNTIME, ["state", "--task", task_id])

    if not result.get("ok"):
        return JSONResponse(
            status_code=_http_status_for(result),
            content=result,
        )

    return JSONResponse(status_code=200, content=result)


# ---------------------------------------------------------------------------
# POST /agents/register — register a new agent
# ---------------------------------------------------------------------------

@router.post(
    "/register",
    summary="Register a new agent (writes AGENT_REGISTERED event)",
)
async def register_agent(payload: AgentRegisterRequest) -> JSONResponse:
    """
    Register a new agent by appending an ``AGENT_REGISTERED`` event to
    ``TASK_EVENTS.jsonl`` via ``event-writer.mjs``, then triggering an
    ``agent-runtime.mjs rebuild`` to refresh ``agents/registry.json``.

    The ``notes`` field is constructed as:
    ``capabilities=[CAP1,CAP2] model=<model>``
    """
    if _WRITER_PATH is None or _AGENT_RUNTIME is None:
        raise HTTPException(status_code=500, detail="agents module not configured")

    caps_str = ",".join(payload.capabilities)
    notes    = f"capabilities=[{caps_str}]"
    if payload.model:
        notes += f" model={payload.model}"

    event_payload = {
        "event_type":     "AGENT_REGISTERED",
        "engine_version":  payload.engine_version,
        "timestamp":       payload.timestamp,
        "task_id":         None,
        "agent":           payload.agent_id,
        "role":            None,
        "model":           payload.model,
        "notes":           notes,
    }

    # ── Write event ───────────────────────────────────────────────
    if not _WRITER_PATH.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "event-writer.mjs not found", "code": "ERR_WRITER_MISSING"},
        )

    result = _run_node(_WRITER_PATH, [], stdin_data=json.dumps(event_payload))

    if not result.get("ok"):
        return JSONResponse(
            status_code=_http_status_for(result),
            content=result,
        )

    # ── Trigger registry rebuild ──────────────────────────────────
    if _AGENT_RUNTIME.exists():
        rebuild = _run_node(_AGENT_RUNTIME, ["rebuild"])
        log.info(
            "Agent %s registered (idx=%s). Registry rebuild: %s",
            payload.agent_id,
            result.get("event", {}).get("event_index"),
            rebuild.get("ok"),
        )

    return JSONResponse(status_code=200, content={
        "ok":    True,
        "event": result.get("event", {}),
        "notes": notes,
    })


# ---------------------------------------------------------------------------
# POST /agents/heartbeat — send heartbeat
# ---------------------------------------------------------------------------

@router.post(
    "/heartbeat",
    summary="Send an agent heartbeat (TASK_HEARTBEAT or LEASE_RENEWED)",
)
async def agent_heartbeat(payload: HeartbeatRequest) -> JSONResponse:
    """
    Emit a heartbeat for an active task lock.

    If ``renew_lease=true``, the endpoint also calls ``lease-manager.mjs renew``
    to extend the lease in ``agents/leases.json`` and emit a ``LEASE_RENEWED``
    event.  Otherwise, only a ``TASK_HEARTBEAT`` event is written.
    """
    if _WRITER_PATH is None:
        raise HTTPException(status_code=500, detail="agents module not configured")

    if not _WRITER_PATH.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "event-writer.mjs not found", "code": "ERR_WRITER_MISSING"},
        )

    event_payload = {
        "event_type":     "TASK_HEARTBEAT",
        "engine_version":  payload.engine_version,
        "timestamp":       payload.timestamp,
        "task_id":         payload.task_id,
        "agent":           payload.agent_id,
        "role":            payload.role,
        "model":           None,
    }

    result = _run_node(_WRITER_PATH, [], stdin_data=json.dumps(event_payload))

    if not result.get("ok"):
        return JSONResponse(
            status_code=_http_status_for(result),
            content=result,
        )

    # Optionally renew the lease
    renew_result: dict[str, Any] | None = None
    if payload.renew_lease and _LEASE_MGR and _LEASE_MGR.exists():
        renew_result = _run_node(
            _LEASE_MGR,
            [
                "renew",
                "--agent", payload.agent_id,
                "--task",  payload.task_id,
                "--timestamp", payload.timestamp,
            ],
        )
        if not renew_result.get("ok"):
            log.warning(
                "Heartbeat written but lease renewal failed for agent=%s task=%s: %s",
                payload.agent_id, payload.task_id, renew_result.get("error"),
            )

    return JSONResponse(status_code=200, content={
        "ok":          True,
        "event":       result.get("event", {}),
        "lease_renew": renew_result,
    })


# ---------------------------------------------------------------------------
# POST /agents/leases/acquire — acquire lease
# ---------------------------------------------------------------------------

@router.post(
    "/leases/acquire",
    summary="Acquire a task lease (validate review gate for REVIEW role)",
)
async def acquire_lease(payload: LeaseAcquireRequest) -> JSONResponse:
    """
    Call ``lease-manager.mjs acquire`` to atomically claim a task slot.

    For ``REVIEW`` and ``ARCHITECT`` roles, the three-part review gate is
    evaluated first.  Returns ``409 Conflict`` if the slot is occupied or the
    gate is not satisfied.
    """
    if _LEASE_MGR is None:
        raise HTTPException(status_code=500, detail="agents module not configured")

    if not _LEASE_MGR.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "lease-manager.mjs not found", "code": "ERR_LEASE_MGR_MISSING"},
        )

    args = [
        "acquire",
        "--agent",     payload.agent_id,
        "--task",      payload.task_id,
        "--role",      payload.role,
        "--timestamp", payload.timestamp,
    ]
    if payload.ttl_seconds is not None:
        args += ["--ttl", str(payload.ttl_seconds)]

    result = _run_node(_LEASE_MGR, args)

    if not result.get("ok"):
        code = result.get("code", "")
        http_status = 409 if code in ("ERR_SLOT_OCCUPIED", "ERR_REVIEW_GATE") else _http_status_for(result)
        return JSONResponse(status_code=http_status, content=result)

    log.info(
        "Lease acquired: agent=%s task=%s role=%s",
        payload.agent_id, payload.task_id, payload.role,
    )
    return JSONResponse(status_code=200, content=result)


# ---------------------------------------------------------------------------
# POST /agents/leases/renew — renew lease
# ---------------------------------------------------------------------------

@router.post(
    "/leases/renew",
    summary="Renew an active lease (emits LEASE_RENEWED)",
)
async def renew_lease(payload: LeaseRenewRequest) -> JSONResponse:
    """
    Extend an existing ACTIVE lease and emit ``LEASE_RENEWED``.
    Returns ``404`` if no active lease is found.
    """
    if _LEASE_MGR is None:
        raise HTTPException(status_code=500, detail="agents module not configured")

    if not _LEASE_MGR.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "lease-manager.mjs not found", "code": "ERR_LEASE_MGR_MISSING"},
        )

    args = [
        "renew",
        "--agent",     payload.agent_id,
        "--task",      payload.task_id,
        "--timestamp", payload.timestamp,
    ]
    if payload.ttl_seconds is not None:
        args += ["--ttl", str(payload.ttl_seconds)]

    result = _run_node(_LEASE_MGR, args)

    if not result.get("ok"):
        code        = result.get("code", "")
        http_status = 404 if code == "ERR_NO_ACTIVE_LEASE" else _http_status_for(result)
        return JSONResponse(status_code=http_status, content=result)

    return JSONResponse(status_code=200, content=result)


# ---------------------------------------------------------------------------
# POST /agents/leases/release — release lease
# ---------------------------------------------------------------------------

@router.post(
    "/leases/release",
    summary="Voluntarily release an active lease (emits TASK_RELEASED)",
)
async def release_lease(payload: LeaseReleaseRequest) -> JSONResponse:
    """
    Mark an ACTIVE lease as RELEASED and emit ``TASK_RELEASED``.
    Returns ``404`` if no active lease is found.
    """
    if _LEASE_MGR is None:
        raise HTTPException(status_code=500, detail="agents module not configured")

    if not _LEASE_MGR.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "lease-manager.mjs not found", "code": "ERR_LEASE_MGR_MISSING"},
        )

    result = _run_node(
        _LEASE_MGR,
        [
            "release",
            "--agent",     payload.agent_id,
            "--task",      payload.task_id,
            "--timestamp", payload.timestamp,
        ],
    )

    if not result.get("ok"):
        code        = result.get("code", "")
        http_status = 404 if code == "ERR_NO_ACTIVE_LEASE" else _http_status_for(result)
        return JSONResponse(status_code=http_status, content=result)

    return JSONResponse(status_code=200, content=result)


# ---------------------------------------------------------------------------
# POST /agents/leases/expire-check — detect expired leases
# ---------------------------------------------------------------------------

@router.post(
    "/leases/expire-check",
    summary="Detect and expire overdue leases (emits LEASE_EXPIRED per lease)",
)
async def expire_check(payload: ExpireCheckRequest) -> JSONResponse:
    """
    Scan ``leases.json`` for leases whose ``expires_at`` is before
    ``payload.timestamp``, mark them EXPIRED, and emit ``LEASE_EXPIRED``
    for each one.

    Intended to be called by a CI cron job or the scheduler after every
    push (not by individual agents).
    """
    if _LEASE_MGR is None:
        raise HTTPException(status_code=500, detail="agents module not configured")

    if not _LEASE_MGR.exists():
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": "lease-manager.mjs not found", "code": "ERR_LEASE_MGR_MISSING"},
        )

    result = _run_node(
        _LEASE_MGR,
        ["expire", "--timestamp", payload.timestamp],
    )

    status = 200 if result.get("ok") else 500
    return JSONResponse(status_code=status, content=result)


# ---------------------------------------------------------------------------
# GET /agents/{agent_id} — single agent detail
# NOTE: This route MUST be defined after all /agents/<literal> routes to
# avoid capturing "leases", "register", "heartbeat", etc. as agent_id values.
# ---------------------------------------------------------------------------

@router.get("/{agent_id}", summary="Get agent details, reputation, and heartbeat status")
async def get_agent(agent_id: str) -> JSONResponse:
    """
    Return a single agent's registry record, reputation score, and heartbeat
    status by combining agents/registry.json, reputation/<id>.json, and
    heartbeats/<id>.json.
    """
    agents_dir = _require_configured()
    reg        = _read_agent_registry(agents_dir)
    agents     = reg.get("agents", [])
    agent      = next((a for a in agents if a.get("agent_id") == agent_id), None)

    if agent is None:
        raise HTTPException(status_code=404, detail=f"Agent '{agent_id}' not found")

    reputation = _read_reputation(agents_dir, agent_id)
    heartbeat  = _read_heartbeat(agents_dir, agent_id)

    return JSONResponse(status_code=200, content={
        "ok":         True,
        "agent":      agent,
        "reputation": reputation,
        "heartbeat":  heartbeat,
    })


# ---------------------------------------------------------------------------
# GET /agents/{agent_id}/leases — agent's leases
# ---------------------------------------------------------------------------

@router.get("/{agent_id}/leases", summary="Get all leases for a specific agent")
async def get_agent_leases(agent_id: str, active_only: bool = False) -> JSONResponse:
    """Return all leases held by the given agent."""
    agents_dir = _require_configured()
    store      = _read_leases(agents_dir)
    leases     = [l for l in store.get("leases", []) if l.get("agent_id") == agent_id]

    if active_only:
        leases = [l for l in leases if l.get("status") == "ACTIVE"]

    return JSONResponse(status_code=200, content={
        "ok":      True,
        "agent_id": agent_id,
        "count":   len(leases),
        "leases":  leases,
    })
