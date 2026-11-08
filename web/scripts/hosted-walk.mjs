// Drives `npm run hosted` in Chromium at 1440 x 900: hold on Mia's phone and see it on Wei's, run the
// errand to the end with the hero's numbers, start over, confirm a second browser context is untouched,
// open the three ops pages, try a receipt that fails the checks. Screenshots go to .run/hosted/.
//
//   BASE_URL=http://127.0.0.1:9496 node web/scripts/hosted-walk.mjs      (from the repo root, server already running)

import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

// HOST_ALIAS shows the site under a name that is not localhost (Chromium maps the name; no hosts file),
// which is where a licence watermark would be drawn.
const baseUrl = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:8796');
const alias = process.env.HOST_ALIAS;
if (alias) baseUrl.hostname = alias;
const BASE = baseUrl.origin;
const OUT = path.resolve(process.env.OUT_DIR ?? '.run/hosted');
fs.mkdirSync(OUT, { recursive: true });
const errors = [];
const results = [];

function check(ok, what) {
  results.push(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', ...(alias ? [`--host-resolver-rules=MAP ${alias} 127.0.0.1`] : [])] });

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`${label}: ${m.text().slice(0, 300)}`);
  });
  page.on('pageerror', (e) => errors.push(`${label}: ${String(e).slice(0, 300)}`));
}

async function open(viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  watch(page, 'judge');
  await page.goto(BASE, { waitUntil: 'load' });
  return { ctx, page };
}

const phone = (page, id) => page.frameLocator(`#${id}`);
const mapReady = (page, id) => phone(page, id).locator('[aria-label^="Mochi Bunny plush:"]').first().waitFor({ state: 'attached', timeout: 90_000 });
const text = (page, id) => page.locator(`#${id}`).textContent();
const info = (page) => page.evaluate(() => fetch('/api/hosted/info').then((r) => r.json()));
const ledger = (page, who) =>
  page.evaluate(
    (w) => fetch('/api/ledger?mine=1', { headers: { 'x-hms-user': w } }).then((r) => r.json()).then((j) => j.entries.map((e) => `${e.kind} ${e.amount.cents} ${e.status}`)),
    who,
  );
const shot = (page, name) => page.screenshot({ path: path.join(OUT, name), timeout: 60_000 });
const wait = (page, fn, what, timeout = 180_000) => page.waitForFunction(fn, undefined, { timeout, polling: 500 }).catch((e) => check(false, `${what}: ${e.message.split('\n')[0]}`));

const a = await open();
await Promise.all([mapReady(a.page, 'mia'), mapReady(a.page, 'wei')]);
await a.page.waitForTimeout(1500);
await shot(a.page, '01-fresh.png');
check((await a.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)), 'the page fits 1440 without horizontal scroll');
check((await info(a.page)).market === 'alive', 'visiting the page built a market');

// Step 1: hold on Mia's phone, seen on Wei's.
const b = await open();
await mapReady(b.page, 'mia');
await a.page.click('#hold');
await wait(a.page, () => document.getElementById('held')?.textContent === '$63.70', 'hold shows $63.70');
check((await text(a.page, 'held')) === '$63.70', 'Mia holds $63.70');
await a.page.waitForTimeout(1500);
await shot(a.page, '02-hold.png');
const weiBook = await phone(a.page, 'wei').locator('body').textContent();
check(/Mochi Bunny/.test(weiBook ?? ''), "Wei's phone shows the plush request");
check((await info(b.page)).money.heldCents === 0, 'a second browser context is untouched by the hold');

// Step 2: the whole errand.
await a.page.click('#run');
await a.page.waitForTimeout(25_000);
await shot(a.page, '03-running.png');
await wait(a.page, () => document.querySelector('#run span')?.textContent === 'Done', 'the errand finishes', 240_000);
await a.page.waitForTimeout(3000);
await shot(a.page, '04-settled.png');
check(await phone(a.page, 'wei').locator('.sheet.is-open .q-errand').count() === 1, "Wei's errand is open on his phone");
const mia = await ledger(a.page, 'mia');
const wei = await ledger(a.page, 'wei');
for (const want of ['held 6370 succeeded', 'captured 4869 succeeded', 'captured 957 succeeded', 'released 544 succeeded']) check(mia.includes(want), `Mia's ledger: ${want}`);
for (const want of ['paid_out 1080 succeeded', 'paid_out 4275 succeeded']) check(wei.includes(want), `Wei's ledger: ${want}`);
check((await text(a.page, 'captured')) === '$58.26' && (await text(a.page, 'released')) === '$5.44' && (await text(a.page, 'paid')) === '$53.55', 'the page shows $58.26 charged, $5.44 released, $53.55 paid');

