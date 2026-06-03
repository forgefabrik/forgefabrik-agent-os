import crypto from 'node:crypto';

export function nextTaskBase(registry) {
  const max = (registry?.tasks || []).reduce((acc, task) => {
    const m = String(task.task_id || '').match(/^TASK-(\d{4,})$/);
    return m ? Math.max(acc, Number(m[1])) : acc;
  }, 0);
  return Math.max(max + 1, 1001);
}

export function taskIdFor(base, offset) {
  return `TASK-${String(base + offset).padStart(4, '0')}`;
}

export function bidIdFor(task_id, agent_id = 'DSE') {
  const hash = crypto.createHash('sha256').update(`${task_id}:${agent_id}`).digest('hex');
  return `BID-${hash.slice(0, 10).toUpperCase()}`;
}

export function materializeTaskEvents(architecture, registry, timestamp) {
  const base = nextTaskBase(registry);
  return architecture.task_graph.map((node, index) => ({
    event_type: 'TASK_CREATED',
    engine_version: 1,
    timestamp,
    task_id: taskIdFor(base, index),
    agent: 'idea-factory',
    role: 'ARCHITECT',
    model: 'deterministic-compiler',
    idea_id: architecture.idea_id,
    parent_idea: architecture.idea_id,
    architecture_id: architecture.architecture_id,
    description: node.description,
    module: node.module,
    priority_weight: node.priority_weight,
    execution_cost: node.execution_cost,
    notes: `local_id=${node.local_id} depends_on=${(node.depends_on || []).join(',') || 'none'}`,
  }));
}

export function materializeSyntheticBidEvents(taskEvents, timestamp) {
  return taskEvents.map((task, index) => {
    const agent = `DSE-${String(index + 1).padStart(2, '0')}`;
    return {
      event_type: 'TASK_BID_SUBMITTED',
      engine_version: 1,
      timestamp,
      task_id: task.task_id,
      agent,
      role: 'IMPLEMENTATION',
      model: 'decision-suggestion-engine',
      bid_id: bidIdFor(task.task_id, agent),
      bid_strength: Math.max(0.55, Math.min(0.95, 0.82 - index * 0.03)),
      cost_offer: task.execution_cost,
      confidence: Math.max(0.5, Math.min(0.94, 0.88 - index * 0.02)),
      notes: `module=${task.module} synthetic_market_seed=true`,
    };
  });
}
