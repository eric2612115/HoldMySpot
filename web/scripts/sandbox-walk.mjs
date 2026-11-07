// The hero errand on the REAL PayPal sandbox, through the web app on two phones (390x844 at 2x), with
// a live AI model, saved as one consistent set of screenshots and videos (D-121, D-122):
//
//   Mia sets a $12 max fee for the Mochi Bunny plush and approves the $63.70 hold in PayPal's own window;
//   Wei posts an offer at $15, down $1 every 5 minutes to $8, walks over and checks in with his line photo;
//   the market clock is moved with the order book's own Next step until his fee meets Mia's $12; Wei buys,
//   uploads the genuine receipt and item photos (server/fixtures/proofs), the AI check passes, PayPal
//   captures and pays Wei his fee; he adds tracking, the final capture releases the rest and the second
//   payout lands. Then three ops console screenshots at 1440x900 from the same server.
//
// Needs, on this machine (nothing secret is in the repo or printed):
//   - a HoldMySpot server in sandbox mode with the demo routes, a live AI model and a fresh market, e.g.
//       cd server && HMS_MODE=sandbox HMS_DEMO=1 HMS_AI_MODE=live HMS_AI_KEY_FILES=<file>#MODEL_API_KEY node src/main.ts
//   - the web app built and served without hot updates, /api proxied to that server:
//       cd web && npx vite build --outDir <dir> && HMS_API_PROXY=http://127.0.0.1:<server port> npx vite preview --outDir <dir>
//     and, for the ops screenshots, the ops console the same way (OPS_URL);
//   - APPROVER=<label>: a sandbox personal account in sandbox-buyers.json that is not the payout receiver. Its
//     email and password are read at run time (scripts/lib/sandbox-buyer.mjs) and typed only on
//     www.sandbox.paypal.com; screenshots and videos blur every email address. Any CAPTCHA, security check or
//     code on PayPal's pages stops the run with a screenshot; nothing answers it.
//
// The script resets the server's demo market (POST /api/demo/reset), moves its clock with POST /api/demo/clock
// and the book's buttons, and never starts the scripted day. The videos are the pages' own frames
// (Chrome's screencast, each frame with its time) around three moments, joined and encoded by ffmpeg;
// the frames stay in RAW_DIR, the clips and the PNGs go to OUT_DIR.
// Env: BASE_URL, API_URL, OPS_URL, OUT_DIR, RAW_DIR, APPROVER, HMS_SECRETS_DIR, GL=metal|swiftshader,
//      CHROMIUM_PATH, FFMPEG.
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { challengeReason, loadSandboxAccount } from '../../scripts/lib/sandbox-buyer.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:5190';
const API = process.env.API_URL ?? 'http://127.0.0.1:8796';
const OPS = process.env.OPS_URL ?? null;
const OUT = path.resolve(process.env.OUT_DIR ?? path.join(here, '..', '..', 'proto-shots', 'v3', 'working', 'sandbox-walk'));
const RAW = path.resolve(process.env.RAW_DIR ?? path.join(os.tmpdir(), `hms-sandbox-walk-${process.pid}`));
const FIX = path.resolve(here, '..', '..', 'server', 'fixtures', 'proofs');
const SECRETS = process.env.HMS_SECRETS_DIR || path.join(os.homedir(), '.config', 'paypal-hackathon');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const GL = process.env.GL ?? (process.platform === 'darwin' ? 'metal' : 'swiftshader');
const args = GL === 'metal' ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const TZ = 'America/Los_Angeles';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: TZ, locale: 'en-US' };
const DESKTOP = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, timezoneId: TZ, locale: 'en-US' };
const ITEM = 'plush-paper-moon';
const DESK_QUESTION = 'How much did PayPal capture and pay out today, and what did HoldMySpot keep?';
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Market time on the hero day, San Francisco (standard time, UTC-8). */
const sf = (hhmm) => Date.parse(`2026-11-12T${hhmm}:00-08:00`);
const usd = (cents) => `$${(cents / 100).toFixed(2)}`;
const problems = [];
const checks = [];

class Blocked extends Error {}

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
  if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

const clockTo = (hhmm) => api('POST', '/api/demo/clock', { jumpTo: sf(hhmm), paused: true });

// ---- pages, screenshots and the clips' frames -----------------------------------------------

/** Wall-clock moments (seconds) for the cuts; the screencast frames carry the same clock. */
const marks = {};
const mark = (name) => void (marks[name] = Date.now() / 1000);

