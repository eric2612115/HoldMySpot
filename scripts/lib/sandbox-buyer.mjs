// HoldMySpot: plays the PayPal SANDBOX buyer in a real browser, so the day-1 gates and the
// sandbox lifecycle run without a person at the keyboard.
//
//   const buyer = await openSandboxBuyer({ secretsDir, headless: true, shotDir });
//   await buyer.approve(approveUrl, { returnUrl, cancelUrl });   // signs in, presses Continue, waits for the return URL
//   await buyer.openDispute({ amountCents, merchantName });       // Resolution Center: "item not received"
//   await buyer.close();
//
// Rules (owner, 11-07):
// - Only https://www.sandbox.paypal.com is ever opened. Any other host is refused.
// - The buyer is the sandbox account whose email equals PAYPAL_BUYER_EMAIL in sandbox.env; its
//   password comes from sandbox-buyers.json. Both are read here, at run time, and never printed,
//   logged, thrown or written anywhere: errors carry the account label (person-N) only.
// - Any CAPTCHA, security check, one-time code or "confirm it's you" step stops at once
//   (ApprovalBlocked) with a screenshot in shotDir. Nothing tries to solve or get around it.
// - Cookie banners are declined (privacy first).
//
// Playwright comes from server/node_modules (playwright-core) with the Chromium already cached by
// web/scripts/shots.mjs; nothing is downloaded.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SANDBOX_WEB_ORIGIN = 'https://www.sandbox.paypal.com';

/** Thrown when PayPal shows a challenge (CAPTCHA, security check, code). Never retried automatically. */
export class ApprovalBlocked extends Error {
  constructor(reason, shot) {
    super(`PayPal showed a challenge (${reason}); stopped without answering it.${shot ? ` Screenshot: ${shot}` : ''}`);
    this.name = 'ApprovalBlocked';
    this.reason = reason;
    this.shot = shot ?? null;
  }
}

// ---------------------------------------------------------------------------
// Credentials (run time only; values never leave this module's objects)
// ---------------------------------------------------------------------------

function parseDotenv(text) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2] ?? '';
    if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) v = v.slice(1, -1);
    out.set(m[1], v);
  }
  return out;
}

/** An account whose email and password are not enumerable: JSON, console.log and util.inspect show the label only. */
function sealed(label, email, password) {
  const account = { label };
  Object.defineProperty(account, 'email', { value: email, enumerable: false });
  if (password !== undefined) Object.defineProperty(account, 'password', { value: password, enumerable: false });
  Object.defineProperty(account, 'toJSON', { value: () => ({ label }), enumerable: false });
  Object.defineProperty(account, Symbol.for('nodejs.util.inspect.custom'), { value: () => `SandboxAccount(${label})`, enumerable: false });
  return account;
}

function readBuyers(secretsDir) {
  const file = path.join(secretsDir, 'sandbox-buyers.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`Cannot read sandbox-buyers.json in the secrets folder.`);
  }
  const list = Array.isArray(parsed?.buyers) ? parsed.buyers : [];
  return list.filter((b) => b && typeof b.label === 'string' && typeof b.email === 'string' && typeof b.password === 'string');
}

/**
 * The sandbox buyer whose email equals PAYPAL_BUYER_EMAIL (sandbox.env), with its password from
 * sandbox-buyers.json. Throws (naming no email) when either file or the match is missing.
 */
export function loadSandboxBuyer(secretsDir) {
  let env;
  try {
    env = parseDotenv(fs.readFileSync(path.join(secretsDir, 'sandbox.env'), 'utf8'));
  } catch {
    throw new Error('Cannot read sandbox.env in the secrets folder.');
  }
  const want = (env.get('PAYPAL_BUYER_EMAIL') ?? '').trim().toLowerCase();
  if (!want) throw new Error('PAYPAL_BUYER_EMAIL is not set in sandbox.env.');
  const match = readBuyers(secretsDir).find((b) => b.email.trim().toLowerCase() === want);
  if (!match) throw new Error('No account in sandbox-buyers.json has the PAYPAL_BUYER_EMAIL address.');
  return sealed(match.label, match.email.trim(), match.password);
}

/**
 * A payout receiver picked by label from sandbox-buyers.json (email only, no password), for when
 * sandbox.env has no PAYPAL_TW_PAYOUT_EMAIL. It must not be the buyer (docs/PAYPAL-MAPPING.md section 1).
 */
