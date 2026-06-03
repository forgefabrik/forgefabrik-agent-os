#!/usr/bin/env node
// decision_engine.mjs - compatibility entrypoint for scheduler.mjs.
//
// The system model now names this layer the Decision Engine: it computes
// actionable decisions under deterministic constraints. scheduler.mjs remains
// the implementation target during the migration window.

await import('./scheduler.mjs');
