"""
health.py - Health check endpoint for the Decision Fabric API.

GET /health returns the operational status of the server and whether
the core data files and dashboard asset exist.
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter

router = APIRouter(tags=["Health"])

# Resolved by server.py at import time via dependency injection
_INBOX:     Path | None = None
_OUTBOX:    Path | None = None
_META:      Path | None = None
_DASHBOARD: Path | None = None


def configure(inbox: Path, outbox: Path, meta: Path, dashboard: Path) -> None:
    """Called once by server.py after path resolution."""
    global _INBOX, _OUTBOX, _META, _DASHBOARD
    _INBOX     = inbox
    _OUTBOX    = outbox
    _META      = meta
    _DASHBOARD = dashboard


@router.get("/health", summary="Server status and file availability")
def health() -> dict:
    return {
        "status": "ok",
        "files": {
            "inbox":     _INBOX.exists()     if _INBOX     else False,
            "outbox":    _OUTBOX.exists()    if _OUTBOX    else False,
            "meta":      _META.exists()      if _META      else False,
            "coi":       _DASHBOARD.exists() if _DASHBOARD else False,
        },
    }
