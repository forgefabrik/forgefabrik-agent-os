const state = {
  queue: [],
  report: null,
  runtime: null,
  agents: [],
  leases: [],
  head: null,
  trust: null,
  market: null,
  messages: [],
  stats: null,
  meta: null,
  activeThread: "__all__",
  search: "",
  sse: null,
};

const $ = (id) => document.getElementById(id);

const endpoints = {
  queue: "/scheduler/queue",
  report: "/scheduler/report",
  runtime: "/scheduler/runtime-status",
  run: "/scheduler/run",
  agents: "/agents",
  leases: "/agents/leases/active",
  head: "/events/head",
  trust: "/events/trust",
  ideaCompile: "/ideas/compile",
  ideaSubmit: "/ideas/submit",
  market: "/ideas/market",
  messages: "/messages",
  stats: "/stats",
  meta: "/meta",
  userMail: "/user",
  aiMail: "/ai",
};

function shortHash(value) {
  if (!value || typeof value !== "string") return "--";
  return value.length > 18 ? `${value.slice(0, 10)}...${value.slice(-8)}` : value;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function classifyDecision(eventType = "") {
  if (eventType.includes("REJECT") || eventType.includes("INVALID")) return "rejection";
  if (eventType.includes("CLAIM") || eventType.includes("MERGED") || eventType.includes("APPROVED")) return "commit";
  if (eventType.includes("PRIORITY") || eventType.includes("PROJECTION") || eventType.includes("SCHEDULE")) return "proposal";
  if (eventType.includes("LLM") || eventType.includes("SUGGEST")) return "llm";
  return "proposal";
}

async function readJson(url, fallback = null, options = {}) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) return fallback;
    return await response.json();
  } catch {
    return fallback;
  }
}

function setText(id, value) {
  const node = $(id);
  if (node) node.textContent = value ?? "--";
}

function addConsole(text, type = "system") {
  const output = $("tapOutput");
  if (!output) return;
  const line = document.createElement("p");
  line.className = `console-line ${type}`;
  line.textContent = text;
  output.appendChild(line);
  output.scrollTop = output.scrollHeight;
}

function setReader(text) {
  setText("readerStatus", text);
}

function speakText(text) {
  if (!("speechSynthesis" in window)) {
    setReader("Speech synthesis is not available in this browser.");
    return;
  }
  const clean = String(text || "").trim();
  if (!clean) {
    setReader("Nothing selected to read.");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(clean.slice(0, 12000));
  utterance.rate = 0.96;
  utterance.pitch = 0.92;
  utterance.onstart = () => setReader("Reading...");
  utterance.onend = () => setReader("Ready.");
  utterance.onerror = () => setReader("Reader stopped.");
  window.speechSynthesis.speak(utterance);
}

function stopSpeech() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
  setReader("Stopped.");
}

