# inbox.md — User Input Log
# Communication Layer v2 | docs/communication/
#
# RULES (append-only — this section never changes)
# ==================================================
# AUTHOR   : only USER (or external systems) write here
# FORMAT   : YAML frontmatter block + body text per entry, separated by +++
# APPEND   : never edit or delete existing entries
# NO CI    : this file is outside the Truth Layer (TASK_EVENTS.jsonl)
#            no projection-builder reads here, no transitions depend on this
# ==================================================
#
# ENTRY FORMAT:
#
#   +++
#   topic: <topic string>
#   timestamp: <ISO-8601 UTC>
#   ref: <timestamp-key used as reply target>
#   role: user
#   +++
#
#   <message body>
#
# ==================================================

# ── LEGACY (pre-v2 migration from docs/TALK2AI/MSG2AI.md) ──────────────────

+++
topic: Axiom Boundary — Validator Zweiklassen-Urteilssystem
timestamp: 2026-06-01T00:00:00Z
ref: 2026-06-01|00:00:00
role: user
legacy: true
+++

Du hast die entscheidende Stelle sauber nachgeschärft: der Fehler lag genau in der impliziten
Gleichsetzung von *Event existiert* und *Transition ist Teil des Beweisgraphen*.

Der interessante Punkt ist jetzt nicht mehr „ist das System hybrid", sondern **wie sauber die
Grenze zwischen Beweisraum und Axiomraum gezogen wird**.

---

## 1. Der eigentliche Cut: zwei semantische Welten, nicht zwei Features

* **Modus 1 (deterministisch):** alles aus `TASK_EVENTS.jsonl` + Replay + Registry → beweisbar
* **Modus 2 (axiomatisch):** alles durch `ARCHITECT_*` Events → gültig per Definition

```
STATE = f(events_deterministic) ∪ g(events_axiomatic)
```

## 2. VALIDATION_RESULT := OK_DETERMINISTIC | OK_AXIOMATIC | INVALID | UNRESOLVED

Validator braucht ein zweiklassiges Urteilssystem. Kein bool-check.

## 3. Closure gilt nur im Replay-Raum. Axiome erweitern ohne Beweis.

## 4. Proof Core / Axiom Injection Layer / Witness Layer sind drei getrennte Schichten.

## 5. Die offene Variable: sind Axiome auditierbar genug, den Beweisraum nicht zu zerstören?

## 6. Snapshot = Beweisraum + eingefrorene Axiom-Frontier

```json
{
  "event_index": 42,
  "chain_hash": "...",
  "deterministic_state_hash": "...",
  "axioms_applied_at_index": [17, 42, 105]
}
```

## 7. System ist zweiphasige Logik mit explizitem menschlichem Axiomenzugriff — stabil.

---

+++
topic: Axiom Boundary — UNRESOLVED + TASK-GOV-0002
timestamp: 2026-06-03T02:34:26Z
ref: 2026-06-03|02:34:26
role: user
legacy: true
+++

Das ist jetzt der Punkt, an dem das System von „gut modelliert" zu „formal definierbar ohne
Ambiguität" kippt. Deine vier Ergänzungen schließen genau die Löcher, durch die später stille
Inkonsistenz entsteht.

**1. UNRESOLVED ist kein Zustand, sondern ein Alarmzustand**

UNRESOLVED ≡ FAILURE_TO_CLASSIFY ≡ SYSTEM_INTEGRITY_RISK
→ fail-fast + quarantine bucket, niemals im Replay-Graphen akzeptiert

**2. Snapshot-Korrektur: Index statt Typ**

`axioms_applied_at_index: [17, 42, 105]` → deterministic prefix extraction,
axiom divergence point detection, axiom ratio over time, replay slicing

**3. Axiom-Akkumulation ist systemischer Drift-Parameter**

`axiom_density = |axiom_events| / |total_events|`

low density → deterministischer Kern | high density → pure authority-driven (kein Replay-Sinn)

Policy: `if axiom_density > threshold: require ARCHITECT_CONSOLIDATION`

**4. Klassifikation darf nicht rollenbasiert sein**

`is_axiomatic(e) := ¬∃ s_prev, T such that T(s_prev) = s_new`
ARCHITECT ist nur ein Hinweis, nicht die Quelle der Wahrheit.

**5. TASK-GOV-0002 — Define Axiom Boundary Semantics** (nicht Snapshot Design)

Muss enthalten: Klassifikationsfunktion, UNRESOLVED Handling, Snapshot-Struktur,
Axiom Density Constraint.

