"""
ideas.py - Idea Factory API.

This router exposes the v2 pipeline:
idea -> prompt pack -> architecture -> task graph -> task events -> bids.

It never writes TASK_EVENTS.jsonl directly. Submit calls engine/idea-factory.mjs,
which in turn writes through .task-locks/event-writer.mjs.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator

_PROJECT_ROOT: Path | None = None
_FACTORY: Path | None = None
_COMPILER: Path | None = None
_MARKET: Path | None = None


def configure(project_root: Path) -> None:
    global _PROJECT_ROOT, _FACTORY, _COMPILER, _MARKET
    _PROJECT_ROOT = project_root
    _FACTORY = project_root / "engine" / "idea-factory.mjs"
    _COMPILER = project_root / "engine" / "idea-compiler.mjs"
    _MARKET = project_root / "economy" / "market_state.json"


class IdeaRequest(BaseModel):
    content: str
    source: str = "ui"
    dry_run: bool = False
    with_bids: bool = True

    @field_validator("content")
    @classmethod
    def content_nonempty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("content must not be empty")
        return value

    @field_validator("source")
    @classmethod
    def source_valid(cls, value: str) -> str:
        allowed = {"ui", "llm", "api", "system"}
        if value not in allowed:
            raise ValueError(f"source must be one of {sorted(allowed)}")
        return value


router = APIRouter(prefix="/ideas", tags=["Idea Factory"])


def _require(path: Optional[Path], label: str) -> Path:
    if path is None:
        raise HTTPException(status_code=500, detail=f"{label} not configured")
    if not path.exists():
        raise HTTPException(status_code=503, detail=f"{label} not found at {path}")
    return path


def _run_node(script: Path, args: list[str], stdin: str | None = None, timeout: int = 45) -> dict[str, Any]:
    result = subprocess.run(
        ["node", str(script), *args],
        input=stdin.encode("utf-8") if stdin is not None else None,
        capture_output=True,
        timeout=timeout,
    )
    stdout = result.stdout.decode("utf-8", errors="replace").strip()
    stderr = result.stderr.decode("utf-8", errors="replace").strip()
    try:
        data = json.loads(stdout or "{}")
    except json.JSONDecodeError:
        return {"ok": False, "error": "node script returned non-JSON output", "stdout": stdout, "stderr": stderr}
    if result.returncode != 0 and data.get("ok") is not True:
        data.setdefault("ok", False)
        data.setdefault("stderr", stderr)
    return data


@router.post("/compile", summary="Compile an idea without writing events")
async def compile_idea(payload: IdeaRequest) -> JSONResponse:
    compiler = _require(_COMPILER, "idea-compiler.mjs")
    data = _run_node(compiler, [payload.content], timeout=20)
    return JSONResponse(status_code=200 if data else 500, content={"ok": True, "architecture": data})


@router.post("/submit", summary="Submit an idea and materialize architecture, tasks, and bids")
async def submit_idea(payload: IdeaRequest) -> JSONResponse:
    factory = _require(_FACTORY, "idea-factory.mjs")
    args = ["--json", "--source", payload.source]
    if payload.dry_run:
        args.append("--dry-run")
    if not payload.with_bids:
        args.append("--no-bids")
    data = _run_node(factory, args, stdin=payload.content, timeout=90)
    return JSONResponse(status_code=200 if data.get("ok") else 500, content=data)


@router.get("/market", summary="Current bid market projection")
async def market_state() -> JSONResponse:
    market = _require(_MARKET, "market_state.json")
    try:
        return JSONResponse(status_code=200, content=json.loads(market.read_text(encoding="utf-8")))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"could not read market_state.json: {exc}")
