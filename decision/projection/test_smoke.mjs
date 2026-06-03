// Quick smoke test — run from the projection/ directory:
//   node test_smoke.mjs
import { rebuild } from './projector.js';

console.log('Running projection smoke test…');
const { projection, event } = rebuild('initial');

console.log('  seq:      ', projection.sequence);
console.log('  threads:  ', projection.stats.thread_count);
console.log('  inbox:    ', projection.stats.inbox_count);
console.log('  outbox:   ', projection.stats.outbox_count);
console.log('  last_ref: ', projection.stats.last_ref);
console.log('  event:    ', event.type, event.topic ?? '');
const first = Object.keys(projection.threads)[0] ?? '(none)';
console.log('  thread[0]:', first);

// Sanity checks
console.assert(projection.sequence > 0,             'sequence must be > 0');
console.assert(typeof projection.stats === 'object', 'stats must be an object');
console.assert(Array.isArray(projection.inbox),      'inbox must be an array');
console.assert(Array.isArray(projection.outbox),     'outbox must be an array');
console.assert(Array.isArray(projection.timeline),   'timeline must be an array');
console.assert(typeof projection.threads === 'object','threads must be an object');

console.log('PASS ✓');
