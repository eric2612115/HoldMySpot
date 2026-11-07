// Takes the ops console screenshots with Playwright and a local Chromium.
//
//   npm run dev            (in another terminal; serves http://127.0.0.1:5197)
//   npm run shots          (writes PNGs to ../proto-shots/v2/final)
//
// Env: BASE_URL, OUT_DIR, CHROMIUM_PATH (optional). Uses the in-browser mock
// (?backend=mock) so the shots are the same on every run.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5197';
const OUT = path.resolve(process.env.OUT_DIR ?? path.join(here, '..', '..', 'proto-shots', 'v2', 'final'));
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: 'America/Los_Angeles' };
// Expected noise: AG Studio's licence banner (no key in the repo, and the AG Grid and AG Charts key
// does not cover AG Studio) and MapLibre style warnings.
const IGNORE = /\*{10}|License Key Not Found|Incompatible License|studio\/licensing|unlocked for trial|hide the watermark|AG Studio Pro with AI|Expected value to be of type/;

const problems = [];

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

async function boardReady(page) {
  await page.waitForSelector('.b-sch-event.hms-job', { timeout: 60_000 });
  await page.waitForSelector('.maplibregl-canvas', { timeout: 60_000 });
  await page.waitForTimeout(3500); // map tiles and the fit-to-selection animation
}

async function shot(page, name) {
  const file = path.join(OUT, `ops-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

try {
  // 1. The queuer board at 11:21: Rex's fake receipt moved $0, Jo will miss
  //    check-in, Noor's hold needs a new approval. Ghost bars show the proposals.
  {
    const { ctx, page } = await open(browser, '/?backend=mock&at=11:21');
    await boardReady(page);
    await shot(page, '01-queuer-board-1440x900');
    await ctx.close();
  }

  // 2. The market dashboard at 12:05 after asking the market desk agent
  //    "Which shop has the widest gap right now?".
  {
    const { ctx, page } = await open(browser, '/?backend=mock&at=12:05#/market');
    await page.waitForSelector('.hms-gapboard', { timeout: 90_000 });
    await page.waitForTimeout(2500);
    await page.locator('button:visible, [role=button]:visible').filter({ hasText: 'Widest gap' }).first().click();
    await page.waitForSelector('.hms-spot', { timeout: 60_000 });
    await page.waitForTimeout(2500);
    await shot(page, '02-market-dashboard-agent-1440x900');
    await ctx.close();
  }

  // 3. The board after an operator approved both moves (11:30).
  {
    const { ctx, page } = await open(browser, '/?backend=mock&at=11:30&approve=all');
    await boardReady(page);
    await shot(page, '03-queuer-board-approved-1440x900');
    await ctx.close();
  }
} finally {
  await browser.close();
}

if (problems.length) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exitCode = 1;
}
