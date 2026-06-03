import { buildPromptPack, ideaIdFor, normalizeIdea, sha256 } from './prompt-enhancer.mjs';
import { fileURLToPath } from 'node:url';

const MODULE_CATALOG = [
  { key: 'scheduler', triggers: ['schedule', 'queue', 'priority', 'assign'] },
  { key: 'bid-market', triggers: ['bid', 'market', 'price', 'economy', 'compete'] },
  { key: 'agent-runtime', triggers: ['agent', 'worker', 'lease', 'multi-agent'] },
  { key: 'decision-bridge', triggers: ['decision', 'validate', 'gate', 'commit'] },
  { key: 'replay-verifier', triggers: ['replay', 'verify', 'audit', 'hash'] },
  { key: 'control-plane-ui', triggers: ['ui', 'dashboard', 'control', 'console'] },
  { key: 'llm-compiler', triggers: ['llm', 'idea', 'architecture', 'prompt'] },
];

const BASE_MODULES = ['llm-compiler', 'decision-bridge', 'replay-verifier'];

function selectModules(idea) {
  const lower = idea.toLowerCase();
  const selected = new Set(BASE_MODULES);
  for (const mod of MODULE_CATALOG) {
    if (mod.triggers.some(t => lower.includes(t))) selected.add(mod.key);
  }
  selected.add('scheduler');
  selected.add('agent-runtime');
  return [...selected].sort();
}

function words(idea) {
  return idea.toLowerCase().match(/[a-z0-9äöüß-]{4,}/gi)?.slice(0, 12) || [];
}

function taskForModule(moduleKey, index, ideaWords) {
  const labels = {
    'llm-compiler': 'compile idea into structured architecture',
    'scheduler': 'score architecture tasks into actionable decisions',
    'bid-market': 'project agent bids into market pressure',
    'agent-runtime': 'bind agents, leases, and execution capabilities',
    'decision-bridge': 'validate proposals against frozen world snapshots',
    'replay-verifier': 'verify replay, snapshots, and event-chain integrity',
    'control-plane-ui': 'render decision stream and TAP command controls',
  };
  const priority = moduleKey === 'decision-bridge' || moduleKey === 'replay-verifier' ? 4 : 2;
  const cost = [2, 3, 5, 8, 13][index % 5];
  return {
    local_id: `N-${String(index + 1).padStart(2, '0')}`,
    module: moduleKey,
    description: labels[moduleKey] || `implement ${moduleKey}`,
    depends_on: index === 0 ? [] : [`N-${String(index).padStart(2, '0')}`],
    priority_weight: priority,
    execution_cost: cost,
    bid_points: ideaWords.slice(0, 4),
  };
}

export function compileIdea({ content, source = 'ui', idea_id = null }) {
  const idea = normalizeIdea(content);
  const id = idea_id || ideaIdFor(idea);
  const prompt_pack = buildPromptPack({ idea_id: id, content: idea, source });
  const selectedModules = selectModules(idea);
  const ideaWords = words(idea);
  const task_graph = selectedModules.map((m, i) => taskForModule(m, i, ideaWords));
  const architecture_id = `ARCH-${sha256(`${id}:${prompt_pack.prompt_hash}`).slice(0, 10).toUpperCase()}`;

  return {
    architecture_version: 1,
    architecture_id,
    idea_id: id,
    idea,
    prompt_pack,
    modules: selectedModules,
    constraints: {
      deterministic: true,
      event_sourced: true,
      llm_creates_tasks_directly: false,
      architecture_creates_tasks: true,
    },
    task_graph,
    risk_analysis: [
      'LLM output must stay advisory until compiled architecture is persisted.',
      'Task graph must remain deterministic and replayable.',
      'Bids influence scoring but never assign work without bridge validation.'
    ],
    bid_points: selectedModules.map(module => ({
      module,
      signal: `${module}:capability-match`,
      weight: module === 'decision-bridge' ? 1.25 : 1.0
    })),
    architecture_hash: sha256(JSON.stringify({
      id,
      modules: selectedModules,
      task_graph,
      prompt_hash: prompt_pack.prompt_hash,
    }))
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const content = process.argv.slice(2).join(' ');
  process.stdout.write(JSON.stringify(compileIdea({ content }), null, 2) + '\n');
}
