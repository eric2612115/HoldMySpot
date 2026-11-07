// Screenshots and a short video of the order book view (web/src/ui/book), on the hero day.
//
//   node scripts/dev.mjs --server-port 8796 --no-web --no-ops      (repo root: fake PayPal with the demo routes)
//   npm run build && npx vite preview --port 5190                  (web/: no hot updates while shooting)
//   node scripts/book-shots.mjs                                     (web/: writes ../proto-shots/v3/working)
//
// It resets the demo market to the hero script, moves the market clock with POST /api/demo/clock,
// and saves book-*.png plus book-stepdown.webm: Wei's fee stepping down from $14 until it meets
// Mia's $12 request and both leave the book. The video uses the book's own Next step and Run buttons.
// Env: BASE_URL, API_URL, OUT_DIR, GL=metal|swiftshader, CHROMIUM_PATH, ONLY=shots|video (default both).
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5190';
const API = process.env.API_URL ?? 'http://127.0.0.1:8796';
const OUT = path.resolve(process.env.OUT_DIR ?? path.join(here, '..', '..', 'proto-shots', 'v3', 'working'));
const GL = process.env.GL ?? (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const args =
  GL === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const TZ = 'America/Los_Angeles';
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: TZ };
const WIDE = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: TZ };
const ITEM = 'plush-paper-moon';
const problems = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Market time on the hero day, San Francisco (standard time, UTC-8). */
const sf = (hhmmss) => Date.parse(`2026-11-12T${hhmmss.length === 5 ? `${hhmmss}:00` : hhmmss}-08:00`);

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** The hero day from its start, held still, then jumped to `hhmm` with every step on the way run. */
async function heroAt(hhmm) {
  await api('POST', '/api/demo/reset', { seed: null, scriptId: 'hero' });
  await api('POST', '/api/demo/start', { scriptId: 'hero', speed: null });
  await api('POST', '/api/demo/clock', { paused: true });
  const t = sf(hhmm);
  await api('POST', '/api/demo/clock', { jumpTo: t });
  for (let i = 0; i < 120; i++) {
    const s = await api('GET', '/api/demo/state');
    if (s.nextStepAt === null || s.nextStepAt > t) break;
    await sleep(250);
  }
  await sleep(600);
}

