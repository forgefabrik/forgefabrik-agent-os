/**
 * projector.js — Core projection builder for the COMM Projection Engine.
 *
 * Reads core/inbox.md and core/outbox.md, parses all +++ frontmatter entries,
 * builds the full typed projection and writes:
 *   core/projection.json  — complete computed state (read by FastAPI)
 *   core/last_event.json  — typed change hint (read by SSE broadcaster)
 *
 * Boundary: NEVER touches TASK_EVENTS.jsonl, registry.json, snapshots/,
 * or transitions.yaml.
 */

import fs from 'fs';
import path from 'path';
import {
  SCHEMA_VERSION,
  ENGINE_ID,
  stripMarkdown,
  wordCount,
  compareRef,
} from './schema.js';

// ---------------------------------------------------------------------------
// Paths (resolved relative to decision/)
// ---------------------------------------------------------------------------

const BASE        = path.resolve(import.meta.dirname, '..');
const INBOX_PATH  = path.join(BASE, 'core', 'inbox.md');
const OUTBOX_PATH = path.join(BASE, 'core', 'outbox.md');
const PROJ_PATH   = path.join(BASE, 'core', 'projection.json');
const EVENT_PATH  = path.join(BASE, 'core', 'last_event.json');

// ---------------------------------------------------------------------------
// Monotone sequence counter (persisted across warm rebuilds in this process)
// ---------------------------------------------------------------------------

let _sequence = 0;

function _nextSequence() {
  // Try to read the existing projection's sequence so we continue from it
  // even after a process restart.
  if (_sequence === 0) {
    try {
      const existing = JSON.parse(fs.readFileSync(PROJ_PATH, 'utf8'));
      _sequence = (existing.sequence ?? 0) + 1;
    } catch {
      _sequence = 1;
    }
  } else {
    _sequence += 1;
  }
  return _sequence;
}

// ---------------------------------------------------------------------------
// Frontmatter parser  (mirrors Python schema.py logic)
// ---------------------------------------------------------------------------

/**
 * Parse all +++ entries from a .md file.
 *
 * File format:
 *   # header comments (ignored)
 *   \n+++\nkey: value\n...\n+++\n\nbody text\n
 *
 * @param {string} content   raw file text
 * @param {'inbox'|'outbox'} source
 * @returns {import('./schema.js').FullMessage[]}
 */
