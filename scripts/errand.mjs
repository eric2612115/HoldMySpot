#!/usr/bin/env node
// Finishes a request you placed and approved by hand: plays the queuer's side over the server's HTTP API.
//
//   npm run errand                       Mia's held Mochi Bunny plush request on the running server (port 8796)
//   npm run errand -- --bid bid_0065     a given request
//   npm run errand -- --port-offset 200  the same port flags as npm run demo / npm run dev:sandbox
//
// Made for the real PayPal sandbox (D-129): you approve the hold in PayPal's own window in the web app,
// then this plays Wei: a claim at your max fee, the check-in with the rendered line photo, "bought", the
// receipt and item photos, both PayPal Payouts and the shipment with tracking, so PayPal captures, releases
// and pays out with no stored buyer password. It also runs in the zero-key demo (simulated PayPal).
// The photos in server/fixtures/proofs show the one-time codes a fresh demo market pins on Wei's first
// visit to Paper Moon Toys, so it needs Mia's request for that plush on a fresh market (clock at or before
// 10:40; do not press Play first). It moves the market clock with POST /api/demo/clock, like the order
// book's Next step. Nothing secret is read or printed: the server holds the keys.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORTS, REPO, bold, dim, green, red, requireNode, resolvePorts } from './common.mjs';
import { ERRAND_TIMES, client, playQueuerErrand } from './lib/sandbox-lifecycle.mjs';

const USAGE = `Finish a request you approved by hand: the queuer's side of the errand over the server's API.

  npm run errand [-- options]

Options:
  --bid <id>                 the request (default: Mia's latest held Mochi Bunny plush request)
  --port-offset <n>          add n to the default server port (${DEFAULT_PORTS.server}); same flag as npm run demo
  --server-port <p>          the server's port
  -h, --help

It needs a fresh demo market (the server started by npm run demo or npm run dev:sandbox, clock at or
before ${ERRAND_TIMES.claim}, before Play) and Mia's held request for the Mochi Bunny plush at Paper Moon Toys:
the rendered photos carry the codes that market gives Wei's first visit there.
`;

const usd = (cents) => `$${(cents / 100).toFixed(2)}`;

function fail(message) {
  console.error(`\n${red('Not run:')} ${message}`);
  process.exit(1);
}