async function open(browser, opts, url) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${url}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${url}: ${m.text()}`);
  });
  await page.goto(`${BASE}${url}`);
  return { ctx, page };
}

async function mapReady(page) {
  await page.waitForSelector('.veil.is-gone', { state: 'attached', timeout: 90_000 });
  await page.waitForTimeout(3000);
}

async function bookReady(page) {
  await mapReady(page);
  await page.waitForSelector('.obook .obook-ladder', { timeout: 30_000 });
  await page.waitForTimeout(1200);
}

async function shot(page, name, opts = {}) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, ...opts });
  console.log('saved', file);
}

const nextStep = (page) => page.locator('.obook-demo__btn.is-primary', { hasText: 'Next step' }).click();

await mkdir(OUT, { recursive: true });
try {
  const health = await api('GET', '/api/health');
  if (health.mode !== 'fake') throw new Error(`the server runs ${health.mode}, not fake`);
  await api('GET', '/api/demo/state');
} catch (err) {
  console.error(`Needs a HoldMySpot server in fake mode with the demo routes on ${API} (${err.message}).`);
  process.exit(1);
}
const browser = await chromium.launch({ args, executablePath: process.env.CHROMIUM_PATH });

const ONLY = process.env.ONLY ?? 'all';

try {
  if (ONLY !== 'video') {
    // The ways in, at 10:52: Wei checked in at 10:50 and his fee clock runs; Mia's $12 request is the best.
    await heroAt('10:52');
    {
      const { ctx, page } = await open(browser, MOBILE, '/?as=mia&demo=1');
      await mapReady(page);
      await shot(page, 'book-05-way-in-map-label-badges-390x844');
      const label = page.locator('.tlabel', { has: page.locator('.tlabel__ticket', { hasText: 'Mochi Bunny' }) }).first();
      const box = await label.boundingBox();
      if (box) {
        const pad = 26;
        await shot(page, 'book-05b-map-label-badge-closeup', {
          clip: { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad), width: Math.min(390 - Math.max(0, box.x - pad), box.width + pad * 2), height: box.height + pad * 2 },
        });
      }
      await label.locator('.tlabel__ticket').click();
      await page.waitForTimeout(1800);
      await shot(page, 'book-06-way-in-shop-sheet-390x844');
      await page.locator('.sheet .obook-strip').click();
      await bookReady(page);
      await shot(page, 'book-01-order-book-1052-390x844');
      await ctx.close();
    }
    {
      // The queuer's phone: Wei's task card carries the same way in.
      const { ctx, page } = await open(browser, MOBILE, '/?as=mia&demo=1&phone=queuer');
      await mapReady(page);
      await page.locator('.tlabel__ticket', { hasText: 'Mochi Bunny' }).first().click();
      await page.waitForTimeout(1800);
      await shot(page, 'book-07-way-in-queuer-task-card-390x844');
      await page.locator('.sheet .obook-strip').click();
      await bookReady(page);
      await shot(page, 'book-08-order-book-on-the-queuer-phone-390x844');
      await ctx.close();
    }

    // The step-down to the match, with the book's own demo clock buttons.
    {
      const { ctx, page } = await open(browser, MOBILE, `/?as=mia&demo=1&book=${ITEM}`);
      await bookReady(page);
      await nextStep(page); // 10:55: $15 -> $14
      await page.waitForTimeout(1500);
      await api('POST', '/api/demo/clock', { jumpTo: sf('10:57:30') });
      await page.waitForTimeout(1500);
      await shot(page, 'book-02-stepped-down-to-14-390x844');
      await nextStep(page); // 11:00: $13
      await page.waitForTimeout(1500);
      await nextStep(page); // 11:05: $12 meets Mia's $12 request
      await page.waitForSelector('.obook-flash', { timeout: 15_000 });
      await page.waitForTimeout(450);
      await shot(page, 'book-03-matched-at-12-390x844');
      await page.waitForSelector('.obook-flash', { state: 'detached', timeout: 15_000 });
      await page.waitForTimeout(900);
      await shot(page, 'book-04-after-the-match-390x844');
      await ctx.close();
    }

    // 1920x1080: the desktop stage with the phone frame, the book open mid-clock.
    await heroAt('10:58:40');
    {
      const { ctx, page } = await open(browser, WIDE, `/?as=mia&demo=1&book=${ITEM}`);
      await bookReady(page);
      await shot(page, 'book-09-desktop-stage-1920x1080');
      await ctx.close();
    }
  }

  // The video: 10:53:30, two Next steps ($14, $13), then Run at 60x into the match at 11:05.
  if (ONLY !== 'shots') {
    await heroAt('10:53:30');
    const dir = path.join(os.tmpdir(), `hms-book-video-${process.pid}`);
    // Playwright records CSS pixels and only scales down, so the video is the phone's own size.
    const ctx = await browser.newContext({ ...MOBILE, recordVideo: { dir, size: { width: 390, height: 844 } } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(`video: ${e.message}`));
    await page.goto(`${BASE}/?as=mia&demo=1&book=${ITEM}`);
    // The book draws above the map's loading screen, so the recording opens on it while the map loads behind.
    await page.waitForSelector('.obook .obook-ladder', { timeout: 60_000 });
    await page.waitForSelector('.veil.is-gone', { state: 'attached', timeout: 90_000 });
    await page.waitForTimeout(1200);
    await nextStep(page);
    await page.waitForTimeout(2300);
    await nextStep(page);
    await page.waitForTimeout(2300);
    await page.locator('.obook-demo__btn', { hasText: 'Run' }).click();
    await page.waitForSelector('.obook-flash', { timeout: 20_000 });
    await page.waitForTimeout(3600);
    await page.locator('.obook-demo__btn', { hasText: 'Pause' }).click();
    await page.waitForTimeout(900);
    const video = page.video();
    await ctx.close();
    const out = path.join(OUT, 'book-stepdown.webm');
    await video.saveAs(out);
    await rm(dir, { recursive: true, force: true });
    console.log('saved', out);
  }

  // The in-browser market (no server): the same book from the shared engine and its own crowd.
  if (ONLY !== 'video') {
    const { ctx, page } = await open(browser, MOBILE, `/?backend=mock&speed=60&book=${ITEM}`);
    await bookReady(page);
    await shot(page, 'book-10-in-browser-market-390x844');
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (problems.length) {
  console.log('\nPage errors:');
  for (const p of problems) console.log(' -', p);
  process.exitCode = 1;
} else {
  console.log('\nNo page errors.');
}
