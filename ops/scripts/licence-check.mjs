// Reports what the AG licence keys do in the running ops console. It never prints a key.
//
//   npm run dev              (in another terminal; keys as in docs/TECHNICAL-DETAILS.md "Keys", or none)
//   npm run licence:check    (add -- --strict to exit 1 unless no AG licence banner or watermark shows)
//
// It opens the market dashboard on the in-browser mock, scrolls AG Studio so every widget draws
// (three grids and three charts) and asks the market desk agent one question in Studio's AI panel (the replay's offline planner, no model). Then it
// prints which key each AG product was given and what AG Studio's and AG Grid's own licence managers
// make of it (from the dev build's hmsLicenseReport()), and every AG licence banner in the console.
// Banners show on every host; the watermark that goes with them is drawn only on hosts other than
// localhost and 127.0.0.1. To see it, start the dev server with OPS_ALLOWED_HOSTS=ops.holdmyspot.test
// and run this with HOST_ALIAS=ops.holdmyspot.test (Chromium maps the name to 127.0.0.1; no hosts file).
// Env: BASE_URL (default http://127.0.0.1:5197), HOST_ALIAS, CHROMIUM_PATH.
import { chromium } from 'playwright-core';

const base = new URL(process.env.BASE_URL ?? 'http://127.0.0.1:5197');
const alias = process.env.HOST_ALIAS;
if (alias) base.hostname = alias;
const strict = process.argv.includes('--strict');
// Anything shaped like an AG key is hidden before it could be printed.
const hide = (s) => String(s).replace(/[^\s"'`]*(\[TRIAL\]|_\[v\d\]_)[^\s"'`]*/g, '<key hidden>');

const banners = [];
const errors = [];
let report;
let drawn;
let watermarks = [];
let agentAnswered = false;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  args: alias ? [`--host-resolver-rules=MAP ${alias} 127.0.0.1`] : [],
});
try {
  // UTC, so the expiry dates AG prints are the dates on the keys.
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'UTC' });
  await ctx.addInitScript(() => {
    window.__hmsWatermarks = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.ag-studio-watermark, .ag-watermark')) {
        const text = (el.textContent || '').trim();
        const product = el.classList.contains('ag-studio-watermark') ? 'AG Studio' : el.querySelector('.ag-watermark-text') ? 'AG Grid' : 'AG Charts';
        const seen = window.__hmsWatermarks.some((w) => w.product === product && w.text === text);
        if (text && !seen && getComputedStyle(el).display !== 'none') window.__hmsWatermarks.push({ product, text });
      }
    }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
  });
  const page = await ctx.newPage();
  // AG prints each banner line on its own: a title ("*** AG Grid Enterprise License ***"), the verdict
  // ("*** License Key Not Found ***") and detail lines ("* All ... unlocked for trial. *").
  let open;
  page.on('console', (m) => {
    const t = m.text().trim();
    if (/^\*.*\*$/.test(t)) {
      const title = /^\*+ (AG .+?) License \*+$/.exec(t);
      const verdict = /^\*{3,} (.+?) \*{3,}$/.exec(t);
      const detail = /^\* (.+?)\s*\*$/.exec(t);
      if (title) open = { product: title[1] };
      else if (open && !open.verdict && verdict) open.verdict = verdict[1].replace(/\.$/, '');
      else if (open?.verdict && detail) {
        const line = `${open.product}: ${open.verdict} (${hide(detail[1])})`;
        if (!banners.includes(line)) banners.push(line);
        open = undefined;
      }
      return;
    }
    if (m.type() === 'error' && !/Expected value to be of type/.test(t)) errors.push(hide(t).slice(0, 200));
  });
  page.on('pageerror', (e) => errors.push(hide(e.message).slice(0, 200)));

  await page.goto(new URL('/?backend=mock&at=12:05#/market', base).href);
  await page.waitForSelector('.hms-gapboard', { timeout: 120_000 });
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('.market-studio *')) {
        if (el.scrollHeight > el.clientHeight + 20 && getComputedStyle(el).overflowY !== 'visible') el.scrollTop = el.scrollHeight;
      }
    });
    await page.waitForTimeout(700);
  }
  await page.locator('button:visible, [role=button]:visible').filter({ hasText: 'Widest gap' }).first().click();
  agentAnswered = await page
    .waitForSelector('.hms-spot', { timeout: 60_000 })
    .then(() => true)
    .catch(() => false);
  await page.waitForTimeout(2000);
  drawn = await page.evaluate(() => ({
    grids: document.querySelectorAll('.market-studio .ag-root-wrapper').length,
    charts: document.querySelectorAll('.market-studio .ag-charts-wrapper').length,
  }));
  report = await page.evaluate(() => window.hmsLicenseReport?.());
  watermarks = await page.evaluate(() => window.__hmsWatermarks);
} finally {
  await browser.close();
}

/** One line for what a product's licence manager says about a key. */
function verdict(d) {
  if (!d || d.error) return d?.error ? `error: ${d.error}` : 'n/a';
  const type = d.suppliedLicenseType ? `${d.suppliedLicenseType} key` : 'key of an unknown type for this product';
  if (!d.valid) return `not accepted (${d.incorrectLicenseType ? 'incompatible' : 'invalid'}: ${type})`;
  if (d.trialExpired) return `trial expired on ${d.expiry}`;
  return `accepted (${type}${d.isTrial ? ', trial' : ''}, until ${d.expiry})`;
}

console.log(`AG licence check at ${base.origin} (keys are never shown)`);
if (report) {
  console.log(`  Given: AG Studio <- ${report.given.agStudio}; AG Grid and AG Charts <- ${report.given.agGridAndCharts}`);
  for (const [name, k] of [['AG Studio key', report.studioKey], ['AG Grid and AG Charts key', report.gridKey]]) {
    if (!k.loaded) continue;
    // An AG Studio key is not an AG Grid key; this console needs none (AG Studio draws every grid and chart).
    const grid = k.grid?.valid ? `AG Grid ${verdict(k.grid)}` : 'AG Grid: not needed (every grid and chart here is drawn by AG Studio)';
    console.log(`  ${name}: AG Studio (Pro with AI, which this console needs) ${verdict(k.studio['PRO-AI'])}; ${grid}`);
  }
} else {
  console.log('  No hmsLicenseReport() (not a dev server): only the console banners are checked.');
}
console.log(`  Drawn by AG Studio: ${drawn.grids} grid(s), ${drawn.charts} chart(s); market desk agent ${agentAnswered ? 'answered' : 'did not answer'}`);
console.log(`  Licence banners in the console:${banners.length ? '' : ' none'}`);
for (const b of banners) console.log(`    ${b}`);
console.log(`  Watermarks: ${watermarks.length ? watermarks.map((w) => `${w.product} "${w.text}"`).join(', ') : alias ? 'none' : 'none (AG never draws one on localhost; set HOST_ALIAS to see what a deployed host shows)'}`);
if (errors.length) console.log(`  Other console errors:\n    ${errors.join('\n    ')}`);

const licensed = banners.length === 0 && watermarks.length === 0;
console.log(
  licensed
    ? 'Verdict: licensed. No AG licence banner or watermark.'
    : 'Verdict: AG trial mode, every feature works; an AG Studio Pro with AI key removes the trial notices.',
);
if ((strict && !licensed) || !agentAnswered) process.exitCode = 1;