/**
 * PayPal's pages only, for the screenshots and the clips: the sign-in field shows dots, any text with an
 * email address is blurred, and the language list's non-English entries are hidden (the repo is English
 * only). Inline styles set from script, which PayPal's style-src policy allows. It changes nothing PayPal
 * receives.
 */
function maskPayPalPage() {
  if (!/(^|\.)paypal\.com$/.test(location.hostname)) return;
  const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;
  const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef\uac00-\ud7af]/;
  const blur = (el) => el && el.style && el.style.setProperty('filter', 'blur(8px)', 'important');
  const hide = (el) => el && el.style && el.style.setProperty('visibility', 'hidden', 'important');
  const field = (el) => {
    if (el.matches?.('input#email, input[type=email], input[name=login_email]')) el.style.setProperty('-webkit-text-security', 'disc', 'important');
  };
  const text = (n) => {
    const v = n.nodeValue || '';
    if (EMAIL_RE.test(v)) blur(n.parentElement);
    if (CJK.test(v)) hide(n.parentElement);
  };
  const scan = (root) => {
    if (!root) return;
    if (root.nodeType === 3) return text(root);
    if (root.nodeType !== 1) return;
    field(root);
    for (const el of root.querySelectorAll('input')) field(el);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) text(n);
  };
  const start = () => {
    scan(document.documentElement);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') text(m.target);
        for (const n of m.addedNodes) scan(n);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
}

/**
 * Records a page's own frames (Chrome's screencast, at the phone's 390x844 CSS size) with their times,
 * until stop() or until the page closes. Frames arrive only when the screen changes.
 */
async function screencast(page, name) {
  const dir = path.join(RAW, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on('Page.screencastFrame', (f) => {
    const file = path.join(dir, `${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata?.timestamp ?? Date.now() / 1000 });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => undefined);
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 85, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  return {
    frames,
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => undefined);
      await cdp.detach().catch(() => undefined);
      return frames;
    },
  };
}

async function phone(browser, url, name) {
  const ctx = await browser.newContext(PHONE);
  await ctx.addInitScript(maskPayPalPage);
  const page = await ctx.newPage();
  watch(page, name);
  await page.goto(`${BASE}${url}`);
  await page.waitForSelector('.veil.is-gone', { state: 'attached', timeout: 90_000 });
  await page.waitForSelector('.tlabel', { timeout: 30_000 });
  await page.waitForTimeout(3500); // the task points pop in
  return { ctx, page };
}

function watch(page, name) {
  page.on('pageerror', (e) => problems.push(`${name}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/permissions policy|Permissions-Policy/i.test(m.text())) problems.push(`${name}: ${m.text().slice(0, 240)}`);
  });
}

/** PayPal's pages: mask the email field and any text with an address (the init script blurs them too). */
const masks = (page) => (/paypal\.com$/.test(hostOf(page.url())) ? [page.getByText(EMAIL), page.locator('input[type=email], input#email, input[name=login_email]')] : []);
const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
};

/** A screenshot into OUT_DIR (or RAW_DIR with `raw`), by default once the app's toasts are gone: one focus per picture. */
async function shot(page, name, { toasts = false, raw = false } = {}) {
  const file = path.join(raw ? RAW : OUT, `${name}.png`);
  if (!toasts) await page.waitForFunction(() => document.querySelectorAll('.toast').length === 0, null, { timeout: 7_000 }).catch(() => undefined);
  // No focus or hover ring from the last click in the picture.
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur()).catch(() => undefined);
  await page.mouse.move(Math.round((page.viewportSize()?.width ?? 390) / 2), 2).catch(() => undefined);
  await page.screenshot({ path: file, mask: masks(page), maskColor: '#E9E4EC' });
  console.log('saved', file);
}

/** Scrolls the open sheet so `selector` sits `offset` px below its top. */
async function sheetTo(page, selector, offset = 12) {
  await page.evaluate(
    ([sel, off]) => {
      const body = document.querySelector('.sheet.is-open .sheet__body');
      const el = body?.querySelector(sel);
      if (body && el) body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top - off;
    },
    [selector, offset],
  );
  await page.waitForTimeout(500);
}

/** The queuer's errand sheet at `name` (unfolds the pill if the sheet was folded). */
async function stage(page, name, timeout = 30_000) {
  const pill = page.locator('.q-pill');
  if (!(await page.locator('.sheet.is-open .q-errand').count()) && (await pill.count())) await pill.click();
  try {
    await page.waitForSelector(`.sheet.is-open .q-errand[data-stage="${name}"]`, { timeout });
  } catch (err) {
    const now = await page.evaluate(() => document.querySelector('.q-errand')?.getAttribute('data-stage') ?? 'none');
    const error = await page.evaluate(() => document.querySelector('.q-error')?.textContent ?? '');
    throw new Error(`Waited ${timeout / 1000} s for the errand stage "${name}"; it is "${now}". ${error}`.trim(), { cause: err });
  }
  await page.waitForTimeout(400);
}

