import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FIB_COSTS = [1, 2, 3, 5, 8, 13];

export function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function normalizeIdea(content) {
  return String(content || '').replace(/\s+/g, ' ').trim();
}

export function ideaIdFor(content) {
  return `I-${sha256(normalizeIdea(content)).slice(0, 8).toUpperCase()}`;
}

export function buildPromptPack({ idea_id, content, source = 'ui' }) {
  const idea = normalizeIdea(content);
  if (!idea) throw new Error('idea content must not be empty');

  return {
    prompt_version: 1,
    idea_id,
    source,
    system_prompt: [
      'You are a deterministic architecture compiler.',
      'You transform ideas into structured architecture only.',
      'You never create executable task events directly.',
      'The architecture must be replayable, event-sourced, and deterministic.',
      'Return strict JSON.'
    ].join(' '),
    constraints: [
      'must output architecture modules',
      'must output a DAG task graph',
      'task costs must use Fibonacci values',
      'task priority must be numeric and positive',
      'must include risks and bid points',
      'must not assign agents',
      'must not write events'
    ],
    idea,
    allowed_costs: FIB_COSTS,
    required_outputs: [
      'architecture',
      'task_graph',
      'risk_analysis',
      'bid_points'
    ],
    prompt_hash: sha256(JSON.stringify({
      idea,
      source,
      constraints_version: 1,
      allowed_costs: FIB_COSTS
    }))
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const content = process.argv.slice(2).join(' ');
  const idea_id = ideaIdFor(content);
  process.stdout.write(JSON.stringify(buildPromptPack({ idea_id, content }), null, 2) + '\n');
}
