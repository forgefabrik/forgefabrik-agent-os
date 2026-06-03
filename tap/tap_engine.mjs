/**
 * tap_engine.mjs — TAP orchestration engine for event-os-core
 *
 * Reads the world context, sends it to the LLM, and returns structured
 * suggestions. Output is written to tap/suggestions.json.
 *
 * CONTRACT: READ ONLY + ADVISORY OUTPUT.
 *   - Reads from: registry, queue, agents, economy, leases (all projections)
 *   - Writes to:  tap/suggestions.json ONLY
 *   - Never writes to TASK_EVENTS.jsonl
 *   - Never calls lease-manager or event-writer
 *   - LLM output is advisory — humans/operators decide whether to act
 *
 * TAP Modes:
 *   observe  — read-only context scan, no LLM call
 *   suggest  — full LLM analysis + suggestions output
 *
 * Usage:
 *   node tap/tap_engine.mjs [--mode observe|suggest] [--task <id>] [--json]
 *
 * Status: FUNCTIONAL (requires LM Studio for suggest mode)
 */

import fs   from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildContext }  from './context_builder.mjs';
import { callLLMJson }   from './llm_client.mjs';

const TAP_DIR    = path.dirname(fileURLToPath(import.meta.url));
const ROOT       = path.dirname(TAP_DIR);
const OUT_PATH   = path.join(TAP_DIR, 'suggestions.json');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const argv    = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const mode     = (() => { const i = argv.indexOf('--mode'); return i >= 0 ? argv[i + 1] : 'suggest'; })();
const taskFilter = (() => { const i = argv.indexOf('--task'); return i >= 0 ? argv[i + 1] : null; })();

// ---------------------------------------------------------------------------
// Suggestion schema (output structure)
// ---------------------------------------------------------------------------

const TASK_ANALYSIS_PROMPT = `
Analyze the current task queue and agent state.
For each schedulable task in the queue, provide:
  - risk: "low" | "medium" | "high"
  - recommendation: one-line action suggestion
  - bottleneck: true if this task is blocking others

Also identify:
  - top_priority_task: task_id of the single highest-priority unblocked task
  - anomalies: list of any unusual patterns (e.g., stalled tasks, idle agents)

Output format (strict JSON, no markdown):
{
  "tasks": [{"task_id": "...", "risk": "...", "recommendation": "...", "bottleneck": false}],
  "top_priority_task": "TASK-XXXX",
  "anomalies": ["..."],
  "summary": "..."
}
`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const context = buildContext();

  // Filter context to specific task if requested
  if (taskFilter) {
    context.scheduler_queue = context.scheduler_queue.filter(e => e.task_id === taskFilter);
    context.tasks           = context.tasks.filter(t => t.task_id === taskFilter);
  }

  let suggestions;

  if (mode === 'observe') {
    // Observe mode: no LLM call, just surface the current state
    suggestions = {
      mode:            'observe',
      generated_at:    new Date().toISOString(),
      task_count:      context.scheduler_queue.length,
      agent_count:     context.agents.length,
      active_leases:   context.leases.filter(l => l.status === 'ACTIVE').length,
      world_snapshot:  context.world_snapshot_hash ?? null,
      tasks:           [],
      top_priority_task: context.scheduler_queue[0]?.task_id ?? null,
      anomalies:       [],
      summary:         `Observe mode: ${context.scheduler_queue.length} schedulable tasks, ${context.agents.length} agents.`,
    };
  } else {
    // Suggest mode: call LLM for analysis
    if (!JSON_OUT) console.log('[tap] Calling LLM for task analysis...');

    const llmResult = await callLLMJson(TASK_ANALYSIS_PROMPT, context).catch(e => {
      console.error(`[tap] LLM call failed: ${e.message}`);
      return null;
    });

    suggestions = {
      mode:           'suggest',
      generated_at:   new Date().toISOString(),
      world_snapshot: context.world_snapshot_hash ?? null,
      ...(llmResult ?? {
        tasks:             [],
        top_priority_task: context.scheduler_queue[0]?.task_id ?? null,
        anomalies:         ['LLM unavailable — suggestions degraded to observe mode'],
        summary:           'LLM analysis failed. Run: bash lmstudio/install.sh',
      }),
    };
  }

  // Write suggestions (the only file this module may write)
  fs.writeFileSync(OUT_PATH, JSON.stringify(suggestions, null, 2) + '\n', 'utf8');

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(suggestions, null, 2) + '\n');
  } else {
    console.log(`[tap] ${suggestions.summary ?? 'Done.'}`);
    console.log(`[tap] Suggestions written to ${OUT_PATH}`);
  }
}

main().catch(err => {
  console.error('[tap] Fatal:', err);
  process.exit(2);
});
