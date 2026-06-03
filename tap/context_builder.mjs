/**
 * context_builder.mjs — TAP context assembly for event-os-core
 *
 * Reads the frozen world state (registry, queue, agents, economy) and
 * assembles a structured context object for the LLM TAP layer.
 *
 * CONTRACT: READ ONLY. Never writes. Never modifies scheduler state.
 *
 * Status: PENDING IMPLEMENTATION (see TAP_SPEC.md)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT    = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOCKS   = path.join(ROOT, '.task-locks');
const SCHED   = path.join(LOCKS, 'scheduler');
const AGENTS  = path.join(LOCKS, 'agents');
const ECONOMY = path.join(ROOT, 'economy');

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch { return null; }
}

/**
 * Assemble the current world context for the TAP LLM.
 * All reads are from cached projections — no live I/O to TASK_EVENTS.jsonl.
 *
 * @returns {object}
 */
export function buildContext() {
  return {
    world_snapshot_hash: readJson(path.join(SCHED, 'queue.json'))?.world_snapshot?.world_snapshot_hash ?? null,
    tasks:              readJson(path.join(LOCKS, 'registry.json'))?.tasks ?? [],
    agents:             readJson(path.join(AGENTS, 'registry.json'))?.agents ?? [],
    leases:             readJson(path.join(AGENTS, 'leases.json'))?.leases ?? [],
    scheduler_queue:    readJson(path.join(SCHED, 'queue.json'))?.queue ?? [],
    runtime_status:     readJson(path.join(SCHED, 'runtime_status.json'))?.monitored ?? [],
    economy:            readJson(path.join(ECONOMY, 'market_state.json'))?.tasks ?? {},
  };
}