function activateTab(tabName) {
  document.querySelectorAll("[data-tab]").forEach((button) => {
    const active = button.dataset.tab === tabName;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  document.querySelectorAll("[data-tab-view]").forEach((view) => {
    view.classList.toggle("active", view.dataset.tabView === tabName);
  });
}

function allMessages() {
  return [...(state.messages || [])].sort((a, b) =>
    String(a.timestamp || a.ref || "").localeCompare(String(b.timestamp || b.ref || ""))
  );
}

function threadCounts() {
  const counts = new Map();
  for (const message of allMessages()) {
    const topic = message.topic || "untitled";
    counts.set(topic, (counts.get(topic) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function filteredMessages() {
  const query = state.search.toLowerCase();
  return allMessages().filter((message) => {
    const inThread = state.activeThread === "__all__" || message.topic === state.activeThread;
    if (!inThread) return false;
    if (!query) return true;
    return `${message.topic || ""} ${message.text || ""} ${message.ref || ""}`.toLowerCase().includes(query);
  });
}

function messageAgentRole(message) {
  return message.agent_role || "unassigned";
}

function roleClass(agentRole) {
  return String(agentRole || "unassigned").toLowerCase();
}

function renderMailbox() {
  renderThreads();
  renderMessages();
  const total = allMessages().length;
  setText("mailCount", total);
  setText("threadCount", threadCounts().length);
}

function renderThreads() {
  const list = $("threadList");
  if (!list) return;
  const rows = threadCounts();
  const total = allMessages().length;
  const buttons = [
    `<button class="thread-button ${state.activeThread === "__all__" ? "active" : ""}" type="button" data-thread="__all__">
      All Messages<small>${total} entries</small>
    </button>`,
    ...rows.map(([topic, count]) => `
      <button class="thread-button ${state.activeThread === topic ? "active" : ""}" type="button" data-thread="${escapeHtml(topic)}">
        ${escapeHtml(topic)}<small>${count} entries</small>
      </button>
    `),
  ];
  list.innerHTML = buttons.join("");
}

function renderMessages() {
  const list = $("messageList");
  if (!list) return;
  const rows = filteredMessages();
  const topicLabel = state.activeThread === "__all__" ? "All Messages" : state.activeThread;
  setText("activeThreadTitle", topicLabel);
  setText("activeThreadMeta", `${rows.length} visible / ${allMessages().length} total`);

  if (rows.length === 0) {
    list.innerHTML = '<div class="empty">No mailbox messages match the current filter.</div>';
    return;
  }

  list.innerHTML = rows.map((message, index) => `
    <article class="message-card ${escapeHtml(message.role || "user")}" data-message-index="${index}">
      <div class="message-top">
        <strong>${escapeHtml((message.role || "message").toUpperCase())} · ${escapeHtml(message.topic || "untitled")}</strong>
        <small>${escapeHtml(message.timestamp || message.ref || "--")}</small>
      </div>
      <span class="role-badge ${escapeHtml(roleClass(messageAgentRole(message)))}">${escapeHtml(messageAgentRole(message))}</span>
      <p>${escapeHtml(message.text || "")}</p>
      <div class="message-actions">
        <button type="button" data-read-message="${index}">Read</button>
      </div>
    </article>
  `).join("");
}

function selectedThreadText() {
  return filteredMessages()
    .map((message) => `${message.role || "message"} for ${messageAgentRole(message)} at ${message.timestamp || message.ref || "unknown"} topic ${message.topic || "untitled"}.\n${message.text || ""}`)
    .join("\n\n");
}

async function loadMailbox() {
  const [messages, stats, meta] = await Promise.all([
    readJson(endpoints.messages, { inbox: [], outbox: [] }),
    readJson(endpoints.stats, {}),
    readJson(endpoints.meta, {}),
  ]);
  state.messages = [...(messages.inbox || []), ...(messages.outbox || [])];
  state.stats = stats;
  state.meta = meta;
  renderMailbox();
}

async function saveMailbox(role) {
  const topic = $("mailTopic")?.value?.trim();
  const text = $("mailText")?.value?.trim();
  const agentRole = $("mailAgentRole")?.value || "unassigned";
  if (!topic || !text) {
    setReader("Topic and message are required.");
    return;
  }

  const endpoint = role === "ai" ? endpoints.aiMail : endpoints.userMail;
  const payload = role === "ai"
    ? { topic, text, agent_role: agentRole, reply_to: allMessages().filter((m) => m.topic === topic && m.role === "user").at(-1)?.ref || allMessages().at(-1)?.ref || "manual" }
    : { topic, text, agent_role: agentRole };

  const result = await readJson(endpoint, null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!result?.status && !result?.ref) {
    setReader("Mailbox write failed.");
    return;
  }

  $("mailText").value = "";
  state.activeThread = topic;
  setReader(role === "ai"
    ? `Saved AI reply to you at ${result.ref || "new ref"}.`
    : `Saved user context for ${agentRole} at ${result.ref || "new ref"}.`);
  await loadMailbox();
}

function renderDecisionStream() {
  const stream = $("decisionStream");
  stream.innerHTML = "";

  const synthetic = [];
  if (state.head?.event) synthetic.push(state.head.event);
  for (const item of state.queue.slice(0, 11)) {
    synthetic.push({
      event_type: "TASK_DECISION_PROPOSED",
      task_id: item.task_id,
      role: item.needed_role,
      score: item.score_display ?? item.score,
      event_hash: state.report?.event_head_hash,
      notes: item.no_candidates_reason || "deterministic queue candidate",
    });
  }

  if (synthetic.length === 0) {
    stream.innerHTML = '<article class="decision-card proposal"><strong>NO DECISIONS LOADED</strong><span>Waiting for event fabric sync.</span></article>';
    return;
  }

  for (const event of synthetic) {
    const type = event.event_type || "DECISION_EVENT";
    const card = document.createElement("article");
    card.className = `decision-card ${classifyDecision(type)}`;
    card.innerHTML = `
      <strong>${escapeHtml(type)}</strong>
      <span>${escapeHtml(event.task_id || "SYSTEM")} · ${escapeHtml(event.role || event.agent || "CONTROL")}</span>
      <p>hash=${escapeHtml(shortHash(event.event_hash || event.prev_event_hash || state.report?.event_head_hash))}</p>
      <p>${escapeHtml(event.notes || event.reason || `score=${event.score ?? "--"}`)}</p>
    `;
    stream.appendChild(card);
  }
}

function renderQueue() {
  const list = $("queueList");
  list.innerHTML = "";
  if (state.queue.length === 0) {
    list.innerHTML = '<div class="empty">No queue entries available.</div>';
    return;
  }
  for (const item of state.queue.slice(0, 10)) {
    const row = document.createElement("button");
    row.className = "queue-item";
    row.type = "button";
    row.dataset.command = `explain decision chain for ${item.task_id}`;
    row.innerHTML = `
      <span><strong>${escapeHtml(item.task_id)}</strong><br><small>${escapeHtml(item.needed_role || "ROLE")} · ${escapeHtml(item.state || "STATE")}</small></span>
      <small>${escapeHtml(item.score_display ?? item.score ?? "--")}</small>
    `;
    list.appendChild(row);
  }
}

function renderState() {
  const report = state.report || {};
  const snapshot = report.world_snapshot || {};
  setText("taskCount", report.queue_count ?? state.queue.length ?? "--");
  setText("queueCount", state.queue.length ?? "--");
  setText("agentCount", state.agents.length ?? "--");
  setText("leaseCount", state.leases.length ?? "--");
  setText("snapshotHash", snapshot.world_snapshot_hash || "--");
  setText("eventHead", snapshot.head_event_index ?? state.head?.event?.event_index ?? "--");
  setText("decisionSequence", report.scheduler_sequence ?? "--");
  setText("generatedAt", report.generated_at || "--");
  setText("headStatus", `HEAD: ${snapshot.head_event_index ?? state.head?.event?.event_index ?? "--"}`);
  setText("trustStatus", `TRUST: ${(report.trust_status || state.trust?.trust || "unknown").toUpperCase()}`);

  const agentList = $("agentList");
  agentList.innerHTML = "";
  if (state.agents.length === 0) {
    agentList.innerHTML = '<div class="agent-item"><strong>NO AGENTS REGISTERED</strong><br><small>DSE proposals remain advisory.</small></div>';
    renderMarket();
    return;
  }

  for (const agent of state.agents.slice(0, 10)) {
    const item = document.createElement("div");
    item.className = "agent-item";
    item.innerHTML = `<strong>${escapeHtml(agent.agent_id || agent.id || "AGENT")}</strong><small>${escapeHtml(agent.status || "ACTIVE")} · trust ${escapeHtml(agent.trust_score ?? agent.trust ?? "--")}</small>`;
    agentList.appendChild(item);
  }

  renderMarket();
}

function renderMarket() {
  const list = $("marketList");
  if (!list) return;
  const tasks = state.market?.tasks || {};
  const rows = Object.values(tasks).slice(0, 10);
  if (rows.length === 0) {
    list.innerHTML = '<div class="market-item"><strong>BID MARKET</strong><small>No bids projected yet.</small></div>';
    return;
  }
  list.innerHTML = rows.map((item) => `
    <div class="market-item">
      <strong>${escapeHtml(item.task_id)}</strong>
      <small>bids ${escapeHtml(item.active_bid_count)} · pressure ${escapeHtml(item.market_pressure_multiplier)} · winner ${escapeHtml(item.winning_bid_id || "--")}</small>
    </div>
  `).join("");
}

function renderIdeaResult(data, mode) {
  const result = $("ideaResult");
  if (!result) return;
  const arch = data?.architecture || data;
  if (!arch) {
    result.innerHTML = '<div class="idea-card"><strong>NO ARCHITECTURE</strong><small>Compiler returned no result.</small></div>';
    return;
  }
  const architecture = arch.architecture || arch;
  const modules = architecture.modules || [];
  const tasks = architecture.task_graph || [];
  result.innerHTML = `
    <div class="idea-card">
      <strong>${escapeHtml(mode)}: ${escapeHtml(architecture.architecture_id || "ARCHITECTURE")}</strong>
      <small>${escapeHtml(modules.join(", ") || "no modules")} · tasks ${tasks.length}</small>
    </div>
    ${tasks.slice(0, 10).map((task) => `
      <div class="idea-card">
        <strong>${escapeHtml(task.local_id || task.task_id || "TASK")}</strong>
        <small>${escapeHtml(task.module || "--")} · cost ${escapeHtml(task.execution_cost ?? "--")} · ${escapeHtml(task.description || "")}</small>
      </div>
    `).join("")}
  `;
}

async function syncState() {
  const [queue, report, runtime, agents, leases, head, trust, market] = await Promise.all([
    readJson(endpoints.queue, { queue: [] }),
    readJson(endpoints.report, {}),
    readJson(endpoints.runtime, { monitored: [] }),
    readJson(endpoints.agents, { agents: [] }),
    readJson(endpoints.leases, { leases: [] }),
    readJson(endpoints.head, {}),
    readJson(endpoints.trust, {}),
    readJson(endpoints.market, { tasks: {} }),
  ]);

  state.queue = queue.queue || queue.data?.queue || [];
  state.report = report;
  state.runtime = runtime;
  state.agents = agents.agents || [];
  state.leases = leases.leases || leases.active_leases || [];
  state.head = head;
  state.trust = trust;
  state.market = market;

  renderDecisionStream();
  renderQueue();
  renderState();
  await loadMailbox();
}

async function runDecisionCycle() {
  addConsole("decision_engine: computing actionable decisions under deterministic constraints...");
  const result = await readJson(endpoints.run, null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ timestamp: new Date().toISOString() }),
  });
  if (!result || result.error) {
    addConsole(`decision_engine: ${result?.error || "run endpoint unavailable"}`, "warn");
    return;
  }
  addConsole(`decision_engine: sequence ${result.scheduler_sequence ?? "--"} · queue ${result.queue_count ?? "--"}`);
  await syncState();
}

async function compileIdea() {
  const input = $("ideaInput");
  const content = input?.value?.trim();
  if (!content) {
    addConsole("idea_factory: missing idea content", "warn");
    return;
  }
  addConsole("idea_factory: compiling architecture without writing events...");
  const result = await readJson(endpoints.ideaCompile, null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, source: "ui", dry_run: true }),
  });
  if (!result?.ok) {
    addConsole(`idea_factory: ${result?.error || "compile endpoint unavailable"}`, "warn");
    return;
  }
  renderIdeaResult(result.architecture, "COMPILED");
  addConsole(`idea_factory: architecture ${result.architecture?.architecture_id || "--"} compiled`);
}