// ---- PayPal's window ---------------------------------------------------------------------

async function visible(page, selector) {
  try {
    return await page.locator(selector).first().isVisible({ timeout: 200 });
  } catch {
    return false;
  }
}

/** PayPal's split sign-in form, read from the DOM (its hidden fields still count as visible to Playwright). */
async function signInForm(page) {
  try {
    return await page.evaluate(() => {
      const shown = (el) => {
        if (!el || el.closest('.hide') || el.getClientRects().length === 0) return false;
        const s = getComputedStyle(el);
        return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
      };
      const email = document.querySelector('#email');
      return { email: shown(email), emailFilled: Boolean(email && email.value), password: shown(document.querySelector('#password')), next: shown(document.querySelector('#btnNext')) };
    });
  } catch {
    return { email: false, emailFilled: false, password: false, next: false };
  }
}

/** Types a secret on www.sandbox.paypal.com only, without letting an error message echo it. */
async function typeSecret(page, selector, value, what) {
  if (hostOf(page.url()) !== 'www.sandbox.paypal.com') throw new Error(`Refusing to type the ${what} outside www.sandbox.paypal.com.`);
  try {
    const field = page.locator(selector).first();
    await field.click({ timeout: 5_000 });
    await field.fill('', { timeout: 5_000 });
    await field.pressSequentially(value, { delay: 30, timeout: 30_000 });
  } catch {
    throw new Error(`Could not type the ${what} in PayPal's window.`);
  }
}

async function blockedShot(page, name) {
  const file = path.join(RAW, `blocked-${name}-${Date.now()}.png`);
  try {
    await page.screenshot({ path: file, mask: masks(page) });
    return file;
  } catch {
    return null;
  }
}

/** Stops at once when PayPal wants a person: a challenge page or text, or a visible CAPTCHA frame. */
async function guard(page) {
  let text = '';
  try {
    text = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 4000) : ''));
  } catch {
    text = '';
  }
  let reason = challengeReason({ url: page.url(), text });
  if (!reason) {
    for (const f of page.frames()) {
      if (!/recaptcha\/.*bframe|hcaptcha|arkoselabs|funcaptcha|captcha-delivery|px-captcha/i.test(f.url())) continue;
      try {
        const el = await f.frameElement();
        const box = await el.boundingBox();
        if (box && box.width > 80 && box.height > 80 && (await el.isVisible())) reason = `visible CAPTCHA frame ${hostOf(f.url())}`;
      } catch {
        // A detached frame is not a challenge.
      }
    }
  }
  if (reason) {
    const file = await blockedShot(page, 'challenge');
    throw new Blocked(`PayPal showed a challenge (${reason}); stopped without answering it.${file ? ` Screenshot: ${file}` : ''}`);
  }
}

const SUBMIT = '#payment-submit-btn, button[data-testid="submit-button-initial"], button:has-text("Continue to Review Order"), button:has-text("Agree & Continue"), button:has-text("Complete Purchase")';

