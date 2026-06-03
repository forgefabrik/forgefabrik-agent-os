/**
 * schema.js — Canonical data model for the COMM Projection Engine.
 *
 * All projector output and Python reader input conforms to these shapes.
 * Types are documented as JSDoc for IDE support (no TypeScript runtime needed).
 *
 * Boundary: this module NEVER touches TASK_EVENTS.jsonl, registry.json,
 * snapshots/, or transitions.yaml.
 */

/**
 * @typedef {Object} MessageProjection
 * @property {string}      ref         - "YYYY-MM-DD|HH:MM:SS"
 * @property {string}      role        - "user" | "ai"
 * @property {string}      timestamp   - ISO-8601 UTC
 * @property {string|null} reply_to    - ref of the message this answers (ai only)
 * @property {string}      preview     - first 120 chars, markdown stripped
 * @property {number}      word_count  - approximate word count of body
 * @property {'inbox'|'outbox'} source
 */

/**
 * @typedef {Object} ThreadProjection
 * @property {string}      topic          - full topic string (key in threads map)
 * @property {number}      count          - total messages in thread
 * @property {string|null} last_user      - ref of last user message
 * @property {string|null} last_ai        - ref of last AI message
 * @property {string}      last_activity  - most recent ref overall
 * @property {MessageProjection[]} messages  - chronological list (user + ai merged)
 */

/**
 * @typedef {Object} StatsProjection
 * @property {number}      inbox_count
 * @property {number}      outbox_count
 * @property {number}      total_count
 * @property {number}      thread_count
 * @property {string|null} last_ref       - "YYYY-MM-DD|HH:MM:SS"
 * @property {number}      reply_rate     - outbox / inbox  (0–1, NaN→0)
 * @property {number}      axiom_density  - future: axiom events / total events
 */

/**
 * @typedef {Object} TimelineEntry
 * @property {string} ref
 * @property {string} topic
 * @property {string} role
 * @property {string} timestamp
 * @property {string} preview
 * @property {'inbox'|'outbox'} source
 */

/**
 * @typedef {Object} FullMessage
 * Full inbox/outbox entry — superset of MessageProjection.
 * @property {string}      topic
 * @property {string}      timestamp
 * @property {string}      ref
 * @property {'user'|'ai'} role
 * @property {string|null} reply_to
 * @property {boolean}     legacy
 * @property {string}      text         - full body text
 * @property {'inbox'|'outbox'} source
 */

/**
 * @typedef {Object} ProjectionRoot  — written to core/projection.json
 * @property {string}   schema_version   - "3.0"
 * @property {string}   engine           - "comm-projection-engine v1.0"
 * @property {string}   generated_at     - ISO-8601
 * @property {number}   sequence         - monotone counter, increments each rebuild
 * @property {StatsProjection}                   stats
 * @property {Record<string, ThreadProjection>}  threads
 * @property {FullMessage[]}                     inbox
 * @property {FullMessage[]}                     outbox
 * @property {TimelineEntry[]}                   timeline
 */

/**
 * @typedef {'full_sync'|'thread_update'|'stats_update'} EventType
 *
 * @typedef {Object} LastEvent  — written to core/last_event.json
 * @property {EventType}   type
 * @property {string}      [topic]         - set when type === 'thread_update'
 * @property {string}      [reason]        - e.g. "initial" | "rebuild" | "inbox_change"
 * @property {number}      sequence        - matches ProjectionRoot.sequence
 * @property {string}      at              - ISO-8601
 */

export const SCHEMA_VERSION = '3.0';
export const ENGINE_ID = 'comm-projection-engine v1.0';

/**
 * Strip common Markdown syntax from text for plain-text preview.
 * @param {string} text
 * @returns {string}
 */
export function stripMarkdown(text) {
  return text
    .replace(/```[\s\S]*?```/g, '[code]')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/^>\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, ' ')
    .replace(/\n/g, ' ')
    .trim();
}

/**
 * Count approximate words in text.
 * @param {string} text
 * @returns {number}
 */
export function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * Compare two ref strings ("YYYY-MM-DD|HH:MM:SS") — returns positive if a > b.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareRef(a, b) {
  return (a || '').localeCompare(b || '');
}
