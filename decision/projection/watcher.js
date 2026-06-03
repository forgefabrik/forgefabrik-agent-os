/**
 * watcher.js — Debounced file watcher for the COMM Projection Engine.
 *
 * Watches core/inbox.md and core/outbox.md.  On any change, waits for a
 * 300 ms quiet window (debounce) before triggering a projection rebuild.
 * This prevents burst writes from causing multiple rapid rebuilds.
 *
 * Boundary: NEVER touches TASK_EVENTS.jsonl, registry.json, snapshots/,
 * or transitions.yaml.
 */

import chokidar from 'chokidar';
import { rebuild, paths } from './projector.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Quiet-window in ms before a rebuild fires after the last file event. */
const DEBOUNCE_MS = 300;

/** Map from watched path → 'inbox' | 'outbox' trigger label. */
const TRIGGER_MAP = {
  [paths.inbox]:  'inbox',
  [paths.outbox]: 'outbox',
};

// ---------------------------------------------------------------------------
// Watcher factory
// ---------------------------------------------------------------------------

/**
 * Start the debounced file watcher.
 *
 * @param {Object}   [opts]
 * @param {number}   [opts.debounceMs=300]   Quiet-window in ms.
 * @param {function} [opts.onRebuild]        Called after each successful rebuild
 *                                           with `(projection, event)`.
 * @param {function} [opts.onError]          Called on watch / rebuild errors.
 * @returns {{ watcher: chokidar.FSWatcher, stop: function }}
 */
export function startWatcher({
  debounceMs = DEBOUNCE_MS,
  onRebuild  = null,
  onError    = null,
} = {}) {
  /** @type {ReturnType<typeof setTimeout>|null} */
  let timer         = null;
  /** @type {'inbox'|'outbox'|'initial'} */
  let lastTrigger   = 'initial';

  /**
   * Schedule a debounced rebuild.
   * @param {'inbox'|'outbox'} trigger
   */
  function scheduleRebuild(trigger) {
    lastTrigger = trigger;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        const { projection, event } = rebuild(lastTrigger);
        if (onRebuild) onRebuild(projection, event);
      } catch (err) {
        if (onError) onError(err);
        else console.error('[projection/watcher] rebuild error:', err);
      }
    }, debounceMs);
  }

  // Chokidar options: use polling on Windows/network drives for reliability
  const watcher = chokidar.watch([paths.inbox, paths.outbox], {
    persistent:         true,
    ignoreInitial:      true,     // don't fire 'add' events on startup
    awaitWriteFinish: {
      stabilityThreshold: 100,    // wait 100 ms after last write before emitting
      pollInterval:       50,
    },
    usePolling:         process.platform === 'win32', // reliable on Windows NTFS
    interval:           200,
    binaryInterval:     300,
  });

  watcher
    .on('change', (filePath) => {
      const trigger = TRIGGER_MAP[filePath] ?? 'initial';
      scheduleRebuild(trigger);
    })
    .on('add', (filePath) => {
      // Fires when a watched file is created (e.g. first write)
      const trigger = TRIGGER_MAP[filePath] ?? 'initial';
      scheduleRebuild(trigger);
    })
    .on('error', (err) => {
      if (onError) onError(err);
      else console.error('[projection/watcher] chokidar error:', err);
    });

  function stop() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    watcher.close();
  }

  return { watcher, stop };
}