function parseEntries(content, source) {
  // Normalise Windows CRLF to LF so the +++ separator matches regardless of
  // how the .md file was written (Git Bash, Notepad, VS Code, etc.).
  const normalised = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Split on the entry separator.  parts[0] = file header, then alternating
  // frontmatter / body pairs.
  const parts = normalised.split('\n+++\n');
  /** @type {import('./schema.js').FullMessage[]} */
  const entries = [];

  let i = 1;
  while (i < parts.length - 1) {
    const fmRaw = parts[i];
    const body  = parts[i + 1]?.trim() ?? '';
    i += 2;

    // Parse key: value lines
    /** @type {Record<string, string>} */
    const fm = {};
    for (const line of fmRaw.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) fm[m[1].trim()] = m[2].trim();
    }

    // Skip malformed blocks (must have both role and ref)
    if (!fm.role || !fm.ref) continue;

    entries.push({
      topic:     fm.topic     ?? '',
      timestamp: fm.timestamp ?? '',
      ref:       fm.ref,
      role:      /** @type {'user'|'ai'} */ (fm.role),
      reply_to:  fm.reply_to  ?? null,
      legacy:    (fm.legacy ?? 'false').toLowerCase() === 'true',
      text:      body,
      source,
    });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Projection builder
// ---------------------------------------------------------------------------

/**
 * Compute the full projection from raw file content.
 *
 * @param {import('./schema.js').FullMessage[]} inbox
 * @param {import('./schema.js').FullMessage[]} outbox
 * @param {number} sequence
 * @returns {import('./schema.js').ProjectionRoot}
 */
function buildProjection(inbox, outbox, sequence) {
  const all = [
    ...inbox.map(e => ({ ...e, source: /** @type {'inbox'} */ ('inbox')  })),
    ...outbox.map(e => ({ ...e, source: /** @type {'outbox'} */ ('outbox') })),
  ];

  // Sort entire message set by ref (chronological)
  all.sort((a, b) => compareRef(a.ref, b.ref));

  // ── Threads ─────────────────────────────────────────────────────────────
  /** @type {Record<string, import('./schema.js').ThreadProjection>} */
  const threads = {};

  for (const msg of all) {
    const topic = msg.topic || '(no topic)';
    if (!threads[topic]) {
      threads[topic] = {
        topic,
        count:         0,
        last_user:     null,
        last_ai:       null,
        last_activity: '',
        messages:      [],
      };
    }
    const t = threads[topic];
    t.count += 1;
    if (compareRef(msg.ref, t.last_activity) > 0) {
      t.last_activity = msg.ref;
    }
    if (msg.role === 'user' && compareRef(msg.ref, t.last_user ?? '') > 0) {
      t.last_user = msg.ref;
    }
    if (msg.role === 'ai'   && compareRef(msg.ref, t.last_ai   ?? '') > 0) {
      t.last_ai = msg.ref;
    }
    t.messages.push({
      ref:        msg.ref,
      role:       msg.role,
      timestamp:  msg.timestamp,
      reply_to:   msg.reply_to,
      preview:    stripMarkdown(msg.text).slice(0, 120),
      word_count: wordCount(msg.text),
      source:     msg.source,
    });
  }

  // ── Timeline ─────────────────────────────────────────────────────────────
  // Global chronological list of all messages (slim form, newest-last)
  /** @type {import('./schema.js').TimelineEntry[]} */
  const timeline = all.map(msg => ({
    ref:       msg.ref,
    topic:     msg.topic,
    role:      msg.role,
    timestamp: msg.timestamp,
    preview:   stripMarkdown(msg.text).slice(0, 120),
    source:    msg.source,
  }));

  // ── Stats ────────────────────────────────────────────────────────────────
  const inboxCount  = inbox.length;
  const outboxCount = outbox.length;
  const lastRef     = all.length ? all[all.length - 1].ref : null;

  /** @type {import('./schema.js').StatsProjection} */
  const stats = {
    inbox_count:    inboxCount,
    outbox_count:   outboxCount,
    total_count:    inboxCount + outboxCount,
    thread_count:   Object.keys(threads).length,
    last_ref:       lastRef,
    reply_rate:     inboxCount > 0 ? Math.round((outboxCount / inboxCount) * 100) / 100 : 0,
    // axiom_density: future — ratio of ARCHITECT events in TASK_EVENTS
    // (communication layer stays isolated; 0.0 placeholder is correct here)
    axiom_density:  0.0,
  };

  return {
    schema_version: SCHEMA_VERSION,
    engine:         ENGINE_ID,
    generated_at:   new Date().toISOString(),
    sequence,
    stats,
    threads,
    inbox:    inbox.map(e => ({ ...e, source: 'inbox'  })),
    outbox:   outbox.map(e => ({ ...e, source: 'outbox' })),
    timeline,
  };
}

// ---------------------------------------------------------------------------
// Detect what changed (for typed SSE events)
// ---------------------------------------------------------------------------

/**
 * Compare new projection to the previous one and determine the event type.
 *
 * @param {import('./schema.js').ProjectionRoot|null} prev
 * @param {import('./schema.js').ProjectionRoot}      next
 * @param {string} trigger  - 'inbox'|'outbox'|'initial'
 * @returns {import('./schema.js').LastEvent}
 */
function detectEvent(prev, next, trigger) {
  const at  = new Date().toISOString();
  const seq = next.sequence;

  if (!prev) {
    return { type: 'full_sync', reason: 'initial', sequence: seq, at };
  }

  // Check if stats changed
  const statsChanged =
    prev.stats.inbox_count  !== next.stats.inbox_count  ||
    prev.stats.outbox_count !== next.stats.outbox_count ||
    prev.stats.thread_count !== next.stats.thread_count;

  // Find the newest message ref across new - prev
  const prevRefs = new Set([
    ...prev.inbox .map(m => m.ref),
    ...prev.outbox.map(m => m.ref),
  ]);
  const newMessages = [
    ...next.inbox .filter(m => !prevRefs.has(m.ref)),
    ...next.outbox.filter(m => !prevRefs.has(m.ref)),
  ];

  if (newMessages.length === 1) {
    // Single new message — emit a targeted thread_update
    return {
      type:     'thread_update',
      topic:    newMessages[0].topic,
      reason:   trigger,
      sequence: seq,
      at,
    };
  }

  if (newMessages.length > 1) {
    // Multiple new messages (e.g. initial load after restart) — full sync
    return { type: 'full_sync', reason: 'multi_new', sequence: seq, at };
  }

  // No new messages but content changed (e.g. only stats differ) — stats_update
  if (statsChanged) {
    return { type: 'stats_update', reason: trigger, sequence: seq, at };
  }

  // Fallback
  return { type: 'full_sync', reason: 'fallback', sequence: seq, at };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read the current projection from disk (null if not yet built).
 * @returns {import('./schema.js').ProjectionRoot|null}
 */
function loadExistingProjection() {
  try {
    return JSON.parse(fs.readFileSync(PROJ_PATH, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Full rebuild cycle:
 *   1. Read inbox + outbox
 *   2. Parse entries
 *   3. Build projection
 *   4. Write core/projection.json
 *   5. Write core/last_event.json
 *   6. Return the event type that was emitted
 *
 * @param {'inbox'|'outbox'|'initial'} [trigger='initial']
 * @returns {{ projection: import('./schema.js').ProjectionRoot, event: import('./schema.js').LastEvent }}
 */
export function rebuild(trigger = 'initial') {
  const prev     = loadExistingProjection();
  const sequence = _nextSequence();

  // Read files (tolerate missing)
  const inboxContent  = fs.existsSync(INBOX_PATH)  ? fs.readFileSync(INBOX_PATH,  'utf8') : '';
  const outboxContent = fs.existsSync(OUTBOX_PATH) ? fs.readFileSync(OUTBOX_PATH, 'utf8') : '';

  const inbox  = parseEntries(inboxContent,  'inbox');
  const outbox = parseEntries(outboxContent, 'outbox');

  const projection = buildProjection(inbox, outbox, sequence);
  const event      = detectEvent(prev, projection, trigger);

  // Write atomically (write to .tmp then rename) to avoid partial reads
  const projTmp  = PROJ_PATH  + '.tmp';
  const eventTmp = EVENT_PATH + '.tmp';

  fs.mkdirSync(path.dirname(PROJ_PATH), { recursive: true });
  fs.writeFileSync(projTmp,  JSON.stringify(projection, null, 2), 'utf8');
  fs.writeFileSync(eventTmp, JSON.stringify(event,      null, 2), 'utf8');
  fs.renameSync(projTmp,  PROJ_PATH);
  fs.renameSync(eventTmp, EVENT_PATH);

  return { projection, event };
}

/**
 * Paths exported for use by engine.js / watcher.js.
 */
export const paths = {
  inbox:      INBOX_PATH,
  outbox:     OUTBOX_PATH,
  projection: PROJ_PATH,
  lastEvent:  EVENT_PATH,
  base:       BASE,
};