async function main() {
  requireNode();
  let args;
  try {
    ({ values: args } = parseArgs({
      options: { bid: { type: 'string' }, 'port-offset': { type: 'string' }, 'server-port': { type: 'string' }, 'web-port': { type: 'string' }, 'ops-port': { type: 'string' }, help: { type: 'boolean', short: 'h' } },
      strict: true,
    }));
  } catch (err) {
    fail(`${err.message}\n${USAGE}`);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  let ports;
  try {
    ports = resolvePorts(args);
  } catch (err) {
    fail(err.message);
  }
  const base = `http://127.0.0.1:${ports.server}`;
  const api = client(base);
  const health = await api('GET', '/api/health').catch(() => null);
  if (!health?.ok) fail(`no HoldMySpot server answers on ${base}. Start one (npm run dev:sandbox or npm run demo) with the same port flags.`);
  const shared = await import(pathToFileURL(path.join(REPO, 'shared', 'src', 'index.ts')).href);
  const { HERO, zonedLocalToEpoch } = shared;
  const sf = (hhmm) => zonedLocalToEpoch(`2026-11-12 ${hhmm}`, 'America/Los_Angeles');
  const cfg = await api('GET', '/api/config');
  if (!cfg.demo?.enabled) fail('the server is not a demo market (HMS_DEMO=1), so the market clock cannot be moved for the photos. Start it with npm run dev:sandbox or npm run demo.');

  // The request: given, or Mia's latest held plush request.
  let bidId = args.bid;
  if (!bidId) {
    const mine = (await api('GET', '/api/bids?mine=1', { as: HERO.requesterId })).bids.filter((b) => b.itemId === HERO.itemId);
    const held = mine.filter((b) => b.status === 'open').sort((a, b) => (a.id < b.id ? 1 : -1))[0];
    if (!held) {
      const waiting = mine.find((b) => b.status === 'awaiting_approval');
      fail(
        waiting
          ? `Mia's request ${waiting.id} still waits for your approval in PayPal's window. Approve it in the web app first.`
          : `Mia has no held Mochi Bunny plush request on this server. In the web app (${dim(`http://127.0.0.1:${ports.web}/?demo=1`)}) tap Mochi Bunny plush, then Set my max fee and approve the hold.`,
      );
    }
    bidId = held.id;
  }
  const detail = await api('GET', `/api/bids/${encodeURIComponent(bidId)}`, { as: 'ops' }).catch((e) => fail(`could not read ${bidId}: ${e.message}`));
  const { bid, hold } = detail;
  if (bid.itemId !== HERO.itemId || bid.requesterId !== HERO.requesterId) {
    fail(`${bidId} is not Mia's Mochi Bunny plush request at Paper Moon Toys; the rendered photos in server/fixtures/proofs are for that errand only.`);
  }
  if (bid.status === 'awaiting_approval') fail(`${bidId} still waits for your approval in PayPal's window. Approve it in the web app first.`);
  if (bid.status !== 'open' || !hold || hold.status !== 'held') fail(`${bidId} is ${bid.status} (hold ${hold?.status ?? 'none'}); the errand needs a held request nobody has taken yet.`);
  const c = cfg.clock;
  const now = c ? c.marketNow + (c.paused ? 0 : (Date.now() - c.realNow) * c.speed) : Date.now();
  if (now > sf(ERRAND_TIMES.claim)) {
    const at = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }).format(now);
    fail(
      `the market clock is at ${at}, past ${ERRAND_TIMES.claim}: the rendered photos fit a fresh demo market only (their printed times and codes). Start the server again (a fresh market each start), place and approve the request, then run this before pressing Play.`,
    );
  }

  console.log(bold(`Wei's side of ${bidId} on ${base} (${health.mode === 'sandbox' ? 'PayPal sandbox' : 'simulated PayPal'})`));
  console.log(dim(`  Hold ${usd(hold.amount.cents)} (${hold.authorizationId ?? 'no authorization id'}), max fee ${usd(bid.maxFeeCents)}. The market clock moves to ${Object.values(ERRAND_TIMES).join(', ')}.`));
  const clock = (hhmm) => api('POST', '/api/demo/clock', { body: { jumpTo: sf(hhmm), paused: true } });
  const step = (name, text) => console.log(`  ${green('ok')} ${name}${text ? `: ${text}` : ''}`);
  const out = await playQueuerErrand({ api, shared, bidId, clock, step, requesterId: bid.requesterId });

  // The ledger, as the AGENTS.md check prints it, with the PayPal ids.
  const after = await api('GET', `/api/bids/${encodeURIComponent(bidId)}`, { as: 'ops' });
  console.log(`\n${bold('Ledger')} of this request (Mia's hold and captures, Wei's payouts)`);
  for (const e of after.ledger.slice().reverse()) {
    const p = e.paypal ?? {};
    const id = p.captureId ?? (p.payoutBatchId ? `batch ${p.payoutBatchId}` : (p.authorizationId ?? p.orderId ?? ''));
    console.log(`  ${e.kind.padEnd(9)} ${usd(e.amount.cents).padStart(8)}  ${e.status.padEnd(9)} ${id}${p.feeCents != null ? `  (PayPal's fee ${usd(p.feeCents)})` : ''}`);
  }
  console.log(`  Hold ${after.hold.status}: captured ${usd(after.hold.capturedCents)}, released ${usd(after.hold.releasedCents)}; tracking ${out.trackingNumber}.`);
  const flags = args['port-offset'] !== undefined ? ` --port-offset ${args['port-offset']}` : args['server-port'] !== undefined ? ` --server-port ${args['server-port']}` : '';
  if (health.mode === 'sandbox') console.log(`\nRead it back from PayPal (GET calls only): ${bold(`npm run paypal:check -- --bid ${bidId}${flags}`)}`);
}

main().catch((err) => {
  console.error(`\n${red('Stopped:')} ${err?.message ?? err}`);
  process.exit(1);
});