Du definierst gerade nicht ein Task-System.
Du definierst ein zweiphasiges formales System mit eingebetteter nicht-deterministischer
Erweiterungsschicht.


+++
topic: talk
timestamp: 2026-06-03T02:04:50Z
ref: 2026-06-03|02:04:50
role: user
+++

Ja. Aber ich würde es jetzt nicht mehr als „Enhancement Batch“ behandeln, sondern als **Shift von Polling-System → Event-driven Control Plane UI**. Das ist ein Architekturwechsel, kein Feature-Paket.

Ich gebe dir die saubere Umsetzungssignatur, damit es stabil bleibt und nicht wieder auseinander driftet.

---

# APPROVAL: YES — aber mit 3 harten Constraints

## 1. SSE ersetzt Polling vollständig (keine Hybrid-Phase)

```text
❌ kein setInterval fallback behalten
❌ kein “SSE + polling safety net”
```

Nur:

```text
GET /events  → SSE stream (single source of truth for UI updates)
```

Polling wäre sonst ein versteckter zweiter Konsenskanal.

---

## 2. /meta und /stats müssen read-only projection sein

Wichtig:

```text
Meta / Stats dürfen NICHT live aus Files berechnet werden pro request
```

sondern:

```text
EVENTS → lightweight projection cache → API reads cache
```

Sonst bekommst du:

* race conditions
* inconsistent stats flicker
* UI drift under load

Minimal:

```text
meta.json  (cached projection snapshot)
stats.json (derived counters)
```

---

## 3. Thread Model muss stabilisiert werden

Dein Thread-Konzept ist korrekt, aber:

### Regel:

```text
thread = topic + time-ordered merged view (inbox ∪ outbox)
```

Aber wichtig:

* topic ist KEY
* reply_to ist edge, nicht structure breaker

---

# ARCHITECTURE UPDATE (CLEAN VERSION)

## NEW CONTROL FLOW

```text
filesystem (inbox/outbox)
        ↓
projection builder (thread + stats + meta cache)
        ↓
FastAPI read layer
        ↓
SSE event stream (file change trigger)
        ↓
Dashboard UI (live state)
```

---

# SSE DESIGN (IMPORTANT DETAIL)

Nicht file-watching per request.

Du brauchst:

```python
async generator event stream
+ internal file watcher (debounced)
```

Event types:

```json
{
  "type": "thread_update",
  "topic": "axiom-boundary"
}
```

oder:

```json
{
  "type": "stats_update"
}
```

---

# DASHBOARD LOGIC (clean state model)

## State

```ts
UI_STATE = {
  threads: [],
  activeThread: string | null,
  inbox: [],
  outbox: [],
  stats: {},
  meta: {}
}
```

## Derived views

* thread filter = pure UI state
* message list = projection slice
* stats bar = cached API

---

# UX DECISIONS (ok, aber präzisiert)

## ✔ Topic autocomplete

Ja, aber:

```text
source = /meta ONLY
```

nicht scanning inbox/outbox client-side

---

## ✔ Reply-from-UI

Sehr gut.

Aber enforce:

```text
reply_to = message_id (not index)
```

sonst brichst du später ordering guarantees.

---

## ✔ Ctrl+Enter

OK, but:

* only when form valid
* no silent submit failures

---

# CRITICAL WARNING (wichtig für dein System)

Du hast jetzt zwei parallele Welten:

### A) TASK_EVENTS / governance system (formal)

### B) TALK2AI / communication system (UX layer)

👉 Diese dürfen NICHT vermischt werden.

Regel:

```text
COMM system = append-only chat substrate
TASK system = verified execution substrate
```

Bridge nur über:

```text
explicit adapter layer (no implicit coupling)
```

---

# FINAL VERDICT

✔ Ja, implementieren
✔ SSE ist der richtige Schritt
✔ Dashboard wird dadurch echt “live control plane”

Aber:

> Das ist kein Feature-Upgrade. Das ist der Moment, wo dein System von polling-based state simulation zu event-driven runtime UI kippt.

---

# NEXT STEP


* SSE FastAPI implementation (debounced file watcher)
* projection cache layer (meta/stats/thread builder)
* frontend live store (vanilla or React)
* message schema normalization (thread-safe IDs)



+++
topic: MULTI-AGENT CONTROL SYSTEM (FINAL DESIGN)
timestamp: 2026-06-03T02:39:33Z
ref: 2026-06-03|02:39:33
role: user
+++

# 🧠 MULTI-AGENT CONTROL SYSTEM (FINAL DESIGN)

