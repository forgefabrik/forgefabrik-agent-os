import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileIdea } from './idea-compiler.mjs';
import { materializeSyntheticBidEvents, materializeTaskEvents } from './task-graph-builder.mjs';

const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(ENGINE_DIR);
const REGISTRY = path.join(ROOT, '.task-locks', 'registry.json');
const WRITER = path.join(ROOT, '.task-locks', 'event-writer.mjs');
const BID_PROJECTION = path.join(ROOT, 'economy', 'bid_projection.mjs');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const DRY_RUN = argv.includes('--dry-run');
const WITH_BIDS = !argv.includes('--no-bids');

function argValue(name, fallback = null) {
  const i = argv.indexOf(name);
  if (i < 0) return fallback;
  const values = [];
  for (const value of argv.slice(i + 1)) {
    if (value.startsWith('--')) break;
    values.push(value);
  }
  return values.length > 0 ? values.join(' ') : fallback;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function readRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
}

function writeEvent(payload, rebuild = false) {
  if (DRY_RUN) return { ok: true, event: payload, dry_run: true };
  const args = [WRITER, '--json'];
  if (rebuild) args.push('--rebuild');
  const result = spawnSync('node', args, {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: ROOT,
  });
  const text = result.stdout.trim();
  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: 'event-writer returned non-JSON output',
      stdout: text,
      stderr: result.stderr,
      status: result.status,
    };
  }
}

function runBidProjection() {
  if (DRY_RUN) return { ok: true, dry_run: true };
  const result = spawnSync('node', [BID_PROJECTION, '--json'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  try {
    return JSON.parse(result.stdout.trim() || '{"ok":true}');
  } catch {
    return { ok: false, error: 'bid projection returned non-JSON output', raw: result.stdout };
  }
}

export function buildIdeaEvents({ content, source = 'ui', timestamp = new Date().toISOString(), registry = readRegistry() }) {
  const architecture = compileIdea({ content, source });
  const idea = {
    event_type: 'IDEA_SUBMITTED',
    engine_version: 1,
    timestamp,
    task_id: null,
    agent: source,
    role: null,
    model: null,
    idea_id: architecture.idea_id,
    content: architecture.idea,
    source,
    notes: `prompt_hash=${architecture.prompt_pack.prompt_hash}`,
  };
  const arch = {
    event_type: 'ARCHITECTURE_GENERATED',
    engine_version: 1,
    timestamp,
    task_id: null,
    agent: 'idea-factory',
    role: 'ARCHITECT',
    model: 'deterministic-compiler',
    idea_id: architecture.idea_id,
    architecture_id: architecture.architecture_id,
    architecture,
    confidence: 0.86,
    notes: `architecture_hash=${architecture.architecture_hash}`,
  };
  const graph = {
    event_type: 'TASK_GRAPH_CREATED',
    engine_version: 1,
    timestamp,
    task_id: null,
    agent: 'idea-factory',
    role: 'ARCHITECT',
    model: 'deterministic-compiler',
    idea_id: architecture.idea_id,
    architecture_id: architecture.architecture_id,
    task_graph: architecture.task_graph,
    notes: `tasks=${architecture.task_graph.length}`,
  };
  const tasks = materializeTaskEvents(architecture, registry, timestamp);
  const bids = WITH_BIDS ? materializeSyntheticBidEvents(tasks, timestamp) : [];
  return { architecture, events: [idea, arch, graph, ...tasks, ...bids], task_events: tasks, bid_events: bids };
}

function main() {
  const source = argValue('--source', 'ui');
  const content = argValue('--idea') || readStdin();
  if (!content.trim()) {
    const error = { ok: false, error: 'missing idea content' };
    process.stdout.write(JSON.stringify(error, null, 2) + '\n');
    process.exit(2);
  }

  const built = buildIdeaEvents({ content, source });
  const written = [];
  for (let i = 0; i < built.events.length; i += 1) {
    const isLast = i === built.events.length - 1;
    const result = writeEvent(built.events[i], isLast);
    written.push(result);
    if (!result.ok) {
      process.stdout.write(JSON.stringify({ ok: false, failed_at: i, result, written }, null, 2) + '\n');
      process.exit(1);
    }
  }
  const market = runBidProjection();
  const output = {
    ok: true,
    dry_run: DRY_RUN,
    architecture: built.architecture,
    event_count: built.events.length,
    task_count: built.task_events.length,
    bid_count: built.bid_events.length,
    written_events: written.map(r => r.event),
    market,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
