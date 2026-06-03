"""
server.py - Cybernetic Operations Interface API server.

Starts the local FastAPI server for event-os-core/decision. The UI is an
operator control plane over cached communication projections plus the verified
task/event runtime exposed through explicit gate endpoints.
"""

from __future__ import annotations

import sys
from contextlib import asynccontextmanager
from pathlib import Path

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).parent.parent
PROJECT = BASE.parent
CORE = BASE / "core"
INBOX = CORE / "inbox.md"
OUTBOX = CORE / "outbox.md"
META = CORE / "meta.json"
UI_DIR = BASE / "ui"
VOICE_DIR = BASE / "voice"
DASHBOARD = UI_DIR / "dashboard.html"

sys.path.insert(0, str(BASE))

from api import agents as agents_module  # noqa: E402
from api import events_gate as events_gate_module  # noqa: E402
from api import health as health_module  # noqa: E402
from api import ideas as ideas_module  # noqa: E402
from api import projection as projection_module  # noqa: E402
from api import routes as routes_module  # noqa: E402
from api import scheduler as scheduler_module  # noqa: E402

health_module.configure(INBOX, OUTBOX, META, DASHBOARD)
routes_module.configure(INBOX, OUTBOX, META)
projection_module.configure(BASE)
events_gate_module.configure(PROJECT)
agents_module.configure(PROJECT)
scheduler_module.configure(PROJECT)
ideas_module.configure(PROJECT)


@asynccontextmanager
async def lifespan(app: FastAPI):  # type: ignore[type-arg]
    async with projection_module.lifespan_context():
        yield


app = FastAPI(
    title="Cybernetic Operations Interface",
    description=(
        "Local HTTP control plane for event-os-core. Communication reads use "
        "the cached projection layer; task/event writes pass through explicit "
        "gate endpoints and never write TASK_EVENTS.jsonl directly."
    ),
    version="4.0.0",
    lifespan=lifespan,
)

app.include_router(routes_module.router)
app.include_router(health_module.router)
app.include_router(events_gate_module.router)
app.include_router(agents_module.router)
app.include_router(scheduler_module.router)
app.include_router(ideas_module.router)
app.include_router(scheduler_module.decision_router)

if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")
if VOICE_DIR.exists():
    app.mount("/voice", StaticFiles(directory=str(VOICE_DIR)), name="voice")


@app.get("/", summary="Cybernetic Operations Interface", include_in_schema=False)
def dashboard() -> FileResponse:
    if not DASHBOARD.exists():
        raise HTTPException(status_code=404, detail="UI not found: ui/dashboard.html")
    return FileResponse(str(DASHBOARD), media_type="text/html")


if __name__ == "__main__":
    print()
    print("Cybernetic Operations Interface")
    print("  Control Plane -> http://localhost:7337/")
    print("  API Docs      -> http://localhost:7337/docs")
    print(f"  Base          -> {BASE}")
    print(f"  Project       -> {PROJECT}")
    print()

    uvicorn.run(
        "api.server:app",
        host="127.0.0.1",
        port=7337,
        reload=False,
        log_level="info",
        app_dir=str(BASE),
    )