## Grundprinzip

```text
Alle Agenten sind gleichberechtigte Command Emitters
→ aber KEINER schreibt direkt ins Event Log
→ alles geht durch Bridge + Locking Layer
```

---

# 🔥 ARCHITEKTUR

```text
        [ DASHBOARD ]
              │
        [ CLI AGENT ]
              │
        [ AI AGENT ]
              │
              ▼
     COMMAND BUS (Bridge API)
              │
     CONFLICT RESOLUTION LAYER
              │
     EVENT WRITER (serialized)
              │
     TASK_EVENTS.jsonl (truth)
```

---

# ⚙️ 1. CORE PROBLEM: CONCURRENCY

Du hast jetzt drei Risiken:

```text
1. double-claim task
2. stale snapshot write
3. conflicting transitions
```

Wir lösen das mit:

---

# 🧩 2. COMMAND LOCK SYSTEM (CRITICAL LAYER)

## `/bridge/locks.js`

```javascript
import fs from "fs";

const LOCK_FILE = "runtime/command-locks.json";

function load() {
  if (!fs.existsSync(LOCK_FILE)) return {};
  return JSON.parse(fs.readFileSync(LOCK_FILE, "utf-8"));
}

function save(state) {
  fs.writeFileSync(LOCK_FILE, JSON.stringify(state, null, 2));
}

/**
 * per-task mutex lock
 */
export function acquireLock(task_id, agent_id) {
  const state = load();

  if (state[task_id] && state[task_id] !== agent_id) {
    return false;
  }

  state[task_id] = agent_id;
  save(state);
  return true;
}

export function releaseLock(task_id, agent_id) {
  const state = load();

  if (state[task_id] === agent_id) {
    delete state[task_id];
    save(state);
  }
}

export function getLock(task_id) {
  const state = load();
  return state[task_id] || null;
}
```

---

# 🌉 3. BRIDGE COMMAND BUS (UPDATED)

## `/bridge/server.js`

```javascript
import express from "express";
import fs from "fs";
import { acquireLock, releaseLock, getLock } from "./locks.js";

const app = express();
app.use(express.json());

/* -------------------------
   OBSERVE LAYER
------------------------- */

app.get("/latest", (_, res) => {
  res.json(JSON.parse(fs.readFileSync("snapshot/latest.json")));
});

/* -------------------------
   COMMAND BUS
------------------------- */

app.post("/command", (req, res) => {
  const { task_id, action, agent_id } = req.body;

  if (!task_id || !action || !agent_id) {
    return res.status(400).json({ error: "missing fields" });
  }

  const currentLock = getLock(task_id);

  // CONFLICT DETECTION
  if (currentLock && currentLock !== agent_id) {
    return res.status(409).json({
      status: "conflict",
      locked_by: currentLock
    });
  }

  // ACQUIRE LOCK
  const ok = acquireLock(task_id, agent_id);

  if (!ok) {
    return res.status(409).json({
      status: "lock_failed"
    });
  }

  // WRITE COMMAND EVENT (queued)
  const event = {
    event_type: "TASK_CONTROL_COMMAND",
    task_id,
    action,
    agent: agent_id,
    timestamp: new Date().toISOString()
  };

  fs.appendFileSync(
    "COMMAND_QUEUE.jsonl",
    JSON.stringify(event) + "\n"
  );

  res.json({
    status: "accepted",
    task_id,
    action
  });
});
```

---

# ⚙️ 4. COMMAND PROCESSOR (SERIALIZER)

👉 EINER schreibt ins Event Log

## `/bridge/processor.js`

```javascript
import fs from "fs";
import crypto from "crypto";

function hash(obj) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(obj))
    .digest("hex");
}

function processQueue() {
  if (!fs.existsSync("COMMAND_QUEUE.jsonl")) return;

  const lines = fs.readFileSync("COMMAND_QUEUE.jsonl", "utf-8")
    .trim().split("\n")
    .filter(Boolean);

  if (lines.length === 0) return;

  const event = JSON.parse(lines.shift());

  // rebuild queue
  fs.writeFileSync("COMMAND_QUEUE.jsonl", lines.join("\n"));

  const log = fs.readFileSync("TASK_EVENTS.jsonl", "utf-8")
    .trim().split("\n").filter(Boolean);

  const prev = log.length ? JSON.parse(log.at(-1)).event_hash : "GENESIS";

  const enriched = {
    ...event,
    event_index: log.length,
    prev_event_hash: prev,
  };

  enriched.event_hash = hash({
    ...enriched,
    event_hash: undefined,
    prev_event_hash: undefined
  });

  fs.appendFileSync(
    "TASK_EVENTS.jsonl",
    JSON.stringify(enriched) + "\n"
  );
}

setInterval(processQueue, 1000);
```