/** Signs in when asked and presses PayPal's own approve button, until PayPal closes its window. */
async function approveInWindow(popup, account, { onSignIn, onReview, timeoutMs = 180_000 } = {}) {
  const started = Date.now();
  const state = { email: false, password: false, login: false, signInShown: false, submits: 0 };
  while (!popup.isClosed()) {
    if (Date.now() - started > timeoutMs) {
      const file = await blockedShot(popup, 'timeout');
      throw new Error(`No approval in PayPal's window after ${timeoutMs / 1000} s.${file ? ` Screenshot: ${file}` : ''}`);
    }
    let url = '';
    try {
      url = popup.url();
    } catch {
      break;
    }
    if (hostOf(url) !== 'www.sandbox.paypal.com') {
      await sleep(500);
      continue;
    }
    try {
      await guard(popup);
    } catch (err) {
      if (popup.isClosed()) break;
      throw err;
    }
    for (const sel of ['#bannerDeclineButton', 'button#declineAllButton', '#bannerCloseButton']) {
      if (await visible(popup, sel)) await popup.locator(sel).first().click({ timeout: 3_000 }).catch(() => undefined);
    }
    const form = await signInForm(popup);
    if ((form.email || form.password) && !state.signInShown) {
      state.signInShown = true;
      await sleep(900);
      if (onSignIn) await onSignIn(popup);
    }
    if (form.email && !form.password && !state.email) {
      await typeSecret(popup, '#email', account.email, 'email');
      state.email = true;
      if (form.next) await popup.locator('#btnNext').first().click({ timeout: 10_000 });
      console.log(`  PayPal window: typed the ${account.label} email`);
      await sleep(2_000);
      continue;
    }
    if (form.password && !state.password) {
      if (form.email && !form.emailFilled) await typeSecret(popup, '#email', account.email, 'email');
      await typeSecret(popup, '#password', account.password, 'password');
      state.password = true;
      await popup.locator('#btnLogin').first().click({ timeout: 10_000 });
      console.log(`  PayPal window: signed in as ${account.label}`);
      await sleep(3_000);
      continue;
    }
    if (!state.login && !form.email && !form.password && (await visible(popup, 'button:has-text("Log In"), a:has-text("Log In")'))) {
      state.login = true;
      await popup.locator('button:has-text("Log In"), a:has-text("Log In")').first().click({ timeout: 10_000 });
      await sleep(1_500);
      continue;
    }
    const submit = popup.locator(SUBMIT).first();
    let ready = false;
    try {
      ready = (await submit.isVisible({ timeout: 300 })) && (await submit.isEnabled({ timeout: 300 }));
    } catch {
      ready = false;
    }
    if (ready && state.submits < 4) {
      if (state.submits === 0 && onReview) await onReview(popup);
      state.submits += 1;
      await submit.click({ timeout: 10_000 }).catch(() => undefined);
      console.log(`  PayPal window: pressed PayPal's approve button (${state.submits})`);
      // PayPal keeps the button on screen under its "Thanks" overlay while it finishes; press again only if it is still there later.
      await sleep(8_000);
      continue;
    }
    await sleep(700);
  }
  return { ms: Date.now() - started, submits: state.submits };
}

// ---- the clips -----------------------------------------------------------------------------

/**
 * One clip from screencast segments [{ frames, from, to }] (wall-clock seconds): each segment opens on the
 * frame on screen at `from` and holds every frame for as long as it was on screen, up to `to`. Encoded as
 * a 390x844 VP9 webm at 30 fps.
 */
function clip(out, segments) {
  const lines = ['ffconcat version 1.0'];
  let last = null;
  let seconds = 0;
  for (const seg of segments) {
    const before = seg.frames.filter((f) => f.t <= seg.from).at(-1);
    const list = [...(before ? [{ ...before, t: seg.from }] : []), ...seg.frames.filter((f) => f.t > seg.from && f.t < seg.to)];
    for (let i = 0; i < list.length; i++) {
      const end = i + 1 < list.length ? list[i + 1].t : seg.to;
      const d = Math.max(0.02, end - list[i].t);
      seconds += d;
      lines.push(`file '${list[i].file}'`, `duration ${d.toFixed(3)}`);
      last = list[i].file;
    }
  }
  if (!last) throw new Error(`${out}: no frames`);
  lines.push(`file '${last}'`);
  const listFile = path.join(RAW, `${out}.ffconcat`);
  writeFileSync(listFile, `${lines.join('\n')}\n`);
  execFileSync(FFMPEG, [
    '-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', 'fps=30,scale=390:844:force_original_aspect_ratio=decrease,pad=390:844:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p',
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', path.join(OUT, out),
  ]);
  console.log(`saved ${path.join(OUT, out)} (${seconds.toFixed(1)} s)`);
}

// ---- the run -------------------------------------------------------------------------------

const approverLabel = process.env.APPROVER;
if (!approverLabel) {
  console.error('Set APPROVER to the label of a sandbox personal account in sandbox-buyers.json (not the payout receiver).');
  process.exit(2);
}
const account = loadSandboxAccount(SECRETS, approverLabel);
const health = await api('GET', '/api/health');
if (health.mode !== 'sandbox') throw new Error(`The server runs in ${health.mode} mode; this walk is for the PayPal sandbox.`);
const config = await api('GET', '/api/config');
console.log(`Server: ${config.mode}, AI ${config.ai.provider}/${config.ai.model} ${config.ai.mode}; approver ${account.label}`);
if (config.ai.mode !== 'live') console.log('Note: the AI checks are not live on this server.');
mkdirSync(OUT, { recursive: true });
mkdirSync(RAW, { recursive: true });
await api('POST', '/api/demo/reset', { seed: null, scriptId: 'hero' });
await clockTo('10:31');