export function loadPayoutReceiver(secretsDir, label) {
  const env = (() => {
    try {
      return parseDotenv(fs.readFileSync(path.join(secretsDir, 'sandbox.env'), 'utf8'));
    } catch {
      return new Map();
    }
  })();
  const buyer = (env.get('PAYPAL_BUYER_EMAIL') ?? '').trim().toLowerCase();
  const match = readBuyers(secretsDir).find((b) => b.label === label);
  if (!match) throw new Error(`No account labelled ${label} in sandbox-buyers.json.`);
  if (match.email.trim().toLowerCase() === buyer) throw new Error(`${label} is the sandbox buyer; payouts go to a different account.`);
  return sealed(match.label, match.email.trim());
}

/**
 * Any sandbox account picked by label from sandbox-buyers.json, with its password, for approving a
 * hold in PayPal's own window from the web app (web/scripts/sandbox-walk.mjs). It must not be the
 * payout receiver (PAYPAL_TW_PAYOUT_EMAIL or PAYPAL_PAYOUT_EMAIL), so a buyer is never also paid out.
 */
export function loadSandboxAccount(secretsDir, label) {
  let env = new Map();
  try {
    env = parseDotenv(fs.readFileSync(path.join(secretsDir, 'sandbox.env'), 'utf8'));
  } catch {
    // No sandbox.env: no receiver to keep apart.
  }
  const receivers = new Set(['PAYPAL_TW_PAYOUT_EMAIL', 'PAYPAL_PAYOUT_EMAIL'].map((k) => (env.get(k) ?? '').trim().toLowerCase()).filter(Boolean));
  const match = readBuyers(secretsDir).find((b) => b.label === label);
  if (!match) throw new Error(`No account labelled ${label} in sandbox-buyers.json.`);
  if (receivers.has(match.email.trim().toLowerCase())) throw new Error(`${label} is the payout receiver; approve with another sandbox account.`);
  return sealed(match.label, match.email.trim(), match.password);
}

// ---------------------------------------------------------------------------
// Challenge detection (pure, unit tested)
// ---------------------------------------------------------------------------