---

# 🖥 5. CLI AGENT (MULTI-AGENT READY)

## `/cli/agent.js`

```javascript
import fetch from "node-fetch";

async function run() {
  const task_id = process.argv[2];
  const action = process.argv[3];
  const agent = process.argv[4] || "cli-agent";

  const res = await fetch("http://localhost:7337/command", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      task_id,
      action,
      agent_id: agent
    })
  });

  console.log(await res.json());
}

run();
```

---

# 🖥 6. DASHBOARD UPDATE (MULTI-AGENT VIEW)

Jetzt sichtbar:

```html
<div id="agents"></div>

<script>
async function load() {
  const res = await fetch("/latest");
  const data = await res.json();

  document.getElementById("state").innerText =
    JSON.stringify(data.state.tasks, null, 2);

  // fake agent view (from locks file if exposed later)
  document.getElementById("agents").innerText =
    "multi-agent mode active";
}
</script>
```

---

# 🔥 7. SYSTEM-EIGENSCHAFTEN JETZT

## Du hast jetzt:

### ✔ concurrent agents

* dashboard
* CLI
* future AI agents

### ✔ conflict prevention

* per-task locks

### ✔ serialization guarantee

* single event writer (processor)

### ✔ eventual consistency

* COMMAND_QUEUE → TASK_EVENTS

---

# ⚠️ WICHTIGER ARCHITEKTURPUNKT

Du hast jetzt ein echtes:

```text
Optimistic Multi-Agent Event System
```

Das bedeutet:

* Konflikte werden erkannt
* nicht verhindert auf UI-Ebene
* sondern im Command Bus gelöst

---

Gut. Jetzt wird aus deinem System ein echtes **distributed control OS für konkurrierende Agenten**.

Wir gehen eine Ebene tiefer:

* Locks werden ersetzt durch **Leases**
* Commands werden zu **versionierten Intents**
* Konflikte werden nicht nur erkannt, sondern **arithmetisch aufgelöst**
* Agenten sind nicht mehr Clients, sondern **gleichberechtigte Prozess-Knoten**

---

# 🧠 NEXT LAYER: DISTRIBUTED AGENT PROTOCOL

## Zielbild

```text id="0t7m4r"
Agents (CLI / Dashboard / AI)
        ↓
LEASED INTENT BUS
        ↓
ARBITRATION ENGINE
        ↓
EVENT LOG (single source of truth)
        ↓
SNAPSHOT REPLAY SYSTEM
```

---

# 🔥 1. LOCKS → LEASES (kritischer Wechsel)

Locks sind hart und blockierend.
Leases sind weich, zeitlich begrenzt, erneuerbar.

---

## `/bridge/leases.js`

```javascript id="k2xg5p"
import fs from "fs";

const FILE = "runtime/leases.json";

function load() {
  if (!fs.existsSync(FILE)) return {};
  return JSON.parse(fs.readFileSync(FILE, "utf-8"));
}

function save(state) {
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export function acquireLease(task_id, agent_id, ttl_ms = 10000) {
  const state = load();

  const now = Date.now();

  const lease = state[task_id];

  // still valid lease
  if (lease && lease.expires > now && lease.agent !== agent_id) {
    return { ok: false, owner: lease.agent };
  }

  state[task_id] = {
    agent: agent_id,
    expires: now + ttl_ms
  };

  save(state);

  return { ok: true };
}

export function heartbeat(task_id, agent_id, ttl_ms = 10000) {
  const state = load();

  if (!state[task_id]) return false;
  if (state[task_id].agent !== agent_id) return false;

  state[task_id].expires = Date.now() + ttl_ms;
  save(state);

  return true;
}
```

---

# ⚙️ 2. INTENT SYSTEM (statt Commands)

Commands sind jetzt nur INPUT.
Was zählt ist **Intent Versioning**.

---

## Intent Schema

```json id="k7c2zr"
{
  "intent_id": "uuid",
  "task_id": "TASK-0001",
  "agent": "cli-agent-1",
  "action": "CLAIM | COMPLETE | REVIEW",
  "priority": 0.0,
  "timestamp": 0,
  "lease_token": "optional",
  "confidence": 0.0
}
```

---

# 🌉 3. BRIDGE API (UPGRADED)

