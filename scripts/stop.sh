#!/bin/bash
# stop.sh — Stop all event-os-core services

pkill -f "python3 api/server.py" 2>/dev/null && echo "  ✓  API server stopped" || echo "  –  API server was not running"
pkill -f "scheduler.mjs --watch"  2>/dev/null && echo "  ✓  Scheduler stopped"   || true
pkill -f "bid_projection.mjs"     2>/dev/null && echo "  ✓  Economy layer stopped" || true
echo "Done."
