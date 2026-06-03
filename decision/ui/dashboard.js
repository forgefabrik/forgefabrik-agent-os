const state = {
  trust: null,
  eventStatus: null,
  head: null,
  projection: null,
  queue: [],
  report: null,
  agents: [],
  leases: [],
  streamFilter: 'all',
  eventSource: null,
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortHash(value, size = 10) {
  if (!value) return '-';
  const text = String(value);
  return text.length > size ? `${text.slice(0, size)}...` : text;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  if (!response.ok) {
    const reason = data.error || data.detail || `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return data;
}

function setConnection(on) {
  $('connectionDot')?.classList.toggle('is-online', on);
}

function logConsole(kind, message) {
  const log = $('consoleLog');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = `console-line console-line--${kind}`;
  entry.innerHTML = `<span>${new Date().toLocaleTimeString()}</span><p>${escapeHtml(message)}</p>`;
  log.appendChild(entry);
  log.scrollTop = log.scrollHeight;
}

async function refreshAll(reason = 'manual') {
  setConnection(false);
  try {
    const [
      trust,
      eventStatus,
      head,
      projection,
      queue,
      report,
      agents,
      leases,
    ] = await Promise.allSettled([
      fetchJson('/events/trust'),
      fetchJson('/events/status'),
      fetchJson('/events/head'),
      fetchJson('/projection'),
      fetchJson('/scheduler/queue'),
      fetchJson('/scheduler/report'),
      fetchJson('/agents'),
      fetchJson('/agents/leases/active'),
    ]);

    state.trust = trust.status === 'fulfilled' ? trust.value : null;
    state.eventStatus = eventStatus.status === 'fulfilled' ? eventStatus.value : null;
    state.head = head.status === 'fulfilled' ? head.value.head : null;
    state.projection = projection.status === 'fulfilled' ? projection.value : null;
    state.queue = queue.status === 'fulfilled' ? (queue.value.queue || []) : [];
    state.report = report.status === 'fulfilled' ? report.value : null;
    state.agents = agents.status === 'fulfilled' ? (agents.value.agents || []) : [];
    state.leases = leases.status === 'fulfilled' ? (leases.value.leases || []) : [];

    render();
    setConnection(true);
    if (reason !== 'sse') logConsole('ok', `control plane refreshed (${reason})`);
  } catch (error) {
    setConnection(false);
    logConsole('error', `refresh failed: ${error.message}`);
  }
}

function render() {
  renderTelemetry();
  renderDecisionStream();
  renderQueue();
  renderState();
}

function renderTelemetry() {
  const trustStatus = state.trust?.status || 'unknown';
  $('trustStatus').textContent = trustStatus;
  $('trustStatus').className = `trust trust--${trustStatus}`;
  $('eventHead').textContent = state.head?.event_index ?? state.eventStatus?.line_count ?? '-';
  $('snapshotIndex').textContent = state.trust?.snapshot_index ?? state.report?.registry_snapshot_index ?? '-';
  $('queueCount').textContent = state.queue.length;
}

function classifyDecision(event) {
  const type = String(event.event_type || event.type || '').toUpperCase();
  if (type.includes('REJECT') || type.includes('EXPIRED') || type.includes('FAIL')) return 'reject';
  if (type.includes('CLAIM') || type.includes('REQUEST') || type.includes('PRIORITY')) return 'proposal';
  if (type.includes('LLM') || type.includes('TAP') || type.includes('SUGGEST')) return 'llm';
  return 'commit';
}

function collectDecisionStream() {
  const items = [];

  if (state.head) {
    items.push({
      source: 'truth',
      type: state.head.event_type,
      category: classifyDecision(state.head),
      title: state.head.event_type,
      meta: `index ${state.head.event_index} | hash ${shortHash(state.head.event_hash, 16)}`,
      body: state.head.task_id
        ? `${state.head.task_id} by ${state.head.agent || 'system'}`
        : `event log head at ${state.head.timestamp || 'unknown time'}`,
    });
  }

  for (const entry of state.queue.slice(0, 18)) {
    const candidate = entry.candidates?.[0]?.agent_id || entry.no_candidates_reason || 'no candidate';
    items.push({
      source: 'decision_engine',
      type: 'DECISION_PROPOSAL',
      category: 'proposal',
      title: `${entry.task_id} -> ${entry.needed_role}`,
      meta: `score ${entry.score_display ?? entry.score ?? 0} | ${entry.components?.priority_tier || 'P0'}`,
      body: `candidate: ${candidate}`,
    });
  }

  const threads = state.projection?.threads || {};
  for (const thread of Object.values(threads).slice(0, 8)) {
    items.push({
      source: 'tap',
      type: 'CONTEXT_SIGNAL',
      category: 'llm',
      title: thread.topic || 'projection signal',
      meta: `${thread.count || 0} entries | last ${thread.last_activity || '-'}`,
      body: 'available to TAP context builder',
    });
  }

  return items.filter((item) => state.streamFilter === 'all' || item.category === state.streamFilter);
}

function renderDecisionStream() {
  const stream = $('decisionStream');
  if (!stream) return;
  const items = collectDecisionStream();

  if (!items.length) {
    stream.innerHTML = '<div class="empty">No decisions match the active filter.</div>';
    return;
  }

  stream.innerHTML = items.map((item, index) => `
    <article class="decision decision--${escapeHtml(item.category)}">
      <div class="decision__rail">${String(index + 1).padStart(2, '0')}</div>
      <div class="decision__content">
        <div class="decision__top">
          <span class="chip chip--${escapeHtml(item.category)}">${escapeHtml(item.type)}</span>
          <code>${escapeHtml(item.source)}</code>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(item.body)}</p>
        <div class="decision__meta">${escapeHtml(item.meta)}</div>
      </div>
    </article>
  `).join('');
}

function renderQueue() {
  const list = $('queueList');
  if (!list) return;
  if (!state.queue.length) {
    list.innerHTML = '<div class="empty">No actionable decisions in queue.</div>';
    return;
  }

  list.innerHTML = state.queue.slice(0, 10).map((entry, index) => {
    const components = entry.components || {};
    const candidate = entry.candidates?.[0]?.agent_id || 'unassigned';
    return `
      <button class="queue-row" data-task="${escapeHtml(entry.task_id)}">
        <span>#${index + 1}</span>
        <strong>${escapeHtml(entry.task_id)}</strong>
        <em>${escapeHtml(entry.needed_role || '-')}</em>
        <code>${escapeHtml(components.priority_tier || 'P0')} / ${escapeHtml(entry.score_display ?? entry.score ?? 0)}</code>
        <small>${escapeHtml(candidate)}</small>
      </button>
    `;
  }).join('');

  list.querySelectorAll('.queue-row').forEach((button) => {
    button.addEventListener('click', () => explainTask(button.dataset.task));
  });
}

function renderState() {
  const world = state.report?.world_snapshot || {};
  $('worldHash').textContent = shortHash(world.world_snapshot_hash, 24);
  $('eventCount').textContent = state.trust?.event_count ?? state.report?.registry_event_count ?? '-';
  $('headHash').textContent = shortHash(state.trust?.head_hash || world.event_head_hash, 24);

  const tasks = state.projection?.data?.tasks || state.projection?.tasks || [];
  const statusCounts = countBy(tasks, 'status');
  const taskBars = $('taskBars');
  if (taskBars) {
    const total = Math.max(tasks.length, 1);
    taskBars.innerHTML = Object.entries(statusCounts).map(([status, count]) => `
      <div class="bar-row">
        <span>${escapeHtml(status)}</span>
        <div class="bar"><i style="width:${(count / total) * 100}%"></i></div>
        <code>${count}</code>
      </div>
    `).join('') || '<div class="empty">Task registry projection unavailable.</div>';
  }

  const agentList = $('agentList');
  if (agentList) {
    agentList.innerHTML = state.agents.length
      ? state.agents.map((agent) => `
          <div class="mini-row">
            <strong>${escapeHtml(agent.agent_id)}</strong>
            <span>${escapeHtml(agent.status || 'UNKNOWN')}</span>
            <code>${escapeHtml((agent.capabilities || []).join(', ') || 'no caps')}</code>
          </div>
        `).join('')
      : '<div class="empty">No agents registered.</div>';
  }

  const leaseList = $('leaseList');
  if (leaseList) {
    leaseList.innerHTML = state.leases.length
      ? state.leases.map((lease) => `
          <div class="mini-row">
            <strong>${escapeHtml(lease.task_id)}</strong>
            <span>${escapeHtml(lease.agent_id)}</span>
            <code>${escapeHtml(lease.role || lease.status || 'LEASE')}</code>
          </div>
        `).join('')
      : '<div class="empty">No active leases.</div>';
  }
}

function countBy(items, key) {
  return items.reduce((acc, item) => {
    const value = item[key] || 'UNKNOWN';
    acc[value] = (acc[value] || 0) + 1;
    return acc;
  }, {});
}

async function runDecisionEngine() {
  logConsole('cmd', 'running deterministic decision engine');
  try {
    const result = await fetchJson('/scheduler/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    logConsole('ok', `decision engine complete: sequence ${result.scheduler_sequence ?? '-'}, queue ${result.queue_count ?? '-'}`);
    await refreshAll('decision engine');
  } catch (error) {
    logConsole('error', `decision engine failed: ${error.message}`);
  }
}

async function refreshTrust() {
  logConsole('cmd', 'refreshing trust report');
  try {
    const result = await fetchJson('/events/trust/refresh', { method: 'POST' });
    logConsole('ok', `trust report: ${result.report?.status || 'unknown'}`);
    await refreshAll('trust');
  } catch (error) {
    logConsole('error', `trust refresh failed: ${error.message}`);
  }
}

function explainTask(taskId) {
  if (!taskId) return;
  const entry = state.queue.find((item) => item.task_id === taskId);
  if (!entry) {
    logConsole('warn', `${taskId} is not in the current decision queue`);
    return;
  }

  const c = entry.components || {};
  const candidate = entry.candidates?.[0]?.agent_id || entry.no_candidates_reason || 'no candidate';
  logConsole(
    'info',
    `${taskId}: ${entry.state} -> ${entry.needed_role}; score ${entry.score_display ?? entry.score}; priority ${c.priority_tier || 'P0'}, urgency ${c.urgency_norm ?? 0}, trust ${c.trust_norm ?? 0}, cost ${c.execution_cost ?? 1}; ${candidate}`,
  );
}

function simulateTopTask() {
  const first = state.queue[0];
  if (!first) {
    logConsole('warn', 'no schedulable task to simulate');
    return;
  }
  const agent = first.candidates?.[0]?.agent_id || 'unassigned-agent';
  logConsole('info', `simulation: ${first.task_id} with ${agent} would request ${first.needed_role} under snapshot ${shortHash(state.report?.world_snapshot?.world_snapshot_hash, 18)}`);
}

async function injectPriority() {
  const first = state.queue[0];
  if (!first) {
    logConsole('warn', 'no task available for priority injection');
    return;
  }
  const ok = confirm(`Set P1 priority for ${first.task_id}? This writes through the event gate.`);
  if (!ok) return;

  try {
    const payload = {
      task_id: first.task_id,
      priority_weight: 2,
      execution_cost: first.components?.execution_cost || 1,
      agent: 'coi-operator',
      role: 'ARCHITECT',
      timestamp: new Date().toISOString(),
      engine_version: 1,
      reason: 'COI priority injection',
    };
    const result = await fetchJson('/scheduler/priority', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    logConsole('ok', `priority event written at index ${result.event?.event_index ?? '-'}`);
    await refreshAll('priority');
  } catch (error) {
    logConsole('error', `priority injection failed: ${error.message}`);
  }
}

async function handleConsole(command) {
  const input = command.trim();
  if (!input) return;
  logConsole('cmd', input);
  const lower = input.toLowerCase();

  if (lower === 'help') {
    logConsole('info', 'commands: refresh, run decision engine, trust, head, queue, agents, leases, explain TASK-0001, simulate TASK-0001 with AGENT-1, llm optimize queue stability');
    return;
  }
  if (lower === 'refresh') return refreshAll('console');
  if (lower === 'run decision engine' || lower === 'run scheduler') return runDecisionEngine();
  if (lower === 'trust') return refreshTrust();
  if (lower === 'head') {
    logConsole('info', JSON.stringify(state.head || {}, null, 2));
    return;
  }
  if (lower === 'queue') {
    logConsole('info', `${state.queue.length} queued decisions: ${state.queue.slice(0, 6).map((q) => q.task_id).join(', ')}`);
    return;
  }
  if (lower === 'agents') {
    logConsole('info', `${state.agents.length} agents: ${state.agents.map((a) => a.agent_id).join(', ') || 'none'}`);
    return;
  }
  if (lower === 'leases') {
    logConsole('info', `${state.leases.length} active leases`);
    return;
  }

  const explain = input.match(/^explain\s+(TASK-\d{4,})$/i);
  if (explain) {
    explainTask(explain[1].toUpperCase());
    return;
  }

  const simulate = input.match(/^simulate\s+(TASK-\d{4,})(?:\s+with\s+(.+))?$/i);
  if (simulate) {
    const taskId = simulate[1].toUpperCase();
    const agent = simulate[2] || 'unassigned-agent';
    logConsole('info', `simulation proposal: ${taskId} with ${agent}; no event written, no lease acquired`);
    return;
  }

  if (lower.startsWith('llm:') || lower.includes('llm optimize')) {
    logConsole('info', 'DSE request staged: LLM may suggest decisions, but only the decision engine and integrity bridge can commit.');
    return;
  }

  logConsole('warn', `unknown command: ${input}`);
}

function startSse() {
  if (!window.EventSource) {
    logConsole('warn', 'SSE unavailable in this browser; use refresh manually');
    return;
  }
  state.eventSource?.close();
  state.eventSource = new EventSource('/events');
  state.eventSource.onopen = () => {
    setConnection(true);
    logConsole('ok', 'decision stream connected');
  };
  state.eventSource.onerror = () => {
    setConnection(false);
  };
  for (const eventName of ['thread_update', 'stats_update', 'full_sync', 'ping']) {
    state.eventSource.addEventListener(eventName, () => {
      if (eventName !== 'ping') refreshAll('sse');
    });
  }
}

function bindUi() {
  $('refreshButton')?.addEventListener('click', () => refreshAll('button'));
  $('runDecisionButton')?.addEventListener('click', runDecisionEngine);
  $('simulateButton')?.addEventListener('click', simulateTopTask);
  $('priorityButton')?.addEventListener('click', injectPriority);
  $('trustRefreshButton')?.addEventListener('click', refreshTrust);
  $('explainButton')?.addEventListener('click', () => explainTask(state.queue[0]?.task_id));

  document.querySelectorAll('.segmented__item').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.segmented__item').forEach((b) => b.classList.remove('is-active'));
      button.classList.add('is-active');
      state.streamFilter = button.dataset.filter || 'all';
      renderDecisionStream();
    });
  });

  $('consoleForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const input = $('consoleCommand');
    const value = input?.value || '';
    if (input) input.value = '';
    handleConsole(value);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindUi();
  logConsole('info', 'COI online. Type "help" for TAP commands.');
  refreshAll('boot');
  startSse();
});