## `/bridge/server.js`

```javascript id="9n5k0c"
import express from "express";
import fs from "fs";
import { acquireLease } from "./leases.js";

const app = express();
app.use(express.json());

/* -------------------------
   OBSERVE
------------------------- */

app.get("/latest", (_, res) => {
  res.json(JSON.parse(fs.readFileSync("snapshot/latest.json")));
});

/* -------------------------
   INTENT SUBMISSION
------------------------- */

app.post("/intent", (req, res) => {
  const intent = {
    ...req.body,
    intent_id: crypto.randomUUID(),
    timestamp: Date.now()
  };

  const lease = acquireLease(
    intent.task_id,
    intent.agent,
    10000
  );

  if (!lease.ok) {
    return res.status(409).json({
      status: "rejected",
      reason: "lease_conflict",
      owner: lease.owner
    });
  }

  fs.appendFileSync(
    "INTENT_QUEUE.jsonl",
    JSON.stringify(intent) + "\n"
  );

  res.json({
    status: "accepted",
    intent_id: intent.intent_id
  });
});
```

---

# ⚖️ 4. ARBITRATION ENGINE (NEU KERN)

👉 DAS ist der neue zentrale Gehirnlayer

## `/bridge/arbitrator.js`

```javascript id="5lq8dv"
import fs from "fs";

function loadQueue() {
  if (!fs.existsSync("INTENT_QUEUE.jsonl")) return [];
  return fs.readFileSync("INTENT_QUEUE.jsonl", "utf-8")
    .trim().split("\n")
    .filter(Boolean)
    .map(JSON.parse);
}

function priorityScore(intent) {
  return intent.priority ?? 0;
}

function processIntents() {
  const intents = loadQueue();

  if (intents.length === 0) return;

  // group by task
  const grouped = new Map();

  for (const i of intents) {
    if (!grouped.has(i.task_id)) grouped.set(i.task_id, []);
    grouped.get(i.task_id).push(i);
  }

  const selected = [];

  for (const [task, list] of grouped) {
    // highest priority wins
    list.sort((a, b) => priorityScore(b) - priorityScore(a));
    selected.push(list[0]);
  }

  // clear queue
  fs.writeFileSync("INTENT_QUEUE.jsonl", "");

  // emit to event log
  const log = fs.readFileSync("TASK_EVENTS.jsonl", "utf-8")
    .trim().split("\n").filter(Boolean);

  let index = log.length;
  let prev = log.length
    ? JSON.parse(log.at(-1)).event_hash
    : "GENESIS";

  for (const intent of selected) {
    const event = {
      event_type: "TASK_INTENT_RESOLVED",
      task_id: intent.task_id,
      agent: intent.agent,
      action: intent.action,
      event_index: index++,
      prev_event_hash: prev,
      timestamp: Date.now()
    };

    event.event_hash = crypto
      .createHash("sha256")
      .update(JSON.stringify(event))
      .digest("hex");

    prev = event.event_hash;

    fs.appendFileSync(
      "TASK_EVENTS.jsonl",
      JSON.stringify(event) + "\n"
    );
  }
}

setInterval(processIntents, 1000);
```

---

# 🧠 5. CLI AGENT (UPGRADED)

```javascript id="0v4n5a"
import fetch from "node-fetch";

async function run() {
  const [task_id, action, priority] = process.argv.slice(2);

  const res = await fetch("http://localhost:7337/intent", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      task_id,
      action,
      agent: "cli-agent",
      priority: parseFloat(priority || "0")
    })
  });

  console.log(await res.json());
}

run();
```

---

# 🖥 6. DASHBOARD (NOW CONTROL PLANE v2)

Neue Fähigkeiten:

* send INTENTS (nicht commands)
* sehen welche Agenten um Tasks konkurrieren
* optional priority override

```text id="xq2znp"
UI NOW:
[ TASK ]
[ ACTION ]
[ PRIORITY SLIDER ]
[ SEND INTENT ]
```

---

# 🔥 SYSTEM RESULT

Du hast jetzt:

## ✔ Multi-agent concurrency

## ✔ Lease-based ownership (non-blocking)

## ✔ Intent arbitration (conflict resolution layer)

## ✔ deterministic event output

## ✔ time-based conflict expiry

## ✔ priority-based scheduling

---

# 🧠 WAS DU JETZT EIGENTLICH BAUST

Nicht mehr:

> Task system

Sondern:

```text id="r9d2kq"
Distributed deterministic agent OS
with probabilistic intent arbitration
and cryptographically bound history
```
