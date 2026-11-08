// Walks the queuer's half of the errand in the web app with Playwright, on a phone
// (390x844), and saves a screenshot at every step:
//   A. Wei takes Mia's plush request (shipped to New York), checks in with the
//      rendered line photo, buys, uploads the genuine receipt and item photo,
//      adds tracking and is paid; Mia's money panel shows the captures and the release.
//   B. Rex takes Priya's request and uploads the fake receipt: rejected, $0 moved,
//      Priya's request goes back to the book.
//   C. A local errand and a sell-out: Lin walks to Sugar Cloud Bakery for Sam's cake
//      and hands it over with the code on Sam's phone (one capture, one payout); then
//      Lin reports the ramen sold out: one report ends only his own job, and every
//      ramen request stays open and held until a second checked-in queuer reports too
//      (D-152). These photos are drawn by the script, not rendered fixtures, so fake mode reads them
//      with its simulated readings (stamped "fake rules-v1").
//
// Needs the server in fake mode with the demo routes (the hero market's pinned codes
// match the photos in server/fixtures/proofs), for example:
//   cd server && HMS_MODE=fake HMS_DEMO=1 HMS_DEMO_RESET=1 HMS_PORT=8797 HMS_AI_KEY_FILES= \
//     HMS_DB_PATH=/tmp/hms-walk.sqlite HMS_UPLOAD_DIR=/tmp/hms-walk-uploads node src/main.ts
// (no AI key: the AI services replay their saved readings of the rendered photos).
//   cd web && HMS_API_PROXY=http://127.0.0.1:8797 npx vite --port 5192
//   node scripts/queuer-walk.mjs
// Edits to web/src while it runs hot-swap modules under it: run it on a quiet tree, or
// against a dev server started with hot updates off.
// The script resets the demo market itself and runs the market clock at real speed,
// jumping it forward once to stand in for the wait in line (the genuine receipt is
// printed at 11:41 on the hero day).
// Env: BASE_URL, API_URL, OUT_DIR, GL=metal|swiftshader, CHROMIUM_PATH (optional).
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5192';
const API = process.env.API_URL ?? 'http://127.0.0.1:8797';
const OUT = path.resolve(process.env.OUT_DIR ?? path.join(here, '..', '..', 'proto-shots', 'v3', 'working'));
const FIX = path.resolve(here, '..', '..', 'server', 'fixtures', 'proofs');
const GL = process.env.GL ?? (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const args =
  GL === 'metal'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Los_Angeles' };
const sf = (hhmm) => Date.parse(`2026-11-12T${hhmm}:00-08:00`);
const problems = [];
const checks = [];

function expect(label, ok, detail = '') {
  checks.push({ label, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` (${detail})` : ''}`);
}

async function api(method, route, body, as) {
  const res = await fetch(`${API}${route}`, {
    method,
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(as ? { 'x-hms-user': as } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function shot(page, name) {
  const file = path.join(OUT, `queuer-${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

/** Scrolls the open sheet so `selector` sits near its top. */
async function sheetTo(page, selector, offset = 12) {
  await page.evaluate(
    ([sel, off]) => {
      const sheet = document.querySelector('.sheet.is-open .sheet__body');
      const el = sheet?.querySelector(sel);
      if (sheet && el) sheet.scrollTop += el.getBoundingClientRect().top - sheet.getBoundingClientRect().top - off;
    },
    [selector, offset],
  );
  await page.waitForTimeout(450);
}

async function openPhone(browser, url) {
  const ctx = await browser.newContext(PHONE);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => problems.push(`${url}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`${url}: ${m.text()}`);
  });
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector('.veil.is-gone', { timeout: 60_000 });
  await page.waitForSelector('.q-switch', { timeout: 20_000 });
  await page.waitForTimeout(3000); // the task points pop in
  return { ctx, page };
}

/** What the queuer's phone shows, for the log when a step fails. */
async function diagnose(page) {
  return page.evaluate(() => {
    const q = window.__queuer?.getState();
    return {
      stage: document.querySelector('.q-errand')?.getAttribute('data-stage') ?? null,
      sheetOpen: q?.sheetOpen,
      focusId: q?.focusId,
      busy: q?.busy,
      error: q?.error,
      claims: q ? Object.values(q.claims).map((c) => `${c.id}:${c.status}`) : null,
      jobs: q ? Object.values(q.jobs).map((j) => `${j.id}:${j.status}`) : null,
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
    };
  });
}

async function stage(page, name, timeout = 30_000) {
  try {
    // A reload (a dev-server update) brings the visit back folded into the pill: unfold it.
    const pill = page.locator('.q-pill');
    if (!(await page.locator('.sheet.is-open .q-errand').count()) && (await pill.count())) await pill.click();
    await page.waitForSelector(`.sheet.is-open .q-errand[data-stage="${name}"]`, { timeout });
  } catch (err) {
    console.log('waiting for', name, JSON.stringify(await diagnose(page)));
    throw err;
  }
  await page.waitForTimeout(400);
}

/** A photo drawn in the browser (not a rendered fixture): fake mode gives it a simulated reading. */
async function drawPhoto(browser, name, html) {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 800 } });
  const page = await ctx.newPage();
  await page.setContent(`<html><body style="margin:0;width:600px;height:800px;overflow:hidden;font-family:Helvetica,Arial,sans-serif">${html}</body></html>`);
  const buffer = await page.screenshot({ type: 'png' });
  await ctx.close();
  return { name, mimeType: 'image/png', buffer };
}

/** Takes the task at `label` on the queuer's phone and opens the errand; returns the check-in code. */
async function takeTask(page, label) {
  const tag = page.locator('.tlabel', { hasText: label }).first();
  if (await tag.isVisible()) await tag.click();
  else {
    // Out of view from here: pick it from the overview's list, which flies down to the shop.
    await page.locator('.map-button:not(.is-locate)').click();
    await page.waitForTimeout(2600);
    await page.locator('.ov-listbtn').click();
    await page.waitForTimeout(900);
    const row = page.locator('.ov-row', { hasText: label }).first();
    await row.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(300);
    await row.click();
    await page.waitForTimeout(3600);
  }
  await page.waitForSelector('.sheet.is-open .q-take', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  await page.locator('.q-take').click();
  await stage(page, 'arrival');
  return (await page.locator('.q-code__value').first().innerText()).trim();
}

/** Takes the plush task on the queuer's phone, checks in with `linePhoto`, and returns the claim's code. */
async function takeAndCheckIn(page, linePhoto, prefix) {
  await page.locator('.tlabel', { hasText: 'Mochi Bunny' }).first().click();
  await page.waitForSelector('.sheet.is-open .q-take', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  if (prefix === 'wei') {
    await shot(page, '03-task-card');
    await page.locator('.q-own').click();
    await page.waitForTimeout(500);
    await sheetTo(page, '.q-form');
    await shot(page, '04-offer-own-fee-step-down');
    await page.locator('.q-own').click();
    await page.waitForTimeout(300);
  }
  await page.locator('.q-take').click();
  await stage(page, 'arrival');
  await page.waitForTimeout(1600); // the avatar walks the dotted route to the back of the line
  await shot(page, prefix === 'wei' ? '05-arrival-window' : '14-rex-arrival-window');
  const code = await page.locator('.q-code__value').first().innerText();
  await page.locator('input[data-photo="line"]').setInputFiles(path.join(FIX, linePhoto));
  await page.waitForTimeout(500);
  await sheetTo(page, '.q-photo');
  if (prefix === 'wei') await shot(page, '06-line-photo-ready');
  await page.locator('.sheet.is-open .take-button', { hasText: 'Check in' }).click();
  await stage(page, 'in_line');
  await page.waitForSelector('.sheet.is-open .q-ai[data-check="passed"]', { timeout: 20_000 });
  await page.waitForTimeout(600);
  return code.trim();
}

await mkdir(OUT, { recursive: true });
const health = await api('GET', '/api/health');
if (health.mode !== 'fake') throw new Error('The server must run in fake mode.');
await api('POST', '/api/demo/reset', { seed: null, scriptId: 'hero' });
await api('POST', '/api/demo/clock', { speed: 1, paused: false });
const config = await api('GET', '/api/config');
console.log(`AI: ${config.ai.provider} ${config.ai.model}, mode ${config.ai.mode}`);

// Mia (New York) asks for the plush, shipped to her, with a $12 max fee: PayPal holds $63.70 (processing at cost included).
{
  const clock = await api('GET', '/api/clock');
  const destination = { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: '10012' };
  const quote = await api('POST', '/api/bids/quote', { shopId: 'paper-moon-toys', itemId: 'plush-paper-moon', qty: 1, destination }, 'mia');
  const created = await api(
    'POST',
    '/api/bids',
    {
      shopId: 'paper-moon-toys',
      itemId: 'plush-paper-moon',
      qty: 1,
      retailCapCents: quote.suggested.retailCapCents,
      maxFeeCents: 1200,
      shippingBudgetCents: quote.suggested.shippingBudgetCents,
      destination,
      deadlineAt: clock.marketNow + 2 * 86_400_000,
      funding: 'paypal',
      agent: null,
    },
    'mia',
  );
  await api('POST', `/api/fake/paypal/orders/${created.checkout.orderId}/approve`, { funding: 'paypal', outcome: 'approve' });
  const out = await api('POST', `/api/bids/${created.bid.id}/authorize`, { orderId: created.checkout.orderId }, 'mia');
  expect('Mia holds $63.70', out.hold.amount.cents === 6370, `${out.hold.amount.cents}`);
}

const browser = await chromium.launch({ args, executablePath: process.env.CHROMIUM_PATH });
try {
  // ---- A. Wei, the genuine receipt -------------------------------------------------
  {
    const { ctx, page } = await openPhone(browser, '/?demo=1&phone=requester');
    await shot(page, '01-requester-phone');
    await page.locator('.q-switch__side', { hasText: 'Wei' }).click();
    await page.waitForTimeout(800);
    await shot(page, '02-queuer-phone');

    const code = await takeAndCheckIn(page, 'checkin-paper-moon-wei/line.png', 'wei');
    expect("Wei's check-in code is the one in the line photo", code === 'M4RT7', code);
    await shot(page, '07-line-check-passed');
    await sheetTo(page, '.q-actions', 260);
    await shot(page, '08-in-line-bought-or-sold-out');

    // Standing in line until the shop sells the plush at 11:41.
    await api('POST', '/api/demo/clock', { jumpTo: sf('11:41') });
    await page.waitForTimeout(1200);
    await page.locator('.sheet.is-open .take-button', { hasText: 'Bought' }).click();
    await stage(page, 'proof');
    await page.locator('input[data-photo="receipt"]').setInputFiles(path.join(FIX, 'paper-moon-mia-genuine/receipt.png'));
    await page.locator('input[data-photo="item"]').setInputFiles(path.join(FIX, 'paper-moon-mia-genuine/item.png'));
    await page.waitForTimeout(700);
    await sheetTo(page, '.q-lead');
    await shot(page, '09-proof-upload');
    await api('POST', '/api/demo/clock', { jumpTo: sf('11:42') });
    await page.waitForTimeout(800);
    await page.locator('.sheet.is-open .take-button', { hasText: 'Send for checking' }).click();
    await stage(page, 'finish', 40_000);
    await page.waitForTimeout(1200);
    await sheetTo(page, '.q-ai');
    await shot(page, '10-receipt-check-passed');
    await sheetTo(page, '.q-ship');
    await page.locator('.q-ship input[name="tracking"]').fill('HPG-2611-1200-0042');
    await page.locator('.q-ship input[name="cost"]').fill('8.75');
    await page.waitForTimeout(300);
    await shot(page, '11-ship-tracking');
    await page.locator('.q-ship button[type="submit"]').click();
    await stage(page, 'paid', 30_000);
    await page.waitForSelector('.q-pay__big[data-paid="5355"]', { timeout: 20_000 });
    const paid = await page.locator('.q-pay__big').innerText();
    await page.waitForTimeout(1200);
    await shot(page, '12-payout');
    expect('The payout card says Paid $53.55 by PayPal Payouts', paid.includes('$53.55'), paid);

    // Mia's phone: the money panel follows the event stream.
    await page.locator('.q-switch__side', { hasText: 'Mia' }).click();
    await page.waitForTimeout(800);
    await page.locator('.money-chip').click();
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      const panel = document.querySelector('#money-panel');
      const list = panel?.querySelector('.money__list');
      if (panel && list) panel.scrollTop = list.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 8;
    });
    await page.waitForTimeout(500);
    await shot(page, '13-requester-money-panel');
    const lines = await page.locator('.money__list li').allInnerTexts();
    const has = (kind, amount) => lines.some((l) => l.includes(kind) && l.includes(amount));
    expect("Mia's panel: captured $48.69, captured $9.57, released $5.44", has('Captured', '$48.69') && has('Captured', '$9.57') && has('Released', '$5.44'), `${lines.length} lines`);
    expect("Mia's panel: Wei paid out $10.80 and $42.75", has('Paid out', '$10.80') && has('Paid out', '$42.75'));
    await ctx.close();

    const ledger = (await api('GET', '/api/ledger?mine=1', null, 'mia')).entries.map((e) => `${e.kind}:${e.amount.cents}:${e.status}`);
    expect('Server ledger for Mia: held 6370, captured 4869 and 957, released 544', ['held:6370:succeeded', 'captured:4869:succeeded', 'captured:957:succeeded', 'released:544:succeeded'].every((x) => ledger.includes(x)), ledger.join(' '));
    const payouts = (await api('GET', '/api/payouts?mine=1', null, 'wei')).payouts.map((p) => `${p.purpose}:${p.amount.cents}:${p.status}`);
    expect('Server payouts to Wei: fee 1080 and reimbursement 4275', payouts.includes('fee:1080:succeeded') && payouts.includes('reimbursement:4275:succeeded'), payouts.join(' '));
  }

  // ---- B. Rex, the fake receipt -----------------------------------------------------
  {
    const { ctx, page } = await openPhone(browser, '/?demo=1&phone=queuer');
    await page.locator('.q-switch__more').click();
    await page.waitForSelector('.q-people.is-open');
    await page.waitForTimeout(500);
    await shot(page, '13b-people-picker');
    await Promise.all([page.waitForURL(/queuer=rex/), page.locator('.q-people__row', { hasText: 'Rex' }).click()]);
    await page.waitForSelector('.veil.is-gone', { timeout: 60_000 });
    await page.waitForSelector('.q-switch', { timeout: 20_000 });
    await page.waitForTimeout(3000);

    const code = await takeAndCheckIn(page, 'checkin-paper-moon-rex/line.png', 'rex');
    expect("Rex's check-in code is the one in his line photo", code === 'F2KX9', code);
    await shot(page, '15-rex-line-check-passed');
    await page.locator('.sheet.is-open .take-button', { hasText: 'Bought' }).click();
    await stage(page, 'proof');
    await page.locator('input[data-photo="receipt"]').setInputFiles(path.join(FIX, 'paper-moon-rex-fake/receipt.png'));
    await page.locator('input[data-photo="item"]').setInputFiles(path.join(FIX, 'paper-moon-rex-fake/item.png'));
    await page.waitForTimeout(600);
    await sheetTo(page, '.q-lead');
    await shot(page, '16-rex-fake-receipt-upload');
    await page.locator('.sheet.is-open .take-button', { hasText: 'Send for checking' }).click();
    await stage(page, 'rejected', 40_000);
    await page.waitForTimeout(1200);
    await shot(page, '17-rex-rejected-zero-moved');
    await sheetTo(page, '.q-ai__flags', 140);
    await shot(page, '18-rex-rejected-flags');
    const outcome = await page.locator('.q-outcome').innerText();
    expect('The fake receipt is rejected with $0 moved', outcome.includes('$0 moved'), outcome.split('\n')[0]);
    await ctx.close();

    const rexJobs = (await api('GET', '/api/jobs?mine=1&role=queuer', null, 'rex')).jobs;
    const job = rexJobs[0];
    expect('Rex job failed: proof_rejected', job?.status === 'failed' && job.failure?.reason === 'proof_rejected', `${job?.status} ${job?.failure?.reason}`);
    expect('Rex job moved $0 (captured 0, paid out 0)', job?.amounts.capturedCents === 0 && job?.amounts.paidOutCents === 0);
    const detail = await api('GET', `/api/jobs/${job.id}`, null, 'ops');
    expect('No ledger line for the fake job', detail.ledger.length === 0, `${detail.ledger.length}`);
    const priya = (await api('GET', '/api/bids?mine=1', null, 'priya')).bids.find((b) => b.itemId === 'plush-paper-moon');
    expect("Priya's request is back in the book with her hold untouched", priya?.status === 'open' && priya?.remainingQty === 1, `${priya?.status} ${priya?.remainingQty}`);
    const rexPayouts = (await api('GET', '/api/payouts?mine=1', null, 'rex')).payouts;
    expect('No payout to Rex', rexPayouts.length === 0, `${rexPayouts.length}`);
  }

  // ---- C. A local errand with a handover code, then a sell-out ----------------------
  {
    // Sam (San Francisco) asks for a Sugar Cloud cake, a local errand, with a $13 max fee.
    const clock = await api('GET', '/api/clock');
    const destination = { mode: 'local', cityId: 'sf' };
    const quote = await api('POST', '/api/bids/quote', { shopId: 'sugar-cloud-bakery', itemId: 'cake-sugar-cloud', qty: 1, destination }, 'sam');
    const created = await api(
      'POST',
      '/api/bids',
      { shopId: 'sugar-cloud-bakery', itemId: 'cake-sugar-cloud', qty: 1, retailCapCents: quote.suggested.retailCapCents, maxFeeCents: 1300, shippingBudgetCents: 0, destination, deadlineAt: clock.marketNow + 86_400_000, funding: 'paypal', agent: null },
      'sam',
    );
    await api('POST', `/api/fake/paypal/orders/${created.checkout.orderId}/approve`, { funding: 'paypal', outcome: 'approve' });
    const held = await api('POST', `/api/bids/${created.bid.id}/authorize`, { orderId: created.checkout.orderId }, 'sam');
    expect('Sam holds $55.68 for the cake (processing at cost included)', held.hold.amount.cents === 5568, `${held.hold.amount.cents}`);

    const { ctx, page } = await openPhone(browser, '/?demo=1&as=sam&queuer=lin&phone=queuer');
    const code = await takeTask(page, 'Cloud cake');
    await page.waitForTimeout(800);
    const before = await page.locator('.q-clock__side').innerText();
    expect('Sugar Cloud is outside the 60 m check-in area from the start', before.includes('to go'), before.replace(/\n/g, ' '));
    await shot(page, '19-local-arrival-outside-geofence');
    const walk = page.locator('.q-walk');
    if (await walk.count()) await walk.click();
    await page.waitForSelector('.sheet.is-open .q-clock__side:has-text("At the shop")', { timeout: 30_000 });
    await page.waitForTimeout(600);
    await page.locator('input[data-photo="line"]').setInputFiles(
      await drawPhoto(browser, 'cake-line.png', `<div style="height:800px;background:linear-gradient(#cfe6ff,#fff 45%,#d9c7b0 46%)"><div style="position:absolute;top:120px;left:60px;width:480px;height:120px;background:#7fd6c2;border-radius:12px;font:bold 44px Helvetica;color:#fff;text-align:center;line-height:120px">SUGAR CLOUD</div>${Array.from({ length: 9 }, (_, i) => `<div style="position:absolute;top:${430 + (i % 2) * 18}px;left:${40 + i * 58}px;width:34px;height:150px;border-radius:17px;background:hsl(${i * 40},60%,55%)"></div>`).join('')}<div style="position:absolute;top:640px;left:150px;padding:14px 26px;background:#fff;border:4px solid #222;font:bold 64px Helvetica;letter-spacing:8px">${code}</div></div>`),
    );
    await page.locator('.sheet.is-open .take-button', { hasText: 'Check in' }).click();
    await stage(page, 'in_line');
    // About 40 minutes in the bakery's line.
    const inLine = await api('GET', '/api/clock');
    await api('POST', '/api/demo/clock', { jumpTo: inLine.marketNow + 38 * 60_000 });
    await page.waitForTimeout(1000);
    // The in-line card shows the job's proof code, to put next to the cake in the photo.
    const proofCode = (await page.locator('.sheet.is-open .q-code__value').first().innerText()).trim();
    await page.locator('.sheet.is-open .take-button', { hasText: 'Bought' }).click();
    await stage(page, 'proof');
    await page.locator('input[data-photo="receipt"]').setInputFiles(
      await drawPhoto(browser, 'cake-receipt.png', `<div style="height:800px;background:#3b2a1f;display:grid;place-items:center"><div style="width:300px;padding:28px;background:#fffef8;font:18px Courier;line-height:1.6">SUGAR CLOUD BAKERY<br>Buchanan St<br>--------------------<br>STRAWBERRY CLOUD CAKE<br>1 x 38.00 &nbsp; 38.00<br>--------------------<br>TOTAL &nbsp;&nbsp;&nbsp;&nbsp;&nbsp; 38.00<br>Card **** 4821</div></div>`),
    );
    await page.locator('input[data-photo="item"]').setInputFiles(
      await drawPhoto(browser, 'cake-item.png', `<div style="height:800px;background:#ffd8e4;display:grid;place-items:center"><div style="width:360px;height:260px;border-radius:40px 40px 20px 20px;background:#fff6ec;border:10px solid #ff9ebb"></div><div style="position:absolute;top:620px;left:330px;padding:10px 18px;background:#ffe14d;font:bold 40px Helvetica">${proofCode}</div></div>`),
    );
    await page.waitForTimeout(500);
    await page.locator('.sheet.is-open .take-button', { hasText: 'Send for checking' }).click();
    await stage(page, 'finish', 40_000);
    await page.waitForTimeout(800);
    await sheetTo(page, '.q-ship');
    await shot(page, '20-local-handover-asks-for-code');

    // Sam's phone shows the handover code once the receipt passed.
    await page.locator('.q-switch__side', { hasText: 'Sam' }).click();
    await page.waitForSelector('.q-handover [data-handover-code]', { timeout: 20_000 });
    await page.waitForTimeout(600);
    await shot(page, '21-requester-handover-code');
    const handoverCode = (await page.locator('[data-handover-code]').innerText()).trim();
    await page.locator('.q-switch__side', { hasText: 'Lin' }).click();
    await page.waitForTimeout(600);
    if (!(await page.locator('.sheet.is-open .q-errand').count())) await page.locator('.q-pill').click();
    await stage(page, 'finish');
    await page.locator('.q-ship input[name="handover"]').fill(handoverCode);
    await page.locator('.q-ship button[type="submit"]').click();
    await stage(page, 'paid', 30_000);
    await page.waitForSelector('.q-pay__big[data-paid="4970"]', { timeout: 20_000 });
    await page.waitForTimeout(1000);
    await shot(page, '22-local-paid-after-handover');
    expect('Local errand: Lin paid $49.70 in one payout after the handover', true);
    const samLedger = (await api('GET', '/api/ledger?mine=1', null, 'sam')).entries.map((e) => `${e.kind}:${e.amount.cents}:${e.status}`);
    expect('Server ledger for Sam: held 5568, one capture 5361, released 207', ['held:5568:succeeded', 'captured:5361:succeeded', 'released:207:succeeded'].every((x) => samLedger.includes(x)), samLedger.join(' '));
    await page.locator('.q-pay').locator('..').locator('.ghost-button', { hasText: 'Done' }).click();
    await page.waitForTimeout(800);

    // The ramen line: Lin takes a request, checks in, and the shop sells out.
    const ramenCode = await takeTask(page, 'Tonkotsu ramen');
    const walk2 = page.locator('.q-walk');
    if (await walk2.count()) await walk2.click();
    await page.waitForSelector('.sheet.is-open .q-clock__side:has-text("At the shop")', { timeout: 30_000 });
    await page.locator('input[data-photo="line"]').setInputFiles(
      await drawPhoto(browser, 'ramen-line.png', `<div style="height:800px;background:linear-gradient(#2b2a33,#4a3d52 50%,#c9a27a 51%)"><div style="position:absolute;top:90px;left:80px;width:440px;height:110px;background:#ffb454;border-radius:8px;font:bold 40px Helvetica;color:#2b2a33;text-align:center;line-height:110px">STEAM LANTERN</div>${Array.from({ length: 7 }, (_, i) => `<div style="position:absolute;top:${400 + i * 8}px;left:${60 + i * 70}px;width:40px;height:170px;border-radius:20px;background:hsl(${200 + i * 20},50%,60%)"></div>`).join('')}<div style="position:absolute;top:660px;left:120px;padding:12px 24px;background:#fff;font:bold 60px Helvetica;letter-spacing:8px">${ramenCode}</div></div>`),
    );
    await page.locator('.sheet.is-open .take-button', { hasText: 'Check in' }).click();
    await stage(page, 'in_line');
    await page.locator('.sheet.is-open .ghost-button', { hasText: 'Sold out' }).click();
    await page.waitForSelector('.q-soldout');
    await page.locator('input[data-photo="sold-out"]').setInputFiles(
      await drawPhoto(browser, 'sold-out.png', `<div style="height:800px;background:#c7334f;display:grid;place-items:center"><div style="padding:40px;border:10px solid #fff;color:#fff;font:bold 72px Helvetica;text-align:center">SOLD OUT<br><span style="font-size:36px">see you tomorrow</span></div></div>`),
    );
    await page.waitForTimeout(500);
    await sheetTo(page, '.q-soldout');
    await shot(page, '23-sold-out-confirm');
    await page.locator('.sheet.is-open .take-button', { hasText: 'Report sold out' }).click();
    await stage(page, 'sold_out', 30_000);
    await page.waitForTimeout(1500);
    await shot(page, '24-sold-out-own-job-ended');
    await ctx.close();

    const records = await api('GET', '/api/ops/records', null, 'ops');
    const ramenBids = records.bids.filter((b) => b.itemId === 'ramen-steam-lantern');
    const ramenHolds = records.holds.filter((h) => ramenBids.some((b) => b.holdId === h.id));
    // One queuer's report ends only his own job (D-152): the book stays open, and the request goes back on it, still held.
    const ramenFailed = records.jobs.filter((j) => j.itemId === 'ramen-steam-lantern' && j.failure?.reason === 'sold_out');
    expect("Sold out, one report: only Lin's own job ended", ramenFailed.length === 1 && ramenFailed[0].status === 'failed', ramenFailed.map((j) => `${j.queuerId}/${j.status}`).join(' '));
    expect('Sold out, one report: every ramen request stays open', ramenBids.length > 0 && ramenBids.every((b) => b.status === 'open' && b.closeReason === null), ramenBids.map((b) => `${b.status}/${b.closeReason}`).join(' '));
    expect('Sold out, one report: every ramen hold still held, nothing captured', ramenHolds.length === ramenBids.length && ramenHolds.every((h) => h.status === 'held' && h.capturedCents === 0), ramenHolds.map((h) => h.status).join(' '));
  }
} finally {
  await browser.close();
}

const failed = checks.filter((c) => !c.ok);
if (problems.length) {
  console.log('\nPage errors:');
  for (const p of problems) console.log(' -', p);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length || problems.length) process.exitCode = 1;
