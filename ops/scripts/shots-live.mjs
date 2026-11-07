// Screenshots of the ops console following the live server through the scripted hero demo.
//
//   cd server && npm run demo        (fake mode, demo routes, 127.0.0.1:8796)
//   cd ops && npm run dev            (http://127.0.0.1:5197, proxies /api to the server)
//   cd ops && npm run shots:live     (writes PNGs to ../proto-shots/v2/live, kept out of git)
//
// The script starts the hero script on the server (POST /api/demo/start, which
// resets the market), waits for each moment on the server's market clock,
// pauses the demo there, lets the console poll, takes the board and the market
// dashboard, and resumes. Env: BASE_URL, OUT_DIR, CHROMIUM_PATH, SPEED.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5197';
const OUT = path.resolve(process.env.OUT_DIR ?? path.join(here, '..', '..', 'proto-shots', 'v2', 'live'));
const SPEED = Number(process.env.SPEED ?? 60);
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: 'America/Los_Angeles' };
// Expected noise: AG Studio's trial banner when the dev server has no AG Studio key (README, Licences)
// and MapLibre style warnings.
const IGNORE = /\*{10}|License Key Not Found|Incompatible License|studio\/licensing|unlocked for trial|hide the watermark|AG Studio Pro with AI|Expected value to be of type/;
const DAY = '2026-11-12';
// San Francisco is on standard time (UTC-8) on the hero day.
const sf = (hhmm) => Date.parse(`${DAY}T${hhmm.length === 5 ? `${hhmm}:00` : hhmm}-08:00`);

/** Moments of the hero run (San Francisco market time) and what each shows. */
const MOMENTS = [
  // Wei's one spot is the only offer in the book until it fills at 11:05, so the market desk is asked here.
  { at: '10:52', name: '01-checked-in-fee-clock', views: ['board', 'market'], ask: 'Widest gap', note: "Wei checked in (line photo read by the AI); his fee clock runs from $15; Rex is on the way" },
  { at: '11:06', name: '02-mia-matched-at-12', views: ['board', 'market'], note: "The clock stepped down to $12 and met Mia's request" },
  { at: '11:21', name: '03-fake-receipt-zero-moved', views: ['board'], note: "Rex's fake receipt failed four checks: $0 moved; Priya's plush went to Lin at $10" },
  // The script jumps from 11:53 to 13:58, so this moment sits just before the jump.
  { at: '11:52:45', name: '04-receipts-captured-paid', views: ['board', 'market'], note: 'Wei and Lin uploaded their receipts; captures and payouts are on the ledger' },
  // The script ends with its closing caption at 14:01 and the market holds still there.
  { at: '14:01', name: '05-shipped-final-capture', views: ['board', 'market'], note: 'Tracking added: final capture $9.57 ($8.75 + $0.82 processing), $5.44 released, $42.75 paid to Wei' },
];

const problems = [];

async function api(method, route, body, as) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(as ? { 'x-hms-user': as } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${route} answered ${res.status}: ${await res.text()}`);
  return res.json();
}

async function marketNow() {
  const c = await api('GET', '/api/clock');
  return c.paused ? c.marketNow : c.marketNow + (Date.now() - c.realNow) * c.speed;
}

async function waitForMarket(t) {
  for (let i = 0; i < 2400; i++) {
    if ((await marketNow()) >= t) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The market clock never reached ${new Date(t).toISOString()}.`);
}

async function open(browser, url) {
  const ctx = await browser.newContext(DESKTOP);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${url}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !IGNORE.test(m.text())) problems.push(`${url}: ${m.text().slice(0, 300)}`);
  });
  await page.goto(`${BASE}${url}`);
  return { ctx, page };
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
const pages = {};

try {
  const health = await api('GET', '/api/health');
  if (health.mode !== 'fake') throw new Error('Run the demo in fake mode for these shots.');
  await api('POST', '/api/demo/start', { scriptId: 'hero', speed: SPEED });
  await api('POST', '/api/demo/pause');

  pages.board = await open(browser, '/?backend=server');
  pages.market = await open(browser, '/?backend=server#/market');
  await pages.board.page.waitForSelector('.b-grid-row', { timeout: 60_000 });
  await pages.market.page.waitForSelector('.hms-gapboard', { timeout: 120_000 });
  await api('POST', '/api/demo/resume');

  for (const m of MOMENTS) {
    await waitForMarket(sf(m.at));
    await api('POST', '/api/demo/pause');
    // Let the console poll the paused market (every 1.5 s) and the map settle.
    await new Promise((r) => setTimeout(r, 4500));
    for (const view of m.views) {
      const { page } = pages[view];
      const file = path.join(OUT, `ops-live-${m.name}-${view}-1440x900.png`);
      await page.screenshot({ path: file });
      console.log('saved', file);
      if (view === 'market' && m.ask) {
        // The market desk agent answers from the live snapshot and builds its widget.
        await page.locator('button:visible, [role=button]:visible').filter({ hasText: m.ask }).first().click();
        await page.waitForSelector('.hms-spot', { timeout: 60_000 });
        await new Promise((r) => setTimeout(r, 2500));
        const agentFile = path.join(OUT, `ops-live-${m.name}-market-desk-agent-1440x900.png`);
        await page.screenshot({ path: agentFile });
        console.log('saved', agentFile);
      }
    }
    const ledger = await api('GET', '/api/ledger', undefined, 'ops');
    const moved = ledger.entries.filter((e) => e.status === 'succeeded' && e.kind === 'captured').reduce((s, e) => s + e.amount.cents, 0);
    console.log(`  ${m.at} ${m.note}. Captured so far: $${(moved / 100).toFixed(2)}`);
    await api('POST', '/api/demo/resume');
  }
} finally {
  for (const p of Object.values(pages)) await p.ctx.close().catch(() => undefined);
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exitCode = 1;
}