const browser = await chromium.launch({ args, executablePath: process.env.CHROMIUM_PATH });
const ids = {};
/** The clips to encode once the browser is closed. */
const clips = [];
let mia;
let wei;
let popup = null;
try {
  // ---- Mia: a $12 max fee, approved in PayPal's window ----------------------------------------
  mia = await phone(browser, '/?backend=server&demo=1&phone=requester', 'mia');
  const m = mia.page;
  await shot(m, '01-map');
  const quoted = m.waitForResponse((r) => r.url().includes('/api/bids/quote'), { timeout: 90_000 }).catch(() => null);
  await m.locator('.tlabel__ticket', { hasText: 'Mochi Bunny' }).first().click();
  await m.waitForSelector('.sheet.is-open .auction', { timeout: 20_000 });
  await quoted;
  await m.waitForTimeout(1200);
  await sheetTo(m, '.auction');
  await m.locator('.sheet.is-open .auction button', { hasText: 'Set my max fee' }).click();
  await m.waitForSelector('.picker paypal-button', { timeout: 60_000 });
  for (let i = 0; i < 10; i++) {
    const v = (await m.locator('.picker__big').innerText()).trim();
    if (v === '$12') break;
    await m.locator(`.picker [aria-label="${Number(v.replace(/[^0-9.]/g, '')) > 12 ? 'Lower' : 'Raise'} my max fee"]`).click();
    await m.waitForTimeout(200);
  }
  await m.waitForTimeout(1500);
  await sheetTo(m, '.picker', 90);
  const lead = (await m.locator('.ppx__lead').innerText()).trim();
  expect('The max-fee picker holds $63.70 for a $12 max fee', (await m.locator('.picker__big').innerText()).trim() === '$12' && lead.includes('$63.70'), lead);
  await shot(m, '02-max-fee');

  const approvalCast = await screencast(m, 'frames-mia-approval');
  await m.waitForTimeout(1500);
  const opened = mia.ctx.waitForEvent('page', { timeout: 45_000 });
  mark('pay');
  await m.locator('.picker paypal-button').click();
  popup = await opened;
  mark('window');
  watch(popup, 'paypal');
  await popup.setViewportSize({ width: 390, height: 844 }).catch(() => undefined);
  const windowCast = await screencast(popup, 'frames-paypal-window');
  const result = await approveInWindow(popup, account, {
    onSignIn: (w) => shot(w, 'paypal-sign-in', { raw: true }),
    onReview: async (w) => {
      await sleep(1200);
      await shot(w, '03-paypal-window');
    },
  });
  mark('windowClosed');
  console.log(`  PayPal window closed after ${Math.round(result.ms / 1000)} s`);
  await m.waitForFunction(() => /\$63\.70 held/.test(document.querySelector('.money-chip')?.textContent ?? ''), null, { timeout: 90_000 });
  await m.waitForTimeout(1500);
  await sheetTo(m, '.auction');
  await shot(m, '04-held');
  const bid = (await api('GET', '/api/bids?mine=1', null, 'mia')).bids.find((b) => b.itemId === ITEM && b.status !== 'failed');
  const detail = await api('GET', `/api/bids/${bid.id}`, null, 'mia');
  ids.bid = bid.id;
  ids.order = detail.hold.paypalOrderId;
  ids.authorization = detail.hold.authorizationId;
  expect('PayPal holds $63.70 for Mia (authorized in the sandbox)', detail.hold.status === 'held' && detail.hold.amount.cents === 6370 && Boolean(detail.hold.authorizationId), `${detail.hold.status} ${usd(detail.hold.amount.cents)} ${detail.hold.authorizationId}`);
  await m.waitForTimeout(2500);
  mark('heldEnd');
  await approvalCast.stop();
  await windowCast.stop();
  clips.push(() =>
    clip('v1-paypal-approval.webm', [
      { frames: approvalCast.frames, from: marks.pay - 1.5, to: marks.window },
      { frames: windowCast.frames, from: windowCast.frames[0]?.t ?? marks.window, to: (windowCast.frames.at(-1)?.t ?? marks.windowClosed) + 0.4 },
      { frames: approvalCast.frames, from: marks.windowClosed, to: marks.heldEnd },
    ]),
  );

  await m.locator('.sheet.is-open .obook-strip').click();
  await m.waitForSelector('.obook .obook-ladder', { timeout: 30_000 });
  await m.waitForTimeout(1500);
  await shot(m, '05-book');

  // ---- Wei: an offer at $15 that steps down after check-in ------------------------------------
  await clockTo('10:35');
  wei = await phone(browser, '/?backend=server&demo=1&phone=queuer', 'wei');
  const w = wei.page;
  await w.locator('.tlabel__ticket', { hasText: 'Mochi Bunny' }).first().click();
  await w.waitForSelector('.sheet.is-open .q-take', { timeout: 20_000 });
  await w.waitForTimeout(1200);
  await w.locator('.q-own').click();
  await w.waitForSelector('.q-form', { timeout: 10_000 });
  const stepper = async (label) => (await w.locator('.q-stepper', { hasText: label }).locator('strong').first().innerText()).trim();
  const want = { 'Opening fee': '$15', 'Step down by': '$1', Every: '5 min', 'Never below': '$8' };
  for (const [label, value] of Object.entries(want)) {
    for (let i = 0; i < 12 && (await stepper(label)) !== value; i++) {
      const now = Number((await stepper(label)).replace(/[^0-9.]/g, ''));
      const target = Number(value.replace(/[^0-9.]/g, ''));
      await w.locator('.q-stepper', { hasText: label }).locator(`[aria-label="${now > target ? 'Lower' : 'Raise'} ${label}"]`).click();
      await w.waitForTimeout(150);
    }
  }
  const got = Object.fromEntries(await Promise.all(Object.keys(want).map(async (k) => [k, await stepper(k)])));
  expect('Wei offers $15, down $1 every 5 min, never below $8', JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  await sheetTo(w, '.q-form', 140);
  await shot(w, '06-offer');
  await w.locator('.q-form .take-button', { hasText: 'Post my offer at $15' }).click();
  await stage(w, 'arrival');
  if (await visible(w, '.sheet.is-open .q-walk')) {
    await w.locator('.sheet.is-open .q-walk').click();
    await w.waitForSelector('.sheet.is-open .q-clock__side:has-text("At the shop")', { timeout: 60_000 });
  }
  await w.waitForTimeout(1200);
  const code = (await w.locator('.sheet.is-open .q-code__value').first().innerText()).trim();
  expect("Wei's check-in code is the one in his line photo", code === 'M4RT7', code);
  await w.locator('input[data-photo="line"]').setInputFiles(path.join(FIX, 'checkin-paper-moon-wei', 'line.png'));
  await w.waitForTimeout(600);
  await w.locator('.sheet.is-open .take-button', { hasText: 'Check in' }).click();
  await stage(w, 'waiting', 150_000);
  await w.waitForTimeout(1500);
  await shot(w, '07-check-in');
  expect('The line photo passed and the fee clock runs from $15', (await w.locator('.q-feeclock').innerText()).includes('$15'));

  // ---- The step-down to the match, in Mia's order book ----------------------------------------
  await m.waitForSelector('.obook-demo__btn.is-primary:has-text("Next step")', { timeout: 30_000 });
  const stepCast = await screencast(m, 'frames-step-down');
  await m.waitForTimeout(1500);
  mark('stepStart');
  for (const fee of ['$14', '$13']) {
    await m.locator('.obook-demo__btn.is-primary', { hasText: 'Next step' }).click();
    await m.waitForTimeout(2600);
    console.log(`  Next step: Wei's fee ${fee}`);
  }
  await m.locator('.obook-demo__btn.is-primary', { hasText: 'Next step' }).click();
  await m.waitForSelector('.obook-flash', { timeout: 20_000 });
  await m.waitForTimeout(450);
  await shot(m, '08-matched', { toasts: true });
  await m.waitForSelector('.obook-flash', { state: 'detached', timeout: 20_000 });
  await m.waitForTimeout(1200);
  mark('stepEnd');
  await stepCast.stop();
  clips.push(() => clip('v2-step-down-to-match.webm', [{ frames: stepCast.frames, from: marks.stepStart - 0.8, to: marks.stepEnd }]));
  const job = (await api('GET', '/api/jobs?mine=1&role=queuer', null, 'wei')).jobs.find((j) => j.requesterId === 'mia');
  ids.job = job?.id;
  expect("Wei's fee met Mia's request at $12", job?.feeCents === 1200, `${job?.id} ${job ? usd(job.feeCents) : '-'}`);

  // ---- Wei buys, sends the proof, the AI checks it, PayPal captures and pays ------------------
  await stage(w, 'in_line', 30_000);
  await w.waitForTimeout(1000);
  await clockTo('11:38');
  await w.locator('.sheet.is-open .take-button', { hasText: 'Bought' }).click();
  await stage(w, 'proof');
  const proofCast = await screencast(w, 'frames-receipt-check');
  await w.waitForTimeout(800);
  mark('proof');
  await w.locator('input[data-photo="receipt"]').setInputFiles(path.join(FIX, 'paper-moon-mia-genuine', 'receipt.png'));
  await w.locator('input[data-photo="item"]').setInputFiles(path.join(FIX, 'paper-moon-mia-genuine', 'item.png'));
  await w.waitForTimeout(800);
  await sheetTo(w, '.q-lead');
  await clockTo('11:42');
  await w.waitForTimeout(1200);
  await shot(w, '09-proof');
  await w.locator('.sheet.is-open .take-button', { hasText: 'Send for checking' }).click();
  await stage(w, 'finish', 180_000);
  await w.waitForTimeout(1200);
  await sheetTo(w, '.q-ai');
  await shot(w, '10-receipt-check');
  await w.waitForTimeout(2500);
  mark('checkedEnd');
  await proofCast.stop();
  clips.push(() => clip('v3-receipt-check.webm', [{ frames: proofCast.frames, from: marks.proof - 0.5, to: marks.checkedEnd }]));
  await w.waitForFunction(() => /Paid \$10\.80 to you by PayPal Payouts/.test(document.querySelector('.q-money')?.textContent ?? ''), null, { timeout: 300_000 });
  await w.waitForTimeout(1000);
  await sheetTo(w, '.q-money', 230);
  await shot(w, '11-captured-paid');

  await m.keyboard.press('Escape');
  await m.waitForSelector('.obook', { state: 'detached', timeout: 10_000 }).catch(() => undefined);
  await m.waitForFunction(() => /Captured/.test(document.querySelector('.sheet.is-open .auction .order')?.textContent ?? ''), null, { timeout: 60_000 });
  await m.waitForTimeout(1200);
  await sheetTo(m, '.auction');
  await shot(m, '12-mia-captured');

  // ---- Tracking, the final capture and the release; the second payout -------------------------
  const tracking = `HPG-2611-${String(Date.now()).slice(-8)}`;
  ids.tracking = tracking;
  await clockTo('12:10'); // the post office after the line
  await w.waitForTimeout(800);
  await sheetTo(w, '.q-ship', 140);
  await w.locator('.q-ship input[name="tracking"]').fill(tracking);
  await w.locator('.q-ship input[name="cost"]').fill('8.75');
  await w.waitForTimeout(500);
  await shot(w, '13-tracking');
  await w.locator('.q-ship button[type="submit"]').click();
  await stage(w, 'paid', 120_000);
  await w.waitForSelector('.q-pay__big[data-paid="5355"]', { timeout: 300_000 });
  await w.waitForTimeout(1500);
  await shot(w, '15-payout');

  await m.waitForFunction(() => /Released/.test(document.querySelector('.sheet.is-open .auction .order')?.textContent ?? ''), null, { timeout: 60_000 });
  await m.waitForTimeout(1200);
  await sheetTo(m, '.auction');
  await shot(m, '14-released');
  await m.locator('.sheet.is-open .close-button').first().click();
  await m.waitForTimeout(800);
  await m.locator('.money-chip').click();
  await m.waitForTimeout(1500);
  await m.evaluate(() => {
    const panel = document.querySelector('#money-panel');
    const list = panel?.querySelector('.money__list');
    if (panel && list) panel.scrollTop = list.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop - 8;
  });
  await m.waitForTimeout(600);
  await shot(m, '16-money-ledger');

  // ---- What the server says --------------------------------------------------------------------
  const ledger = (await api('GET', '/api/ledger?mine=1', null, 'mia')).entries;
  const lines = ledger.map((e) => `${e.kind}:${e.amount.cents}:${e.status}`);
  expect('Ledger for Mia: held 6370, captured 4869 and 957, released 544', ['held:6370:succeeded', 'captured:4869:succeeded', 'captured:957:succeeded', 'released:544:succeeded'].every((x) => lines.includes(x)), lines.join(' '));
  ids.captures = ledger.filter((e) => e.kind === 'captured').map((e) => `${e.paypal?.captureId} ${usd(e.amount.cents)} (PayPal fee ${e.paypal?.feeCents != null ? usd(e.paypal.feeCents) : '-'})`);
  const payouts = (await api('GET', '/api/payouts?mine=1', null, 'wei')).payouts.filter((p) => p.reference === ids.job);
  expect('Payouts to Wei: fee 1080 and reimbursement 4275, both succeeded', ['fee:1080:succeeded', 'reimbursement:4275:succeeded'].every((x) => payouts.map((p) => `${p.purpose}:${p.amount.cents}:${p.status}`).includes(x)));
  ids.payouts = payouts.map((p) => `${p.purpose} ${usd(p.amount.cents)} batch ${p.paypalBatchId} item ${p.paypalItemId}`);
} finally {
  for (const c of [mia?.ctx, wei?.ctx]) await c?.close().catch(() => undefined);
}

// ---- The ops console on the same server ------------------------------------------------------
if (OPS) {
  try {
    const IGNORE = /\*{10}|License Key Not Found|Incompatible License|studio\/licensing|unlocked for trial|hide the watermark|AG Studio Pro with AI|Expected value to be of type/;
    const open = async (url) => {
      const ctx = await browser.newContext(DESKTOP);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`ops: ${e.message}`));
      page.on('console', (msg) => {
        if (msg.type() === 'error' && !IGNORE.test(msg.text())) problems.push(`ops: ${msg.text().slice(0, 240)}`);
      });
      await page.goto(`${OPS}${url}`);
      return { ctx, page };
    };
    {
      const { ctx, page } = await open('/?backend=server');
      await page.waitForSelector('.b-sch-event.hms-job', { timeout: 90_000 });
      await page.waitForSelector('.maplibregl-canvas', { timeout: 60_000 });
      await page.waitForTimeout(4000);
      // The board keeps the market clock in view; scroll it back (Bryntum's own scrollToDate) so Wei's whole
      // visit shows: on the way, in line, the fee clock, the job and the shipping at 12:10.
      const scrolled = await page.evaluate(async (at) => {
        const el = document.querySelector('.b-scheduler-base, .b-schedulerbase, .b-scheduler');
        const scheduler = globalThis.bryntum?.fromElement?.(el);
        if (!scheduler?.scrollToDate) return false;
        await scheduler.scrollToDate(new Date(at), { block: 'start', animate: false });
        return true;
      }, sf('10:25'));
      if (!scrolled) problems.push('ops: the board could not be scrolled to 10:25');
      await page.waitForTimeout(2500);
      await shot(page, 'ops-01-board');
      await ctx.close();
    }
    {
      const { ctx, page } = await open('/?backend=server#/market');
      await page.waitForSelector('.hms-gapboard', { timeout: 120_000 });
      await page.waitForTimeout(4000);
      // The PayPal ledger grid at the top of the view (the dashboard scrolls inside AG Studio's layout).
      const scrollToLedger = (on) =>
        page.evaluate((down) => {
          const title = [...document.querySelectorAll('*')].find((e) => e.children.length === 0 && e.textContent?.trim() === 'PayPal ledger');
          let box = title?.parentElement;
          while (box && !(box.scrollHeight > box.clientHeight + 4 && /(auto|scroll)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
          if (box && title) box.scrollTop = down ? box.scrollTop + title.getBoundingClientRect().top - box.getBoundingClientRect().top - 16 : 0;
        }, on);
      await scrollToLedger(true);
      await page.waitForTimeout(2500);
      await shot(page, 'ops-02-ledger');
      await scrollToLedger(false);
      await page.waitForTimeout(1500);
      // A free question to the market desk (the server's model answers each turn, D-100).
      const turns = [];
      page.on('response', (r) => {
        if (r.url().includes('/api/ops/agents/turn')) turns.push({ at: Date.now(), status: r.status() });
      });
      const input = page.getByPlaceholder(/Ask about holds/i).first();
      await input.click();
      await input.fill(DESK_QUESTION);
      await page.keyboard.press('Enter');
      const asked = Date.now();
      // The desk answers in several model turns; done when no turn has come back for 20 s.
      for (;;) {
        await page.waitForTimeout(1000);
        const last = turns.length ? turns[turns.length - 1].at : asked;
        if (turns.length > 0 && Date.now() - last > 20_000) break;
        if (Date.now() - asked > 300_000) break;
      }
      expect('The market desk answered on the live model', turns.length > 0 && turns.every((t) => t.status === 200), `${turns.length} turn(s), ${turns.map((t) => t.status).join(' ')}`);
      await page.waitForTimeout(1500);
      await shot(page, 'ops-03-desk');
      console.log(`  market desk: ${turns.length} model turn(s) in ${Math.round((Date.now() - asked) / 1000)} s`);
      await ctx.close();
    }
  } catch (err) {
    problems.push(`ops: ${err.message}`);
  }
}
await browser.close();

// ---- Videos: the PayPal approval, the step-down to the match, the receipt check -----------------
for (const make of clips) {
  try {
    make();
  } catch (err) {
    problems.push(`videos: ${err.message}`);
  }
}
if (!process.env.RAW_DIR) rmSync(RAW, { recursive: true, force: true });

console.log(`\nIds: ${JSON.stringify(ids, null, 2)}`);
const failed = checks.filter((c) => !c.ok);
if (problems.length) {
  console.log('\nPage errors:');
  for (const p of problems) console.log(' -', p);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed.`);
if (failed.length) process.exitCode = 1;
