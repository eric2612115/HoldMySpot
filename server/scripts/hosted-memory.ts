// Measures what one hosted market costs (docs/HOSTING.md): builds markets in this process and
// prints RSS and heap after each batch, with garbage collection forced so the numbers are the
// markets themselves. No key is read; no model or PayPal call is made.
//
//   node --expose-gc scripts/hosted-memory.ts [markets] [how many run the whole day]   (default 40, all)

import { MarketPool } from '../src/hosted/pool.ts';
import { hostedSettings } from '../src/hosted/settings.ts';

const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('Run with node --expose-gc.');
const target = Number(process.argv[2] ?? 40);
for (const k of ['MODEL_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'HMS_AI_KEY_FILES']) delete process.env[k];
process.env.HMS_SECRETS_DIR = '/nonexistent';

const settled = () => {
  gc();
  const m = process.memoryUsage();
  return { rss: m.rss / 1048576, heap: m.heapUsed / 1048576, external: m.external / 1048576 };
};
const pool = new MarketPool({ settings: { ...hostedSettings({}), cap: target + 1, createsPerMinute: 100000, createsPerIpPerHour: 100000 } });
await pool.init();
const base = settled();
console.log(`empty process: RSS ${base.rss.toFixed(0)} MB, heap ${base.heap.toFixed(0)} MB`);
let built = 0;
const tokens = new Set<string>();
let createMs = 0;
for (const batch of [1, 5, 10, 20, 40].filter((n) => n <= target).concat(target)) {
  while (built < batch) {
    const t = performance.now();
    const token = pool.mintToken();
    tokens.add(token);
    await pool.obtain(token, `m${built}`);
    createMs += performance.now() - t;
    built++;
  }
  await new Promise((r) => setTimeout(r, 300));
  const now = settled();
  console.log(`${String(built).padStart(3)} markets: RSS ${now.rss.toFixed(0)} MB (${((now.rss - base.rss) / built).toFixed(1)} per market), heap ${now.heap.toFixed(0)} MB (${((now.heap - base.heap) / built).toFixed(1)} per market), built in ${(createMs / built).toFixed(0)} ms each`);
}
// The same markets after a whole scripted day: photos on disk, ledger and events in SQLite.
const markets = [...tokens].map((t) => pool.peek(t)!);
const used = Number(process.argv[3] ?? markets.length);
for (let i = 0; i < used; i += 5) {
  await Promise.all(
    markets.slice(i, i + 5).map(async (m) => {
      m.lastActive = Date.now();
      await m.server.director!.start('hero', 600);
      while (m.server.director!.state().status !== 'finished') await new Promise((r) => setTimeout(r, 250));
    }),
  );
}
await new Promise((r) => setTimeout(r, 300));
const after = settled();
console.log(`after ${used} whole hero days: RSS ${after.rss.toFixed(0)} MB (${((after.rss - base.rss) / built).toFixed(1)} per market), heap ${after.heap.toFixed(0)} MB`);
for (const m of markets) m.lastActive = 0;
await new Promise((r) => setTimeout(r, 1000));
const c0 = process.cpuUsage();
const t0 = performance.now();
await new Promise((r) => setTimeout(r, 5000));
const c = process.cpuUsage(c0);
console.log(`${built} idle markets use ${(((c.user + c.system) / 1000 / (performance.now() - t0)) * 100).toFixed(1)}% of one CPU.`);
await pool.close();
process.exit(0);
