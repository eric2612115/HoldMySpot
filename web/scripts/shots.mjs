// Takes the web app's screenshots with Playwright and a local Chromium.
//
//   cd server && npm run demo   (optional: fake PayPal mode with demo routes on 127.0.0.1:8796)
//   npm run dev                 (in another terminal; serves http://127.0.0.1:5190)
//   npm run shots               (writes PNGs to ../proto-shots/v2/final)
//
// Without the server the map shots use the in-browser market and the server-only shots
// (the Simulated PayPal sheet, Wei's walk, the fee step-down card and the money panel
// after a full fake cycle) are skipped. With it, the script resets the demo market and
// plays the hero script at 60x.
// Env: BASE_URL, API_URL, OUT_DIR, GL=metal|swiftshader, CHROMIUM_PATH (optional).
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5190';
const API = process.env.API_URL ?? 'http://127.0.0.1:8796';
const OUT = path.resolve(process.env.OUT_DIR ?? path.join(here, '..', '..', 'proto-shots', 'v2', 'final'));
const GL = process.env.GL ?? (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const args =
  GL === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

const problems = [];
const TZ = 'America/Los_Angeles';
const MOBILE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: TZ };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: TZ };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Market time on the hero day, San Francisco (standard time, UTC-8). */
const sf = (hhmm) => Date.parse(`2026-11-12T${hhmm}:00-08:00`);

async function api(method, route, body) {
  const res = await fetch(`${API}${route}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status}`);
  return res.json();
}

/** True when the server answers in fake mode with the demo routes on. */
async function demoServer() {
  try {
    const health = await api('GET', '/api/health');
    if (health.mode !== 'fake') return false;
    await api('GET', '/api/demo/state');
    return true;
  } catch {
    return false;
  }
}

async function marketNow() {
  const c = await api('GET', '/api/clock');
  return c.paused ? c.marketNow : c.marketNow + (Date.now() - c.realNow) * c.speed;
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
  await page.waitForSelector('.veil.is-gone', { timeout: 60_000 });
  const height = await page.evaluate(() => document.querySelector('.maplibregl-canvas')?.clientHeight ?? 0);
  if (height < 200) throw new Error(`The map canvas is only ${height}px tall; the layout is broken.`);
  await page.waitForTimeout(3400); // let the task points pop in and settle
}

/** Scrolls the open sheet so that `selector` sits near its top (the sheet itself stays put). */
async function sheetTo(page, selector) {
  await page.evaluate((sel) => {
    const card = document.querySelector(sel);
    let el = card?.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
    if (card && el) el.scrollTop += card.getBoundingClientRect().top - el.getBoundingClientRect().top - 12;
  }, selector);
  await page.waitForTimeout(500);
}

/** Opens the overview's list and taps the row that mentions `text` (it flies down to that shop). */
async function openRow(page, text) {
  await page.locator('.map-button:not(.is-locate)').tap();
  await page.waitForTimeout(2600);
  await page.locator('.ov-listbtn').tap();
  await page.waitForTimeout(900);
  const row = page.locator('.ov-row', { hasText: text }).first();
  await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(300);
  await row.tap();
  await page.waitForTimeout(3600);
}

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await mkdir(OUT, { recursive: true });
const server = await demoServer();
if (server) await api('POST', '/api/demo/reset', { seed: null, scriptId: null });
else console.log('No demo server on', API, '- map shots use the in-browser market; hero shots skipped.');
const browser = await chromium.launch({ args, executablePath: process.env.CHROMIUM_PATH });

