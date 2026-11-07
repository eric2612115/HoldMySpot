import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { describe, it } from 'node:test';

/**
 * The sandbox tools in scripts/lib (plain .mjs, loaded at run time): the sanitizer that writes
 * recorded fixtures, and the sandbox buyer's safety checks (only www.sandbox.paypal.com, stop at
 * any challenge, credentials never printable). No browser and no network here.
 */

const lib = (name: string) => new URL(`../../../scripts/lib/${name}`, import.meta.url).href;
const sanitize: any = await import(lib('sanitize.mjs'));
const buyer: any = await import(lib('sandbox-buyer.mjs'));

describe('recorded fixtures are sanitized', () => {
  it('drops emails, names, payer and merchant ids, addresses, phones, tokens and link queries; keeps ids, statuses, amounts and times', () => {
    const raw = {
      id: '4YN92854KP1948610',
      status: 'COMPLETED',
      payment_source: { paypal: { email_address: 'someone@personal.example.com', account_id: 'ABCDEF123', name: { given_name: 'Jo', surname: 'Doe' }, address: { country_code: 'US', postal_code: '95131' } } },
      payer: { payer_id: 'ABCDEF123', phone: { phone_number: { national_number: '4085551234' } } },
      purchase_units: [
        {
          invoice_id: 'HMS-GATE-20261107-1614-A',
          items: [{ name: 'Lucky Cat plush (shop price, up to)', quantity: '2' }],
          payee: { email_address: 'store@business.example.com', merchant_id: 'MERCHANT1', display_data: { brand_name: 'HoldMySpot' } },
          shipping: { name: { full_name: 'Jo Doe' }, address: { address_line_1: '1 Main St', country_code: 'US' } },
          payments: { captures: [{ id: '1M687255LP844644Y', amount: { currency_code: 'USD', value: '76.01' }, create_time: '2026-11-07T08:15:08Z' }] },
        },
      ],
      disputed_transactions: [{ buyer: { name: 'Jo Doe' }, seller: { name: 'Test Store', email: 'store@business.example.com' } }],
      messages: [{ content: 'Write to someone@personal.example.com please' }],
      links: [{ href: 'https://www.sandbox.paypal.com/checkoutnow?token=4YN92854KP1948610', rel: 'payer-action' }],
      access_token: 'A21AAsecret',
    };
    const out = sanitize.sanitizePayPal(raw);
    const text = JSON.stringify(out);
    assert.doesNotMatch(text, /personal\.example\.com|business\.example\.com|ABCDEF123|MERCHANT1|Jo Doe|"Jo"|95131|1 Main St|4085551234|A21AAsecret|token=/);
    assert.equal(out.id, '4YN92854KP1948610');
    assert.equal(out.purchase_units[0].invoice_id, 'HMS-GATE-20261107-1614-A');
    assert.equal(out.purchase_units[0].items[0].name, 'Lucky Cat plush (shop price, up to)', 'item names are ours and stay');
    assert.equal(out.purchase_units[0].payee.display_data.brand_name, 'HoldMySpot');
    assert.deepEqual(out.purchase_units[0].payments.captures[0], raw.purchase_units[0]!.payments.captures[0]);
    assert.equal(out.links[0].href, 'https://www.sandbox.paypal.com/checkoutnow');
    assert.deepEqual(out.purchase_units[0].shipping.address, { country_code: 'US' });
    assert.equal(out.disputed_transactions[0].seller.name, 'Redacted');
  });

  it('reports leaks by length only', () => {
    assert.deepEqual(sanitize.findLeaks('{"a":"x@y.example"}', ['x@y.example', 'absent-value']), [11]);
  });
});

