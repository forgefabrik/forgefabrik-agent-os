import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ECONOMY_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(ECONOMY_DIR);
const EVENTS = path.join(ROOT, 'TASK_EVENTS.jsonl');
const OUT = path.join(ECONOMY_DIR, 'market_state.json');

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const DRY_RUN = argv.includes('--dry-run');

function readEvents() {
  if (!fs.existsSync(EVENTS)) return [];
  return fs.readFileSync(EVENTS, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function project(events) {
  const bidsByTask = new Map();
  const winners = new Map();
  const prices = new Map();

  for (const ev of events) {
    if (ev.event_type === 'TASK_BID_SUBMITTED') {
      const list = bidsByTask.get(ev.task_id) || [];
      list.push({
        bid_id: ev.bid_id,
        task_id: ev.task_id,
        agent_id: ev.agent,
        bid_strength: ev.bid_strength ?? 0,
        cost_offer: ev.cost_offer ?? 1,
        confidence: ev.confidence ?? 0,
        event_index: ev.event_index,
      });
      bidsByTask.set(ev.task_id, list);
    }
    if (ev.event_type === 'TASK_BID_WON') {
      winners.set(ev.task_id, ev.bid_id);
    }
    if (ev.event_type === 'TASK_PRICE_DISCOVERED') {
      prices.set(ev.task_id, ev.price_multiplier);
    }
  }

  const tasks = {};
  for (const [task_id, bids] of bidsByTask.entries()) {
    const ranked = [...bids].sort((a, b) => {
      const scoreA = (a.bid_strength * a.confidence) / Math.max(a.cost_offer, 1);
      const scoreB = (b.bid_strength * b.confidence) / Math.max(b.cost_offer, 1);
      if (scoreB !== scoreA) return scoreB - scoreA;
      return a.event_index - b.event_index;
    });
    const active_bid_count = bids.length;
    const market_pressure_multiplier = prices.get(task_id) ?? Number((1 + active_bid_count / 10).toFixed(4));
    tasks[task_id] = {
      task_id,
      active_bid_count,
      market_pressure_multiplier,
      winning_bid_id: winners.get(task_id) || ranked[0]?.bid_id || null,
      top_bid: ranked[0] || null,
      bids: ranked,
    };
  }

  return {
    schema_version: '2.0.0',
    generated_at: new Date(0).toISOString(),
    event_count: events.length,
    bid_event_count: events.filter(e => e.event_type === 'TASK_BID_SUBMITTED').length,
    tasks,
  };
}

const market = project(readEvents());
if (!DRY_RUN) fs.writeFileSync(OUT, JSON.stringify(market, null, 2) + '\n', 'utf8');
if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: true, market }, null, 2) + '\n');