try {
  // 1 to 5. A phone: the 3D first screen, the overview with its dots, the list by $/hour,
  // greyed tasks in the list, and a greyed task's sheet (no Take button).
  {
    const { ctx, page } = await open(browser, MOBILE, '/');
    await mapReady(page);
    await shot(page, 'phone-01-first-screen-3d-390x844');
    await page.locator('.map-button:not(.is-locate)').click();
    await page.waitForTimeout(2800);
    await shot(page, 'phone-02-overview-dots-390x844');
    await page.locator('.ov-listbtn').click();
    await page.waitForTimeout(1000);
    await shot(page, 'phone-03-list-by-hourly-rate-390x844');
    const blocked = page.locator('.ov-row.is-blocked').first();
    await blocked.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    await shot(page, 'phone-04-greyed-tasks-in-list-390x844');
    await blocked.click();
    await page.waitForTimeout(3600);
    await shot(page, 'phone-05-greyed-task-sheet-390x844');
    await ctx.close();
  }

  // 6. A task a queuer can take: what it pays, what they keep after the 10% fee, and the check-in time.
  {
    const { ctx, page } = await open(browser, MOBILE, '/?demo=1');
    await mapReady(page);
    await openRow(page, 'Basque cheesecake');
    await shot(page, 'phone-06-take-a-task-390x844');
    await ctx.close();
  }

  // 7 and 8. A requester sets a max fee (the bid form's disclosures), then the Simulated PayPal sheet.
  {
    const { ctx, page } = await open(browser, MOBILE, '/?as=mia&demo=1');
    await mapReady(page);
    await page.locator('.tlabel', { hasText: 'Lucky Cat' }).first().click();
    await page.waitForTimeout(1600);
    await sheetTo(page, '.auction');
    await page.locator('.auction button', { hasText: 'Set my max fee' }).click();
    await page.waitForTimeout(600);
    await sheetTo(page, '.picker');
    await shot(page, 'phone-07-set-my-max-fee-390x844');
    if (server) {
      await page.locator('.picker .pp-button').click();
      await page.waitForSelector('.spp.is-open', { timeout: 15_000 });
      await page.waitForTimeout(600);
      await shot(page, 'phone-08-simulated-paypal-sheet-390x844');
      await page.locator('.spp .text-button', { hasText: 'Cancel' }).click();
      await page.waitForTimeout(800);
    }
    await ctx.close();
  }

  // The first screen on a desktop, inside the phone frame.
  {
    const { ctx, page } = await open(browser, DESKTOP, '/');
    await mapReady(page);
    await shot(page, 'desktop-01-first-screen-1440x900');
    await ctx.close();
  }

  // The characters page.
  {
    const { ctx, page } = await open(browser, DESKTOP, '/characters');
    await page.waitForTimeout(2600);
    await shot(page, 'desktop-02-characters-1440x900');
    await ctx.close();
  }

  if (server) {
    // 9. The hero at 60x. Wei and Rex walked over from home (queuer.moved) and stand in
    //    Paper Moon's line at 10:58; Wei's fee clock has run since his 10:50 check-in.
    await api('POST', '/api/demo/reset', { seed: null, scriptId: 'hero' });
    await api('POST', '/api/demo/start', { scriptId: 'hero', speed: 60 });
    {
      const { ctx, page } = await open(browser, MOBILE, '/?as=mia&demo=1');
      await mapReady(page);
      while ((await marketNow()) < sf('10:58')) await sleep(200);
      await api('POST', '/api/demo/pause');
      await page.waitForTimeout(1500);
      await shot(page, 'phone-09-queuers-walked-over-390x844');
      // 10. Paused at 11:02: Wei checked in at 10:50 and his fee has stepped down to $13 on its way to Mia's $12.
      await api('POST', '/api/demo/resume');
      while ((await marketNow()) < sf('11:02')) await sleep(250);
      await api('POST', '/api/demo/pause');
      await page.waitForTimeout(1200);
      await page.locator('.tlabel', { hasText: 'Mochi Bunny' }).first().click();
      await page.waitForTimeout(1600);
      await sheetTo(page, '.auction');
      await shot(page, 'phone-10-fee-step-down-card-390x844');
      await ctx.close();
    }

    // 11 and 12. The rest of the run: the money after the full fake cycle, both sides
    // (Mia: held, captured twice, released; Wei: paid out twice).
    let state = await api('POST', '/api/demo/resume');
    for (let i = 0; i < 600 && state.status !== 'finished'; i++) {
      await sleep(1000);
      state = await api('GET', '/api/demo/state');
    }
    {
      const { ctx, page } = await open(browser, MOBILE, '/?as=mia&demo=1');
      await mapReady(page);
      await page.locator('.money-chip').click();
      await page.waitForTimeout(1200);
      await shot(page, 'phone-11-money-after-full-fake-cycle-390x844');
      await page.evaluate(() => {
        const panel = document.querySelector('#money-panel');
        const list = panel?.querySelector('.money__list');
        if (panel && list) panel.scrollTop = list.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 8;
      });
      await page.waitForTimeout(500);
      await shot(page, 'phone-12-money-ledger-lines-390x844');
      await ctx.close();
    }
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