const second = await info(b.page);
check(second.money.capturedCents === 0 && second.demo.status === 'idle' && second.demo.stepIndex === 0, 'the second context is still at the start while the first finished');

// Start over: only this market.
await a.page.click('#reset');
await wait(a.page, () => document.getElementById('held')?.textContent === '$0.00', 'start over clears the money');
await Promise.all([mapReady(a.page, 'mia'), mapReady(a.page, 'wei')]);
check((await info(a.page)).money.heldCents === 0, 'start over returned to a fresh market');
check((await info(b.page)).money.heldCents === 0 && (await info(b.page)).demo.stepIndex === 0, 'the second context did not change');

// The admin side on the same market, through the same cookie.
const ops = await a.ctx.newPage();
watch(ops, 'ops');
for (const [hash, name, marker] of [
  ['#/board', '05-ops-board.png', '.b-sch-event, .b-grid-row'],
  ['#/market', '06-ops-market.png', '.ag-studio-root, .ag-root, [class*="ag-studio"]'],
  ['#/people', '07-ops-people.png', 'text=Needs a person'],
]) {
  await ops.goto(`${BASE}/ops/${hash}`, { waitUntil: 'load' });
  await ops.setViewportSize({ width: 1440, height: 900 });
  await ops.locator(marker).first().waitFor({ timeout: 60_000 }).catch((e) => check(false, `${hash}: ${e.message.split('\n')[0]}`));
  await ops.waitForTimeout(3000);
  await ops.screenshot({ path: path.join(OUT, name) });
  check(await ops.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${hash} fits 1440`);
  const watermarks = await ops.evaluate(() => [...document.querySelectorAll('[class*="watermark"]')].filter((e) => getComputedStyle(e).display !== 'none' && e.textContent.trim()).map((e) => e.textContent.trim().slice(0, 80)));
  check(watermarks.length === 0, `${hash} shows no licence watermark${watermarks.length ? `: ${watermarks.join(' | ')}` : ''}`);
  const mock = await ops.locator('text=/in-browser|replays the hero/i').count();
  check(mock === 0, `${hash} shows this visitor's server market, not the in-browser replay`);
}
await ops.close();

// Try to break it.
await a.page.click('#break');
// The errand opens from the pill on Wei's phone, as a queuer would tap it.
const pill = phone(a.page, 'wei').locator('.q-pill');
await pill.waitFor({ timeout: 30_000 }).catch(() => undefined);
if ((await pill.count()) && !(await phone(a.page, 'wei').locator('.sheet.is-open .q-errand').count())) await pill.click();
await phone(a.page, 'wei').locator('[data-photo="receipt"]').first().waitFor({ state: 'attached', timeout: 60_000 }).catch((e) => check(false, `proof card: ${e.message.split('\n')[0]}`));
await phone(a.page, 'wei').locator('.q-photo.has-photo').nth(1).waitFor({ timeout: 30_000 }).catch((e) => check(false, `sample photos: ${e.message.split('\n')[0]}`));
await a.page.waitForTimeout(800);
await shot(a.page, '08-break.png');
check(await phone(a.page, 'wei').locator('input[data-reading="receipt-fake_receipt"]').isChecked(), '"Fake receipt" is picked on Wei\'s phone');
const before = await ledger(a.page, 'mia');
await phone(a.page, 'wei').getByRole('button', { name: 'Send for checking' }).click();
await a.page.waitForTimeout(6000);
await shot(a.page, '09-failed-check.png');
const after = await ledger(a.page, 'mia');
check(before.join() === after.join(), 'the receipt that failed the checks moved $0');

// A narrow screen: one phone.
const n = await open({ width: 390, height: 844 });
await mapReady(n.page, 'mia');
await n.page.waitForTimeout(1200);
await shot(n.page, '10-narrow.png');
check(await n.page.locator('#wei').evaluate((e) => getComputedStyle(e).display === 'none' || getComputedStyle(e.parentElement).display === 'none'), 'a narrow screen shows one phone');
check(await n.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'the narrow page has no sideways scroll');

await browser.close();
const unique = [...new Set(errors)];
check(unique.length === 0, `no console errors${unique.length ? `: ${unique.slice(0, 10).join(' | ')}` : ''}`);
fs.writeFileSync(path.join(OUT, 'walk.txt'), results.join('\n') + '\n');
process.exit(results.some((r) => r.startsWith('FAIL')) ? 1 : 0);
