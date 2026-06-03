#!/usr/bin/env bash
# start.sh - Boot the Decision Fabric + COI runtime
# decision/
#
# Usage:
#   cd decision && bash start.sh
#   bash decision/start.sh                    (from project root)
#
# Process topology:
#   [1] Node.js  — Projection Engine   (localhost:7338)
#         Watches inbox/outbox, rebuilds projection.json + last_event.json
#   [2] Python   — FastAPI server      (localhost:7337)
#         All GETs read from projection cache; typed SSE push
#
# COI       : http://localhost:7337/
# API Docs  : http://localhost:7337/docs
# Health    : http://localhost:7337/health
# Engine    : http://localhost:7338/health
#
# Stop: Ctrl+C  (both processes are cleaned up automatically)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$SCRIPT_DIR/.venv"
REQ="$SCRIPT_DIR/api/requirements.txt"
PROJ_DIR="$SCRIPT_DIR/projection"

cd "$SCRIPT_DIR"

# ─────────────────────────────────────────────────────────────
# Colour helpers (gracefully degrade if no tty)
# ─────────────────────────────────────────────────────────────
if [[ -t 1 ]]; then
  C_RESET='\033[0m'
  C_BOLD='\033[1m'
  C_BLUE='\033[34m'
  C_GREEN='\033[32m'
  C_YELLOW='\033[33m'
  C_RED='\033[31m'
  C_DIM='\033[2m'
else
  C_RESET='' C_BOLD='' C_BLUE='' C_GREEN='' C_YELLOW='' C_RED='' C_DIM=''
fi

info()    { echo -e "${C_BLUE}[start]${C_RESET} $*"; }
success() { echo -e "${C_GREEN}[start]${C_RESET} $*"; }
warn()    { echo -e "${C_YELLOW}[start]${C_RESET} $*"; }
error()   { echo -e "${C_RED}[start]${C_RESET} $*" >&2; }

# ─────────────────────────────────────────────────────────────
# Node.js — Projection Engine
# ─────────────────────────────────────────────────────────────
NODE_PID=""

start_projection_engine() {
  if ! command -v node >/dev/null 2>&1; then
    warn "Node.js not found — projection engine will not start."
    warn "Install Node.js ≥18 to enable live projection caching and typed SSE."
    warn "FastAPI will still run but GET endpoints will serve empty data until"
    warn "a projection.json is present."
    return
  fi

  local node_ver
  node_ver=$(node --version 2>/dev/null || echo "?")
  info "Node.js $node_ver found."

  # Install npm dependencies if not already present
  if [[ ! -d "$PROJ_DIR/node_modules" ]]; then
    info "Installing projection engine dependencies (npm install)…"
    (cd "$PROJ_DIR" && npm install --silent) || {
      error "npm install failed. Projection engine will not start."
      return
    }
  fi

  info "Starting projection engine…"
  node "$PROJ_DIR/engine.js" &
  NODE_PID=$!
  success "Projection engine started  (pid $NODE_PID)  →  http://localhost:7338/health"

  # Give it a moment to complete the initial build before FastAPI starts
  sleep 0.8
}

# ─────────────────────────────────────────────────────────────
# Python — FastAPI server
# ─────────────────────────────────────────────────────────────
PYTHON_PID=""

start_fastapi() {
  # ── Python venv ──────────────────────────────────────────
  if [[ ! -d "$VENV" ]]; then
    info "Creating Python virtual environment…"
    python3 -m venv "$VENV"
  fi

  # Activate: Git Bash on Windows uses Scripts/activate; Linux/macOS uses bin/activate
  if [[ -f "$VENV/Scripts/activate" ]]; then
    # shellcheck disable=SC1091
    source "$VENV/Scripts/activate"
  elif [[ -f "$VENV/bin/activate" ]]; then
    # shellcheck disable=SC1091
    source "$VENV/bin/activate"
  else
    error "Could not find venv activation script in $VENV"
    return 1
  fi

  # ── Dependencies ─────────────────────────────────────────
  if ! python -c "import fastapi" 2>/dev/null; then
    info "Installing Python dependencies…"
    pip install -q -r "$REQ"
  fi

  info "Starting FastAPI server…"
  python api/server.py &
  PYTHON_PID=$!
  success "FastAPI server started        (pid $PYTHON_PID)  →  http://localhost:7337/"
}

# ─────────────────────────────────────────────────────────────
# Graceful shutdown — kill both child processes on Ctrl+C / SIGTERM
# ─────────────────────────────────────────────────────────────
cleanup() {
  echo ""
  info "Shutting down…"

  if [[ -n "$PYTHON_PID" ]] && kill -0 "$PYTHON_PID" 2>/dev/null; then
    info "Stopping FastAPI           (pid $PYTHON_PID)…"
    kill "$PYTHON_PID" 2>/dev/null || true
    wait "$PYTHON_PID" 2>/dev/null || true
  fi

  if [[ -n "$NODE_PID" ]] && kill -0 "$NODE_PID" 2>/dev/null; then
    info "Stopping projection engine (pid $NODE_PID)…"
    kill "$NODE_PID" 2>/dev/null || true
    wait "$NODE_PID" 2>/dev/null || true
  fi

  success "All processes stopped. Goodbye."
  exit 0
}

trap cleanup INT TERM

# ─────────────────────────────────────────────────────────────
# Banner
# ─────────────────────────────────────────────────────────────
echo ""
echo -e "${C_BOLD}Decision Fabric + COI${C_RESET}"
echo -e "${C_DIM}──────────────────────────────────────────────────────${C_RESET}"
echo -e "  COI           →  ${C_GREEN}http://localhost:7337/${C_RESET}"
echo -e "  API Docs      →  ${C_GREEN}http://localhost:7337/docs${C_RESET}"
echo -e "  Health        →  ${C_GREEN}http://localhost:7337/health${C_RESET}"
echo -e "  Engine Health →  ${C_GREEN}http://localhost:7338/health${C_RESET}"
echo ""
echo -e "  Inbox         →  core/inbox.md"
echo -e "  Outbox        →  core/outbox.md"
echo -e "  Projection    →  core/projection.json"
echo -e "  Last event    →  core/last_event.json"
echo ""
echo -e "  CLI:  ${C_DIM}cli/send.sh \"Topic\"      — write to inbox${C_RESET}"
echo -e "        ${C_DIM}cli/reply.sh \"Topic\" ref  — write to outbox${C_RESET}"
echo -e "        ${C_DIM}cli/show.sh               — view both${C_RESET}"
echo ""
echo -e "  Stop: ${C_BOLD}Ctrl+C${C_RESET}"
echo -e "${C_DIM}──────────────────────────────────────────────────────${C_RESET}"
echo ""

# ─────────────────────────────────────────────────────────────
# Start both processes
# ─────────────────────────────────────────────────────────────
start_projection_engine
start_fastapi

# ─────────────────────────────────────────────────────────────
# Wait — keep the shell alive until both processes exit or Ctrl+C
# ─────────────────────────────────────────────────────────────
echo ""
success "Both processes running. Watching for Ctrl+C…"
echo ""

# Wait for the FastAPI process (primary).  If it exits unexpectedly, clean up.
wait "$PYTHON_PID" 2>/dev/null || true
cleanup
