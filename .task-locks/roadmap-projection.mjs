import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const REGISTRY_PATH = '.task-locks/registry.json';
const OUTPUT_PATH = 'docs/ROADMAP.md';

const STATUS_ORDER = [
  'TODO',
  'IN_PROGRESS',
  'REFACTOR_CLAIMED',
  'REVIEW_LOCKED',
  'APPROVED',
  'MERGED',
  'EXPIRED',
];

function loadRegistry(path = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function byTaskId(a, b) {
  return a.task_id.localeCompare(b.task_id);
}

function countByStatus(tasks) {
  const counts = new Map();
  for (const task of tasks) {
    counts.set(task.status, (counts.get(task.status) || 0) + 1);
  }
  return counts;
}

function orderedStatuses(tasks) {
  const present = new Set(tasks.map(task => task.status));
  const ordered = STATUS_ORDER.filter(status => present.has(status));
  const extra = [...present]
    .filter(status => !STATUS_ORDER.includes(status))
    .sort();
  return [...ordered, ...extra];
}

function lockSummary(task) {
  const impl = task.implementation_lock?.agent;
  const review = task.review_lock?.agent;
  if (impl && review) return `implementation=${impl}; review=${review}`;
  if (impl) return `implementation=${impl}`;
  if (review) return `review=${review}`;
  return 'none';
}

export function renderRoadmap(registry = loadRegistry()) {
  const tasks = [...(registry.tasks || [])].sort(byTaskId);
  const counts = countByStatus(tasks);
  const statuses = orderedStatuses(tasks);
  const generatedAt = registry.generated_at || 'unknown';

  const lines = [];
  lines.push('# NOVA 2.5 Roadmap Projection');
  lines.push('');
  lines.push('This file is generated from `.task-locks/registry.json`.');
  lines.push('');
  lines.push('Do not edit it by hand. Update `TASK_EVENTS.jsonl` through the approved');
  lines.push('workflow, rebuild `.task-locks/registry.json`, then regenerate this view.');
  lines.push('');
  lines.push('Product and architecture prose belongs in `docs/ARCHITECTURE_PRINCIPLES.md`');
  lines.push('or `.agents/docs/`. This file is a read-only human view of task state.');
  lines.push('');
  lines.push('## Projection Metadata');
  lines.push('');
  lines.push(`- schema_version: ${registry.schema_version}`);
  lines.push(`- engine_version: ${registry.engine_version}`);
  lines.push(`- generated_at: ${generatedAt}`);
  lines.push(`- event_count: ${registry.event_count}`);
  lines.push(`- task_count: ${tasks.length}`);
  lines.push('');
  lines.push('## Status Summary');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('|--------|------:|');
  for (const status of statuses) {
    lines.push(`| ${status} | ${counts.get(status) || 0} |`);
  }
  lines.push('');
  lines.push('## Task State');
  lines.push('');
  for (const status of statuses) {
    const group = tasks.filter(task => task.status === status);
    lines.push(`### ${status}`);
    lines.push('');
    if (group.length === 0) {
      lines.push('- none');
    } else {
      for (const task of group) {
        const suffix = task.forked_from ? `; forked_from=${task.forked_from}` : '';
        lines.push(`- ${task.task_id} | last_event_index=${task.last_event_index} | locks=${lockSummary(task)}${suffix}`);
      }
    }
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function writeRoadmap(outputPath = OUTPUT_PATH) {
  const content = renderRoadmap();
  fs.writeFileSync(outputPath, content);
  return content;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] || 'write';
  const content = renderRoadmap();
  if (mode === 'print') {
    process.stdout.write(content);
  } else if (mode === 'verify') {
    const existing = fs.readFileSync(OUTPUT_PATH, 'utf8');
    if (existing !== content) {
      console.error('docs/ROADMAP.md is stale. Regenerate it with:');
      console.error('  node .task-locks/roadmap-projection.mjs');
      process.exit(1);
    }
    console.log('OK docs/ROADMAP.md matches registry projection.');
  } else if (mode === 'write') {
    fs.writeFileSync(OUTPUT_PATH, content);
    console.log('OK docs/ROADMAP.md regenerated from registry.json.');
  } else {
    console.error(`Unknown mode: ${mode}`);
    process.exit(2);
  }
}
