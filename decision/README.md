# Decision Fabric + COI

The default operator UI is the Cybernetic Operations Interface (COI). It is
served from `ui/dashboard.html` and uses the Decision Engine aliases under
`/decision-engine/*` while legacy scheduler endpoints remain compatible.

Lokaler Kommunikationsbus zwischen User und AI — mit Live-Projection-Engine
und validiertem Event-Write-Gate zum Truth Layer.

**Boundary-Regel (hart):**
Diese Schicht liest und schreibt niemals direkt in `TASK_EVENTS.jsonl`,
`registry.json`, `snapshots/` oder `transitions.yaml` — ausser über den
expliziten Event-Write-Gate (`POST /events/write` → `event-writer.mjs`).

---

## Struktur

```
decision/
├── core/
│   ├── inbox.md          ← User → AI  (append-only, Comm Layer)
│   ├── outbox.md         ← AI  → User (append-only, Comm Layer)
│   ├── meta.json         ← DEPRECATED (wird von projection.json ersetzt)
│   ├── projection.json   ← Projection Cache (Node engine → FastAPI reads)
│   └── last_event.json   ← SSE-Hint (getippt: thread_update | stats_update | full_sync)
│
├── projection/           ← Node.js Projection Engine
│   ├── engine.js         ← Haupteinstieg: Watcher + HTTP :7338
│   ├── projector.js      ← Parst inbox/outbox, baut projection.json
│   ├── watcher.js        ← Chokidar, debounced 300 ms
│   ├── schema.js         ← JSDoc Typdefinitionen für alle Projection-Shapes
│   └── package.json
│
├── api/
│   ├── server.py         ← FastAPI v3 + uvicorn + Lifespan
│   ├── routes.py         ← Comm-Endpunkte (lesen aus Projection Cache)
│   ├── projection.py     ← In-Memory Cache + asyncio SSE Broadcaster
│   ├── events_gate.py    ← POST /events/write Gate → event-writer.mjs
│   ├── health.py
│   ├── schema.py         ← Pydantic Models
│   └── requirements.txt
│
├── cli/
│   ├── send.sh           ← User schreibt in inbox.md
│   ├── reply.sh          ← AI schreibt in outbox.md
│   └── show.sh           ← Ansicht beider Logs
│
├── ui/
│   ├── dashboard.html
│   ├── dashboard.js      ← SSE (getippt), Mailbox, Voice Player, writeTaskEvent()
│   └── styles.css
│
├── voice/
│   ├── reader.js         ← Web Speech API Engine
│   ├── hooks.js          ← Auto-read Trigger
│   └── settings.json
│
├── start.sh              ← Startet Projection Engine + FastAPI
└── README.md             ← diese Datei
```

---

## Schnellstart

```bash
cd decision
bash start.sh
```

