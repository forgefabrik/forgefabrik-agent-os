/**
 * engine.js — COMM Projection Engine main entry point.
 *
 * Starts the file watcher and serves a lightweight HTTP health endpoint.
 *
 * Flow:
 *   1. Initial projection build (cold start).
 *   2. Chokidar watches core/inbox.md + core/outbox.md.
 *   3. On any change (debounced 300 ms):
 *        projector.rebuild() → writes projection.json + last_event.json
 *   4. FastAPI reads projection.json on every GET request and watches
 *      its mtime for SSE push events.
 *
 * HTTP (port 7338):
 *   GET /health  → {"status":"ok","sequence":N,"generated_at":"ISO"}
 *   GET /status  → same + last event details
 *
 * Boundary: NEVER touches TASK_EVENTS.jsonl, registry.json, snapshots/,
 * or transitions.yaml.
 *
 * Usage:
 *   node engine.js [--port 7338] [--debounce 300]
 */

import http from 'http';
import { rebuild, paths } from './projector.js';
import { startWatcher }   from './watcher.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args    = process.argv.slice(2);
const PORT    = parseInt(args[args.indexOf('--port')    + 1] ?? '7338', 10) || 7338;
const DEBOUNCE= parseInt(args[args.indexOf('--debounce')+ 1] ?? '300',  10) || 300;

// ---------------------------------------------------------------------------
// Runtime state (shared between watcher callbacks and HTTP handler)
// ---------------------------------------------------------------------------

let _lastProjection = null;   // ProjectionRoot | null
let _lastEvent      = null;   // LastEvent | null
let _rebuilds       = 0;
let _errors         = 0;
let _startedAt      = new Date().toISOString();

// ---------------------------------------------------------------------------
// Banner
// ---------------------------------------------------------------------------

function printBanner() {
  console.log('');
  console.log('┌─────────────────────────────────────────────────┐');
  console.log('│  COMM Projection Engine  v1.0                   │');
  console.log('├─────────────────────────────────────────────────┤');
  console.log(`│  Health  →  http://localhost:${PORT}/health         │`);
  console.log(`│  Status  →  http://localhost:${PORT}/status         │`);
  console.log('│                                                 │');
  console.log(`│  Watching:                                      │`);
  console.log(`│    inbox  →  ${paths.inbox.slice(-40).padEnd(40)} │`);
  console.log(`│    outbox →  ${paths.outbox.slice(-40).padEnd(40)} │`);
  console.log('│                                                 │');
  console.log(`│  Output:                                        │`);
  console.log(`│    projection.json  (full cache)                │`);
  console.log(`│    last_event.json  (SSE hint)                  │`);
  console.log('│                                                 │');
  console.log('│  Stop with Ctrl+C                               │');
  console.log('└─────────────────────────────────────────────────┘');
  console.log('');
}

// ---------------------------------------------------------------------------
// HTTP health server (minimal — no external deps beyond Node builtins)
// ---------------------------------------------------------------------------

function createHealthServer() {
  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0] ?? '/';

    if (url === '/health') {
      const body = JSON.stringify({
        status:       'ok',
        sequence:     _lastProjection?.sequence ?? 0,
        generated_at: _lastProjection?.generated_at ?? null,
        rebuilds:     _rebuilds,
        errors:       _errors,
        started_at:   _startedAt,
      });
      res.writeHead(200, {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
      return;
    }

    if (url === '/status') {
      const body = JSON.stringify({
        status:       'ok',
        sequence:     _lastProjection?.sequence ?? 0,
        generated_at: _lastProjection?.generated_at ?? null,
        rebuilds:     _rebuilds,
        errors:       _errors,
        started_at:   _startedAt,
        last_event:   _lastEvent,
        stats:        _lastProjection?.stats ?? null,
        watch: {
          inbox:  paths.inbox,
          outbox: paths.outbox,
        },
      }, null, 2);
      res.writeHead(200, {
        'Content-Type':  'application/json',
        'Cache-Control': 'no-cache',
      });
      res.end(body);
      return;
    }

    // 404 for anything else
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  server.on('error', (err) => {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EADDRINUSE') {
      console.warn(`[engine] Port ${PORT} already in use — health server not started.`);
      console.warn('[engine] Projection engine will still run and write files normally.');
    } else {
      console.error('[engine] HTTP server error:', err);
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  printBanner();

  // ── 1. Initial cold-start rebuild ────────────────────────────────────────
  console.log('[engine] Building initial projection…');
  try {
    const { projection, event } = rebuild('initial');
    _lastProjection = projection;
    _lastEvent      = event;
    _rebuilds       += 1;
    console.log(
      `[engine] Initial projection built  ` +
      `seq=${projection.sequence}  ` +
      `threads=${projection.stats.thread_count}  ` +
      `inbox=${projection.stats.inbox_count}  ` +
      `outbox=${projection.stats.outbox_count}`
    );
  } catch (err) {
    console.error('[engine] Initial rebuild failed:', err);
    _errors += 1;
    // Don't abort — keep watching; files may appear later
  }

  // ── 2. Start debounced file watcher ──────────────────────────────────────
  const { stop: stopWatcher } = startWatcher({
    debounceMs: DEBOUNCE,
    onRebuild(projection, event) {
      _lastProjection = projection;
      _lastEvent      = event;
      _rebuilds       += 1;
      const { type, topic } = event;
      const topicLabel = topic ? ` topic="${topic}"` : '';
      console.log(
        `[engine] Projection rebuilt  ` +
        `seq=${projection.sequence}  ` +
        `event=${type}${topicLabel}  ` +
        `inbox=${projection.stats.inbox_count}  ` +
        `outbox=${projection.stats.outbox_count}`
      );
    },
    onError(err) {
      _errors += 1;
      console.error('[engine] Watcher/rebuild error:', err);
    },
  });

  // ── 3. Start health HTTP server ───────────────────────────────────────────
  const server = createHealthServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[engine] Health endpoint   →  http://localhost:${PORT}/health`);
    console.log(`[engine] Status endpoint   →  http://localhost:${PORT}/status`);
  });

  // ── 4. Graceful shutdown ───────────────────────────────────────────────────
  function shutdown(signal) {
    console.log(`\n[engine] Received ${signal}, shutting down…`);
    stopWatcher();
    server.close(() => {
      console.log('[engine] Clean exit.');
      process.exit(0);
    });
    // Force exit after 3 s if server doesn't close cleanly
    setTimeout(() => process.exit(0), 3000).unref();
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Keep the process alive (the watcher + HTTP server hold the event loop)
  console.log('[engine] Watching for file changes. Press Ctrl+C to stop.\n');
}

main().catch(err => {
  console.error('[engine] Fatal error:', err);
  process.exit(1);
});