const CHALLENGE_URL = /(authflow\/(challenges?|twofactor|2fa|stepup|verify)|\/challenge|captcha|stepup|authchallenge|safetyhub|\/verify-it|identity\/verify)/i;
const CHALLENGE_TEXT = [
  /security challenge/i,
  /security check/i,
  /verify (it'?s|it is) you/i,
  /confirm (it'?s|it is) you/i,
  /make sure (it'?s|it is) (really )?you/i,
  /i'?m not a robot/i,
  /solve (this|the) (puzzle|challenge)/i,
  /(we('ve| have)? sent|enter|get|send) (a|the|your) (security|verification|one-time|6-digit|six-digit) code/i,
  /we('ve| have)? sent (a|the|your) code/i,
  /one-time (pass)?code/i,
  /unusual activity/i,
];

/** True when a page's URL or visible text shows a challenge PayPal wants a person to answer. */
export function challengeReason({ url = '', text = '' } = {}) {
  if (CHALLENGE_URL.test(url.split('?')[0] ?? '')) return `challenge page ${new URL(url).pathname}`;
  for (const re of CHALLENGE_TEXT) if (re.test(text)) return `challenge text "${re.source.slice(0, 40)}"`;
  return null;
}

/** Only PayPal's sandbox website may be opened. */
export function assertSandboxWebUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Not a URL.');
  }
  if (u.protocol !== 'https:' || u.hostname !== 'www.sandbox.paypal.com') throw new Error(`Refusing to open ${u.protocol}//${u.hostname}: only ${SANDBOX_WEB_ORIGIN} is allowed.`);
  return u;
}

/** The approval link in English (the sandbox otherwise follows the IP's country). */
export function englishUrl(url) {
  const u = assertSandboxWebUrl(url);
  if (!u.searchParams.has('locale.x')) u.searchParams.set('locale.x', 'en_US');
  return u.href;
}

// ---------------------------------------------------------------------------
// Browser
// ---------------------------------------------------------------------------

async function loadPlaywright() {
  const candidates = [path.join(REPO, 'server', 'node_modules', 'playwright-core', 'index.mjs'), path.join(REPO, 'web', 'node_modules', 'playwright-core', 'index.mjs')];
  for (const p of candidates) {
    if (fs.existsSync(p)) return import(pathToFileURL(p).href);
  }
  throw new Error('playwright-core is not installed in server/ or web/ (npm install there first).');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stampNow = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Opens the sandbox buyer. One browser and one context for every approval (PayPal keeps the
 * session, so later approvals usually skip the sign-in).
 */
export async function openSandboxBuyer({ secretsDir, headless = true, shotDir = null, log = () => {}, slowMo = 0, debugShots = false } = {}) {
  const account = loadSandboxBuyer(secretsDir);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless, slowMo, executablePath: process.env.CHROMIUM_PATH || undefined });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US', timezoneId: 'America/Los_Angeles' });
  // Block every navigation to a host other than PayPal's sandbox web (and its static hosts),
  // except the return and cancel URLs, which are answered locally and never reach the network.
  let returnRoutes = [];
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    const hit = returnRoutes.find((r) => url.startsWith(r.prefix));
    if (hit) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>${hit.kind}</title><body>${hit.kind}</body>` });
      return;
    }
    let host = '';
    try {
      host = new URL(url).hostname;
    } catch {
      await route.abort();
      return;
    }
    const allowed = host === 'www.sandbox.paypal.com' || host.endsWith('.paypal.com') || host.endsWith('.paypalobjects.com') || host.endsWith('.recaptcha.net') || host === 'www.google.com' || host === 'www.gstatic.com' || host.endsWith('.braintreegateway.com');
    if (!allowed && route.request().isNavigationRequest()) {
      await route.abort();
      return;
    }
    await route.continue();
  });
  let shots = 0;

  async function shot(page, name) {
    if (!shotDir) return null;
    fs.mkdirSync(shotDir, { recursive: true });
    shots += 1;
    const file = path.join(shotDir, `${stampNow()}-${String(shots).padStart(2, '0')}-${name.replace(/[^a-z0-9-]/gi, '_')}.png`);
    try {
      await page.screenshot({ path: file, fullPage: false });
      return file;
    } catch {
      return null;
    }
  }

  /** Throws ApprovalBlocked when the page asks for a person (challenge in the URL, text or a visible CAPTCHA frame). */
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
        const src = f.url();
        if (!/recaptcha\/.*bframe|hcaptcha|arkoselabs|funcaptcha|captcha-delivery|px-captcha/i.test(src)) continue;
        try {
          const el = await f.frameElement();
          const box = await el.boundingBox();
          if (box && box.width > 80 && box.height > 80 && (await el.isVisible())) {
            reason = `visible CAPTCHA frame ${new URL(src).hostname}`;
            break;
          }
        } catch {
          // A detached frame is not a challenge.
        }
      }
    }
    if (reason) {
      const file = await shot(page, 'challenge');
      throw new ApprovalBlocked(reason, file);
    }
  }

  async function visible(page, selector) {
    try {
      return await page.locator(selector).first().isVisible({ timeout: 200 });
    } catch {
      return false;
    }
  }

  /** Types a secret without letting Playwright's error text (which can echo arguments) escape. */
  async function typeSecret(page, selector, value, what) {
    try {
      const field = page.locator(selector).first();
      await field.click({ timeout: 5_000 });
      await field.fill('', { timeout: 5_000 });
      await field.pressSequentially(value, { delay: 25, timeout: 30_000 });
    } catch {
      throw new Error(`Could not type the ${what} on PayPal's sign-in page.`);
    }
  }

  async function declineCookies(page) {
    // Decline, or close the banner without accepting (PayPal's sandbox site often offers only "accept" or close).
    for (const sel of ['#bannerDeclineButton', 'button#declineAllButton', 'button:has-text("Decline")', 'button:has-text("Reject")', '#bannerCloseButton']) {
      if (await visible(page, sel)) {
        try {
          await page.locator(sel).first().click({ timeout: 3_000 });
          log('declined the cookie banner');
          return true;
        } catch {
          // try the next one
        }
      }
    }
    return false;
  }

  /**
   * What PayPal's split sign-in form shows right now. Its password field sits in a container with
   * the class `hide` until the email step is done, and Playwright still reports it as visible, so
   * the DOM is read directly.
   */
  async function signInForm(page) {
    try {
      return await page.evaluate(() => {
        const shown = (el) => {
          if (!el || el.closest('.hide') || el.getClientRects().length === 0) return false;
          const s = getComputedStyle(el);
          return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
        };
        const email = document.querySelector('#email');
        const password = document.querySelector('#password');
        return {
          email: shown(email),
          emailFilled: Boolean(email && email.value),
          password: shown(password),
          next: shown(document.querySelector('#btnNext')),
          login: shown(document.querySelector('#btnLogin')),
        };
      });
    } catch {
      return { email: false, emailFilled: false, password: false, next: false, login: false };
    }
  }

  /** Signs in when PayPal shows its email or password field. Returns true when it acted. */
  async function signInStep(page, state) {
    const form = await signInForm(page);
    if (form.email && !form.password && !state.emailDone) {
      await typeSecret(page, '#email', account.email, 'email');
      state.emailDone = true;
      if (form.next) await page.locator('#btnNext').first().click({ timeout: 10_000 });
      log(`typed the ${account.label} email`);
      if (debugShots) await shot(page, 'after-email');
      return true;
    }
    if (form.password && !state.passwordDone) {
      if (form.email && !form.emailFilled) await typeSecret(page, '#email', account.email, 'email');
      await typeSecret(page, '#password', account.password, 'password');
      state.passwordDone = true;
      await page.locator('#btnLogin').first().click({ timeout: 10_000 });
      log(`signed in as ${account.label}`);
      if (debugShots) await shot(page, 'after-password');
      return true;
    }
    // Guest checkout first: a "Log In" button opens the sign-in form.
    if (!state.loginOpened && !form.email && !form.password && (await visible(page, 'button:has-text("Log In"), a:has-text("Log In")'))) {
      state.loginOpened = true;
      await page.locator('button:has-text("Log In"), a:has-text("Log In")').first().click({ timeout: 10_000 });
      return true;
    }
    return false;
  }

  /**
   * Approves one order: opens the approval link, signs in if asked, presses PayPal's continue
   * button and waits until PayPal sends the browser to `returnUrl`. Resolves { approved, ms }.
   */
  async function approve(approveUrl, { returnUrl, cancelUrl = null, timeoutMs = 180_000, label = 'order' } = {}) {
    const url = englishUrl(approveUrl);
    if (!returnUrl) throw new Error('approve() needs the order\'s returnUrl.');
    returnRoutes = [{ prefix: returnUrl, kind: 'Approved' }, ...(cancelUrl ? [{ prefix: cancelUrl, kind: 'Cancelled' }] : [])];
    const started = Date.now();
    const page = await context.newPage();
    const state = { emailDone: false, passwordDone: false, loginOpened: false, submits: 0 };
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      if (debugShots) await shot(page, `${label}-landing`);
      for (;;) {
        const now = page.url();
        if (now.startsWith(returnUrl)) {
          log(`${label}: PayPal returned to the shop after ${Math.round((Date.now() - started) / 1000)} s`);
          return { approved: true, ms: Date.now() - started };
        }
        if (cancelUrl && now.startsWith(cancelUrl)) throw new Error(`${label}: PayPal sent the buyer to the cancel URL.`);
        if (Date.now() - started > timeoutMs) {
          const file = await shot(page, `${label}-timeout`);
          throw new Error(`${label}: no approval after ${Math.round(timeoutMs / 1000)} s (page ${new URL(now).pathname}).${file ? ` Screenshot: ${file}` : ''}`);
        }
        await guard(page);
        if (await declineCookies(page)) continue;
        if (await signInStep(page, state)) {
          await sleep(1_500);
          continue;
        }
        // The review page: PayPal's own submit button ("Continue to Review Order", "Continue", "Pay Now", "Agree & Continue").
        const submit = page.locator('#payment-submit-btn, button[data-testid="submit-button-initial"], button:has-text("Continue to Review Order"), button:has-text("Agree & Continue"), button:has-text("Complete Purchase")').first();
        let canSubmit = false;
        try {
          canSubmit = (await submit.isVisible({ timeout: 300 })) && (await submit.isEnabled({ timeout: 300 }));
        } catch {
          canSubmit = false;
        }
        if (canSubmit && state.submits < 4) {
          if (debugShots) await shot(page, `${label}-review`);
          state.submits += 1;
          try {
            await submit.click({ timeout: 10_000 });
            log(`${label}: pressed PayPal's continue button`);
          } catch {
            // The page moved on while clicking; the loop looks again.
          }
          await sleep(2_500);
          continue;
        }
        await sleep(800);
      }
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** Signs in on www.sandbox.paypal.com (no order) and waits until PayPal leaves the sign-in page. */
  async function signIn(page, timeoutMs = 90_000) {
    const state = { emailDone: false, passwordDone: false, loginOpened: false };
    await page.goto(englishUrl(`${SANDBOX_WEB_ORIGIN}/signin`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const started = Date.now();
    for (;;) {
      await guard(page);
      if (!/\/signin/.test(new URL(page.url()).pathname) && (state.passwordDone || !(await signInForm(page)).email)) return;
      if (Date.now() - started > timeoutMs) {
        const file = await shot(page, 'signin-timeout');
        throw new Error(`Sign-in did not finish in ${Math.round(timeoutMs / 1000)} s.${file ? ` Screenshot: ${file}` : ''}`);
      }
      if (await declineCookies(page)) continue;
      if (await signInStep(page, state)) {
        await sleep(2_500);
        continue;
      }
      await sleep(800);
    }
  }

  async function clickFirst(page, selector, timeout = 10_000) {
    await page.locator(selector).first().click({ timeout });
  }

  /**
   * Opens an "item not received" dispute in the buyer's Resolution Center on the most recent
   * PAYMENT (a capture) of `amountCents` from the merchant. Walks PayPal's filing pages: reason,
   * item types, issue, expected refund (the whole amount, spread over the item lines), a note,
   * then Submit. Resolves { submitted, transactionId, caseId } (ids PayPal shows the buyer).
   */
  async function openDispute({ amountCents, note = 'The parcel never arrived. HoldMySpot sandbox test.', timeoutMs = 240_000 } = {}) {
    if (!Number.isInteger(amountCents) || amountCents <= 0) throw new Error('openDispute needs the payment amount in cents.');
    const amountText = `$${(amountCents / 100).toFixed(2)} USD`;
    const page = await context.newPage();
    const started = Date.now();
    try {
      await signIn(page);
      await page.goto(englishUrl(`${SANDBOX_WEB_ORIGIN}/disputes/dashboard/`), { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await sleep(4_000);
      await guard(page);
      if (await visible(page, '#bannerCloseButton')) await clickFirst(page, '#bannerCloseButton').catch(() => {});
      const row = () => page.locator('button', { hasText: 'Payment - ' }).filter({ hasText: amountText }).first();
      if (!(await row().isVisible().catch(() => false)) && (await visible(page, 'button:has-text("View all")'))) {
        await clickFirst(page, 'button:has-text("View all")');
        await sleep(3_000);
      }
      if (!(await row().isVisible().catch(() => false))) {
        const file = await shot(page, 'dispute-no-payment');
        throw new Error(`No ${amountText} payment in the buyer's Resolution Center list.${file ? ` Screenshot: ${file}` : ''}`);
      }
      await row().click({ timeout: 10_000 });
      await sleep(2_500);
      const report = page.locator('a[href^="/resolutioncenter/"]', { hasText: 'Report a Problem' }).first();
      const href = await report.getAttribute('href', { timeout: 10_000 });
      const transactionId = /\/resolutioncenter\/([A-Z0-9]+)/.exec(href ?? '')?.[1] ?? null;
      log(`dispute: reporting the ${amountText} payment (buyer transaction ${transactionId ?? 'unknown'})`);
      await report.click({ timeout: 10_000 });
      await sleep(5_000);

      const done = { reason: false, notes: false };
      for (let step = 0; step < 30; step += 1) {
        if (Date.now() - started > timeoutMs) throw new Error(`The dispute form did not finish in ${Math.round(timeoutMs / 1000)} s.`);
        await guard(page);
        if (await visible(page, '#bannerCloseButton')) await clickFirst(page, '#bannerCloseButton').catch(() => {});
        const text = await page.evaluate(() => (document.querySelector('main') ?? document.body).innerText).catch(() => '');
        if (/already (reported|opened|filed)|case (is )?already open|you've already/i.test(text)) {
          return { submitted: false, alreadyOpen: true, transactionId, caseId: /PP-[A-Z]-[A-Z0-9]+(?:-[0-9]+)?/.exec(text)?.[0] ?? null };
        }
        if (await visible(page, 'button:has-text("Submit")')) {
          await clickFirst(page, 'button:has-text("Submit")');
          await sleep(6_000);
          await guard(page);
          const after = await page.evaluate(() => (document.querySelector('main') ?? document.body).innerText).catch(() => '');
          await shot(page, 'dispute-submitted');
          log('dispute: submitted');
          return { submitted: true, alreadyOpen: false, transactionId, caseId: /PP-[A-Z]-[A-Z0-9]+(?:-[0-9]+)?/.exec(after)?.[0] ?? null };
        }
        if (await visible(page, 'button:has-text("Continue Reporting this Issue")')) {
          await clickFirst(page, 'button:has-text("Continue Reporting this Issue")');
          await sleep(3_500);
          continue;
        }
        if (await visible(page, 'button:has-text("Report Issue to PayPal")')) {
          await clickFirst(page, 'button:has-text("Report Issue to PayPal")');
          await sleep(3_500);
          continue;
        }
        if (!done.reason && (await visible(page, 'button:has-text("received the item or service")'))) {
          done.reason = true;
          await clickFirst(page, 'button:has-text("received the item or service")');
          await sleep(3_500);
          continue;
        }
        const continueBtn = 'button[type="submit"]:has-text("Continue")';
        // Item types, categories and issues: one native <select> per field behind PayPal's dropdowns.
        const selects = await page
          .$$eval('form select[name^="items."]', (els) => els.map((e) => ({ name: e.getAttribute('name'), value: e.value, options: [...e.options].map((o) => ({ v: o.value, t: o.text })) })))
          .catch(() => []);
        const empty = selects.filter((s) => !s.value);
        if (empty.length > 0) {
          for (const s of empty) {
            const real = s.options.filter((o) => o.v !== '');
            const index = Number(/items\.(\d+)\./.exec(s.name)?.[1] ?? 0);
            let pick;
            if (/\.type$/.test(s.name)) pick = real.find((o) => (index === 0 ? /physical/i : /service/i).test(o.t));
            else if (/\.category$/.test(s.name)) pick = real.find((o) => /toy|hobb/i.test(o.t)) ?? real.find((o) => /other/i.test(o.t));
            else pick = real.find((o) => /reached me|haven.t received/i.test(o.t));
            pick = pick ?? real[0];
            if (pick) await page.selectOption(`select[name="${s.name}"]`, pick.v).catch(() => {});
            await sleep(500);
          }
          await clickFirst(page, continueBtn);
          await sleep(3_500);
          continue;
        }
        // Expected refund per item line: the whole payment, spread over the lines.
        const refunds = page.locator('input[name$="expected_refund"]');
        const count = await refunds.count().catch(() => 0);
        if (count > 0 && (await refunds.first().inputValue().catch(() => 'x')) === '') {
          const lines = [...text.matchAll(/\$([\d,]+\.\d{2}) USD x (\d+)/g)].map((m) => Math.round(Number(m[1].replace(/,/g, '')) * 100) * Number(m[2]));
          let left = amountCents;
          for (let i = 0; i < count; i += 1) {
            const after = count - i - 1;
            const cap = lines[i] ?? left;
            const cents = i === count - 1 ? left : Math.max(1, Math.min(cap, left - after));
            left -= cents;
            const field = page.locator(`input[name="items.${i}.expected_refund"]`);
            await field.scrollIntoViewIfNeeded().catch(() => {});
            await field.focus();
            await field.fill((cents / 100).toFixed(2));
            await field.press('Tab');
          }
          await sleep(600);
          await clickFirst(page, continueBtn);
          await sleep(3_500);
          continue;
        }
        if (!done.notes && (await visible(page, 'textarea[name="notes"]'))) {
          done.notes = true;
          await page.locator('textarea[name="notes"]').fill(note);
          await sleep(400);
          await clickFirst(page, continueBtn);
          await sleep(4_000);
          continue;
        }
        if (await visible(page, continueBtn)) {
          await clickFirst(page, continueBtn);
          await sleep(3_500);
          continue;
        }
        await sleep(1_500);
      }
      const file = await shot(page, 'dispute-stuck');
      throw new Error(`The dispute form stopped at an unknown page.${file ? ` Screenshot: ${file}` : ''}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    account,
    context,
    approve,
    openDispute,
    signIn,
    guard,
    shot,
    visible,
    signInStep,
    declineCookies,
    async close() {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}