describe('the sandbox buyer', () => {
  it('opens only www.sandbox.paypal.com and asks for English pages', () => {
    assert.throws(() => buyer.assertSandboxWebUrl('https://www.paypal.com/checkoutnow?token=X'), /only https:\/\/www\.sandbox\.paypal\.com/);
    assert.throws(() => buyer.assertSandboxWebUrl('http://www.sandbox.paypal.com/checkoutnow?token=X'));
    assert.throws(() => buyer.assertSandboxWebUrl('https://www.sandbox.paypal.com.evil.example/x'));
    assert.equal(buyer.englishUrl('https://www.sandbox.paypal.com/checkoutnow?token=ABC'), 'https://www.sandbox.paypal.com/checkoutnow?token=ABC&locale.x=en_US');
  });

  it('stops at challenge pages and texts, not at an ordinary sign-in or review page', () => {
    for (const page of [
      { url: 'https://www.sandbox.paypal.com/authflow/challenges/recaptcha?x=1', text: '' },
      { url: 'https://www.sandbox.paypal.com/signin', text: 'Security Challenge. Please complete the puzzle.' },
      { url: 'https://www.sandbox.paypal.com/signin', text: "Let's confirm it's you" },
      { url: 'https://www.sandbox.paypal.com/signin', text: 'We sent a security code to your phone' },
      { url: 'https://www.sandbox.paypal.com/signin', text: "I'm not a robot" },
    ]) {
      assert.ok(buyer.challengeReason(page), `expected a challenge: ${page.url} ${page.text}`);
    }
    for (const page of [
      { url: 'https://www.sandbox.paypal.com/checkoutnow?token=ABC', text: 'Pay with PayPal. Enter your email address to get started. Next' },
      { url: 'https://www.sandbox.paypal.com/webapps/hermes?token=ABC', text: 'Pay with CREDIT UNION 1 Continue to Review Order Add a promo code' },
      { url: 'https://www.sandbox.paypal.com/resolutioncenter/filing/7EU524993K045830W', text: 'Report a problem. Continue' },
    ]) {
      assert.equal(buyer.challengeReason(page), null, `not a challenge: ${page.text}`);
    }
  });

  it('finds the buyer by PAYPAL_BUYER_EMAIL, never shows its email or password, and refuses the buyer as payout receiver', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hms-buyers-'));
    try {
      writeFileSync(join(dir, 'sandbox.env'), 'PAYPAL_ENV=sandbox\nPAYPAL_BUYER_EMAIL="Buyer-Three@Personal.Example.com"\n');
      writeFileSync(
        join(dir, 'sandbox-buyers.json'),
        JSON.stringify({
          note: 'test accounts',
          buyers: [
            { label: 'person-1', email: 'one@personal.example.com', password: 'pw-one-not-real' },
            { label: 'person-3', email: 'buyer-three@personal.example.com', password: 'pw-three-not-real' },
          ],
        }),
      );
      const account = buyer.loadSandboxBuyer(dir);
      assert.equal(account.label, 'person-3');
      assert.equal(account.password, 'pw-three-not-real');
      const shown = `${JSON.stringify(account)} ${inspect(account)} ${Object.keys(account).join(',')} ${String(account)}`;
      assert.doesNotMatch(shown, /buyer-three|pw-three/i);
      const receiver = buyer.loadPayoutReceiver(dir, 'person-1');
      assert.equal(receiver.email, 'one@personal.example.com');
      assert.equal(receiver.password, undefined);
      assert.doesNotMatch(JSON.stringify(receiver), /one@/);
      assert.throws(() => buyer.loadPayoutReceiver(dir, 'person-3'), /is the sandbox buyer/);
      assert.throws(() => buyer.loadPayoutReceiver(dir, 'person-9'), /No account labelled person-9/);
      writeFileSync(join(dir, 'sandbox.env'), 'PAYPAL_ENV=sandbox\nPAYPAL_BUYER_EMAIL=nobody@personal.example.com\n');
      assert.throws(() => buyer.loadSandboxBuyer(dir), (e: Error) => /No account/.test(e.message) && !/nobody@/.test(e.message));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a challenge error names the reason and the screenshot only', () => {
    const e = new buyer.ApprovalBlocked('challenge page /authflow/challenges', '/tmp/shot.png');
    assert.equal(e.name, 'ApprovalBlocked');
    assert.match(e.message, /stopped without answering it/);
    assert.equal(e.shot, '/tmp/shot.png');
  });
});