Öffne dann:
- COI:             [http://localhost:7337/](http://localhost:7337/)
- API Docs:        [http://localhost:7337/docs](http://localhost:7337/docs)
- Engine Health:   [http://localhost:7338/health](http://localhost:7338/health)

---

## Architektur v3 — Datenfluss

```
inbox.md / outbox.md
       ↓ (file change, chokidar debounced 300 ms)
projection/engine.js  (Node.js, :7338)
       ↓ writes atomically
core/projection.json   ← vollständiger State Cache
core/last_event.json   ← getippter SSE-Hint
       ↓ mtime poll 500 ms
api/projection.py  (asyncio background watcher)
       ↓ asyncio.Queue pro SSE-Client
GET /events  (typed SSE)   ← full_sync | thread_update | stats_update | ping
       ↓
COI UI  (live, kein Polling mehr)
```

**Projection Engine (Node.js):**
- Startet auf Port `:7338` mit Health- und Status-Endpoints
- Debounce 300 ms: mehrere schnelle Writes lösen nur einen Rebuild aus
- Schreibt `projection.json` und `last_event.json` atomar (tmp → rename)
- CRLF-Normalisierung: funktioniert auf Windows und Unix

**FastAPI Read Layer:**
- Alle `GET`-Endpunkte lesen aus dem In-Memory-Cache (`projection.py`)
- Zero File-I/O pro Request
- SSE-Broadcaster: ein `asyncio.Queue` pro Client — kein Polling, reines Push

---

## CLI

### Nachricht senden (→ inbox)

```bash
cd decision

# Interaktiv
bash cli/send.sh "Mein Topic"

# Pipe
echo "Text..." | bash cli/send.sh "Mein Topic"
# → gibt aus: ref:2026-06-10|14:32:07
```

### AI antwortet (→ outbox)

```bash
echo "Antworttext..." | bash cli/reply.sh "Mein Topic" "ref:2026-06-10|14:32:07"
# → gibt aus: ref:2026-06-10|14:33:15
```

### Logs ansehen

```bash
bash cli/show.sh                    # beide
bash cli/show.sh --inbox            # nur inbox
bash cli/show.sh --outbox           # nur outbox
bash cli/show.sh --topic "Axiom"    # nach Topic filtern
bash cli/show.sh --stats            # Thread-Statistiken
bash cli/show.sh --json             # alle Einträge als JSON
```

---

## HTTP API

Server läuft auf `http://localhost:7337`.
API-Docs (OpenAPI): [http://localhost:7337/docs](http://localhost:7337/docs)

### Comm Layer (Inbox / Outbox)

```bash
# User → Inbox
curl -s -X POST http://localhost:7337/user \
  -H "Content-Type: application/json" \
  -d '{"topic": "Axiom Boundary", "text": "..."}'
# → {"status":"ok","ref":"2026-06-10|14:32:07","file":"core/inbox.md"}

# AI → Outbox
curl -s -X POST http://localhost:7337/ai \
  -H "Content-Type: application/json" \
  -d '{"topic":"Axiom Boundary","reply_to":"2026-06-10|14:32:07","text":"..."}'
# → {"status":"ok","ref":"2026-06-10|14:33:15","file":"core/outbox.md"}

# Inbox als JSON (Projection Cache)
curl -s http://localhost:7337/stream/inbox

# Outbox als JSON (Projection Cache)
curl -s http://localhost:7337/stream/outbox

# Beide
curl -s http://localhost:7337/messages

# Thread Metadaten
curl -s http://localhost:7337/meta

# Statistiken
curl -s http://localhost:7337/stats

# Thread nach Topic
curl -s "http://localhost:7337/thread/Axiom%20Boundary"

# Vollständiger Projection Cache (debug)
curl -s http://localhost:7337/projection
```

### GET /events — Getippter SSE-Stream

```bash
curl -sN http://localhost:7337/events
```

Event-Typen (nicht mehr generisch "update"):

| type | Bedeutung | UI-Aktion |
|---|---|---|
| `full_sync` | Mehrere Änderungen / Cold Connect | Vollständiger `poll()` |
| `thread_update` | Ein Thread geändert (mit `topic`) | `poll()` für diesen Thread |
| `stats_update` | Nur Zähler geändert | Stats-Bar neu laden |
| `ping` | Keep-alive (alle ~15 s) | keine |

JavaScript-Beispiel:

```javascript
const es = new EventSource('/events');
es.addEventListener('full_sync',     () => poll());
es.addEventListener('thread_update', (e) => { const { topic } = JSON.parse(e.data); refreshThread(topic); });
es.addEventListener('stats_update',  () => refreshStatsOnly());
```

### Event Gate — TASK_EVENTS.jsonl schreiben

```bash
# Task Event via HTTP (geht durch event-writer.mjs, nie direkt)
curl -s -X POST http://localhost:7337/events/write \
  -H "Content-Type: application/json" \
  -d '{
    "event_type":     "TASK_HEARTBEAT",
    "engine_version": 1,
    "timestamp":      "2026-06-03T12:00:00Z",
    "task_id":        "TASK-0001",
    "agent":          "my-agent",
    "role":           "IMPLEMENTATION",
    "model":          "gpt-4o"
  }'
# → {"ok":true,"event":{...vollständiges Event mit event_index+event_hash...}}

# Aktuelles HEAD Event
curl -s http://localhost:7337/events/head

# Chain-Status (lightweight)
curl -s http://localhost:7337/events/status
```

**Boundary:** `POST /events/write` ist der einzige erlaubte Write-Pfad aus
der UI oder via HTTP. Der Endpunkt ruft `.task-locks/event-writer.mjs` als
Subprocess auf — er schreibt nie direkt in `TASK_EVENTS.jsonl`.

---

## Dashboard Features

### Mailbox (echtes Email-Client-Layout)
- Linke Liste: Avatar-Kreis (U/AI), Subject, Preview, Timestamp, Unread-Dot
- Rechts: Detail-Pane mit Subject, Meta-Row (Badge + Ref + Timestamp), Markdown-Body
- Ordner-Tabs: All / Inbox / Outbox mit Pill-Such-Bar
- Compose-Panel: Slide-In von rechts mit Blur-Backdrop

### Voice Player (in Mailbox Detail)
- Play/Pause/Stop mit Animations-Feedback
- Speed-Slider (0.5×–2.0×), Sprach-Selektor
- Auto-Read: liest automatisch beim Öffnen einer Nachricht vor
- Ticker: zeigt aktuellen Topic

### Home View
- Avatar-Kreise auf Karten (USER blau / AI grün)
- Preview-Text (zusammengefasste erste 120 Zeichen) im Collapsed-State
- Thread-Sidebar mit Active-Highlight

### Stats Bar / Thread Sidebar / Filter / Autocomplete
- Unverändert zu v2

### SSE / Auto-Refresh
- Getippte Events — kein generisches "update" mehr
- `stats_update` triggert nur Stats-Refresh, keinen Full-Poll
- Fallback auf 5-Sekunden-Polling bei SSE-Fehler

---

## Dateiformat (Comm Layer)

Beide Logs verwenden YAML-Frontmatter, getrennt durch `+++`:

```markdown
+++
topic: Axiom Boundary
timestamp: 2026-06-10T14:32:07Z
ref: 2026-06-10|14:32:07
role: user
+++

User-Nachricht hier...
```

```markdown
+++
topic: Axiom Boundary
timestamp: 2026-06-10T14:33:15Z
ref: 2026-06-10|14:33:15
reply_to: 2026-06-10|14:32:07
role: ai
+++

AI-Antwort hier...
```

---

## Regeln

| Datei         | Wer schreibt         | Append-Only |
|---------------|----------------------|-------------|
| inbox.md      | User / send.sh       | ja          |
| outbox.md     | AI / reply.sh / POST /ai | ja      |
| projection.json | Node Projection Engine | nein (überschrieben) |
| last_event.json | Node Projection Engine | nein     |
| TASK_EVENTS.jsonl | event-writer.mjs ONLY | ja      |

---

## Voice Layer

Einstellungen in `voice/settings.json`:

```json
{
  "autoRead": true,
  "rate":     1.0,
  "pitch":    1.0,
  "lang":     "de-DE",
  "voice":    "default"
}
```

Browser-Konsole:

```javascript
voiceHooks.mute()           // Auto-Read deaktivieren
voiceHooks.unmute()         // Auto-Read aktivieren
voiceHooks.readLast(3)      // Letzte 3 Outbox-Einträge vorlesen
voiceHooks.set("rate", 0.9) // Lesegeschwindigkeit setzen

// Task Event schreiben (nur über Gate):
await writeTaskEvent({
  event_type: "TASK_HEARTBEAT", engine_version: 1,
  timestamp: new Date().toISOString(),
  task_id: "TASK-0001", agent: "user", role: "IMPLEMENTATION", model: "human"
})
```

---

## Architektur-Grenzen (hart)

```
┌──────────────────────────────────────────────────┐
│  TRUTH LAYER                                     │
│  TASK_EVENTS.jsonl  registry.json                │
│  snapshots/         transitions.yaml             │
│  event-writer.mjs   audit.mjs                    │
│  replayer.mjs       snapshot-writer.mjs          │
└────────────────────┬─────────────────────────────┘
                     │  NUR über event-writer.mjs
                     │  (POST /events/write)
┌────────────────────┴─────────────────────────────┐
│  BRIDGE / GATE LAYER                             │
│  api/events_gate.py  POST /events/write          │
│  api/events_gate.py  GET /events/head            │
│  api/events_gate.py  GET /events/status          │
└────────────────────┬─────────────────────────────┘
                     │  Keine direkte Verbindung zum Truth Layer
┌────────────────────┴─────────────────────────────┐
│  COMMUNICATION LAYER                             │
│  inbox.md   outbox.md   projection.json          │
│  API (routes.py)  CLI   Dashboard UI             │
└──────────────────────────────────────────────────┘
```

**Communication Layer darf:**
- Inbox/Outbox lesen und schreiben
- Projection Cache lesen (via FastAPI)
- Task Events über `POST /events/write` Gate schreiben

**Communication Layer darf NIEMALS:**
- Direkt in `TASK_EVENTS.jsonl` schreiben
- `registry.json` für State-Entscheidungen lesen
- `event-writer.mjs` ohne HTTP Gate aufrufen
- Snapshots ableiten oder modifizieren