async function submitIdea() {
  const input = $("ideaInput");
  const content = input?.value?.trim();
  if (!content) {
    addConsole("idea_factory: missing idea content", "warn");
    return;
  }
  addConsole("idea_factory: submitting idea through event writer...");
  const result = await readJson(endpoints.ideaSubmit, null, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, source: "ui", dry_run: false, with_bids: true }),
  });
  if (!result?.ok) {
    addConsole(`idea_factory: ${result?.error || "submit endpoint unavailable"}`, "warn");
    return;
  }
  renderIdeaResult(result, "MATERIALIZED");
  addConsole(`idea_factory: wrote ${result.event_count} events · tasks ${result.task_count} · bids ${result.bid_count}`);
  await runDecisionCycle();
  await syncState();
}

async function executeTap(command) {
  const value = command.trim();
  if (!value) return;
  addConsole(`> ${value}`, "user");

  const simulate = value.match(/^simulate task\s+(\S+)\s+with agent\s+(\S+)/i);
  if (simulate) {
    const [, task, agent] = simulate;
    const entry = state.queue.find((item) => item.task_id.toLowerCase() === task.toLowerCase());
    addConsole(entry
      ? `simulation: ${agent} may propose ${entry.task_id}; score=${entry.score_display ?? entry.score}; snapshot=${shortHash(state.report?.world_snapshot?.world_snapshot_hash)}`
      : `simulation: ${task} is not in the active decision queue.`, entry ? "system" : "warn");
    return;
  }

  const explain = value.match(/^explain decision chain for\s+(\S+)/i);
  if (explain) {
    const task = explain[1];
    const detail = await readJson(`/scheduler/task/${encodeURIComponent(task)}`, null);
    if (!detail?.ok) {
      addConsole(`explain: no active chain for ${task}`, "warn");
      return;
    }
    addConsole(`chain ${task}: state=${detail.state || "unknown"} role=${detail.needed_role || detail.monitored?.role || "--"} score=${detail.score_display ?? detail.score ?? "--"} head=${state.report?.world_snapshot?.head_event_index ?? "--"}`);
    return;
  }

  const replay = value.match(/^replay world at event\s+(.+)/i);
  if (replay) {
    const target = replay[1] === "head" ? (state.report?.world_snapshot?.head_event_index ?? "head") : replay[1];
    addConsole(`replay: verification target event=${target}; snapshot=${shortHash(state.report?.world_snapshot?.world_snapshot_hash)}`);
    return;
  }

  if (/^force propose scheduler cycle/i.test(value)) {
    await runDecisionCycle();
    return;
  }

  if (/^llm:/i.test(value)) {
    addConsole("DSE proposal: hold writes; optimize by raising no-candidate visibility, then register capable agents before lease proposals.", "warn");
    return;
  }

  if (/^idea:/i.test(value)) {
    const input = $("ideaInput");
    if (input) input.value = value.replace(/^idea:\s*/i, "");
    activateTab("ideas");
    await compileIdea();
    return;
  }

  addConsole("tap: unknown command. Try idea:, simulate, explain, replay, force propose, or llm: ...", "warn");
}

function connectSse() {
  if (!window.EventSource) {
    setText("sseStatus", "SSE: UNAVAILABLE");
    return;
  }
  state.sse = new EventSource("/events");
  state.sse.onopen = () => setText("sseStatus", "SSE: LIVE");
  state.sse.onerror = () => setText("sseStatus", "SSE: DEGRADED");
  for (const name of ["thread_update", "stats_update", "full_sync", "ping"]) {
    state.sse.addEventListener(name, () => syncState());
  }
}

document.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) {
    activateTab(tab.dataset.tab);
    return;
  }

  const thread = event.target.closest("[data-thread]");
  if (thread) {
    state.activeThread = thread.dataset.thread;
    const topicInput = $("mailTopic");
    if (topicInput && state.activeThread !== "__all__") topicInput.value = state.activeThread;
    renderMailbox();
    return;
  }

  const readMessage = event.target.closest("[data-read-message]");
  if (readMessage) {
    const message = filteredMessages()[Number(readMessage.dataset.readMessage)];
    speakText(`${message.role || "message"} for ${messageAgentRole(message)} ${message.timestamp || message.ref || ""}. ${message.text || ""}`);
    return;
  }

  const target = event.target.closest("[data-command]");
  if (target) executeTap(target.dataset.command);
});

$("tapForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("tapInput");
  executeTap(input.value);
  input.value = "";
});

$("refreshButton")?.addEventListener("click", syncState);
$("compileIdeaButton")?.addEventListener("click", compileIdea);
$("ideaForm")?.addEventListener("submit", (event) => {
  event.preventDefault();
  submitIdea();
});

$("mailSearch")?.addEventListener("input", (event) => {
  state.search = event.target.value || "";
  renderMailbox();
});

$("saveUserMailButton")?.addEventListener("click", () => saveMailbox("user"));
$("saveAiMailButton")?.addEventListener("click", () => saveMailbox("ai"));
$("readThreadButton")?.addEventListener("click", () => speakText(selectedThreadText()));
$("readPageButton")?.addEventListener("click", () => speakText(document.querySelector(".tab-view.active")?.innerText || document.body.innerText));
$("stopReadButton")?.addEventListener("click", stopSpeech);

addConsole("coi: decision fabric booting...");
addConsole("coi: mailbox memory is append-only and timestamped.");
connectSse();
syncState();
setInterval(syncState, 7000);
