#!/usr/bin/env node
// Reads one request back from the real PayPal sandbox and prints PayPal's amounts and fees next to the
// server's ledger (D-129). One OAuth token, then GET calls only: nothing is created, captured or paid.
//
//   npm run paypal:check -- --bid bid_0065                 a request on the running server (port 8796)
//   npm run paypal:check -- --bid bid_0065 --port-offset 200
//   npm run paypal:check -- --order 13460076A75165931      PayPal's view of one order only (no server)
//
// Keys come from the same place as the server's (HMS_SECRETS_DIR, else .secrets/ written by npm run keys).
// Only ids, statuses and amounts are printed: never a key, an email address or a name.

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { DEFAULT_PORTS, REPO, bold, dim, green, red, requireNode, resolvePorts, secretsChoice, yellow } from './common.mjs';
import { client } from './lib/sandbox-lifecycle.mjs';

const USAGE = `Read a request back from the PayPal sandbox and compare it with the server's ledger (GET calls only).

  npm run paypal:check -- --bid <id> [--port-offset <n> | --server-port <p>]
  npm run paypal:check -- --order <PayPal order id>

Options:
  --bid <id>           a request on the running server (default port ${DEFAULT_PORTS.server})
  --order <id>         a PayPal order id: PayPal's side only, no server needed
  --port-offset <n>, --server-port <p>   the same port flags as npm run dev:sandbox
  -h, --help

Needs the sandbox keys saved by npm run keys (.secrets/sandbox.env, or HMS_SECRETS_DIR).
Exit code 0 when PayPal matches the server (or only PayPal was read), 1 on a mismatch.
`;

const usd = (cents) => (cents === null || cents === undefined ? '-' : `$${(cents / 100).toFixed(2)}`);

function fail(message, code = 2) {
  console.error(`\n${red('Not checked:')} ${message}`);
  process.exit(code);
}

async function main() {
  requireNode();
  let args;
  try {
    ({ values: args } = parseArgs({
      options: {
        bid: { type: 'string' },
        order: { type: 'string' },
        'port-offset': { type: 'string' },
        'server-port': { type: 'string' },
        'web-port': { type: 'string' },
        'ops-port': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
    }));
  } catch (err) {
    fail(`${err.message}\n${USAGE}`);
  }
  if (args.help || (!args.bid && !args.order)) {
    console.log(USAGE);
    return args.help ? 0 : 2;
  }

  // The server's side first (no keys needed for that).
  let server = null;
  if (args.bid) {
    let ports;
    try {
      ports = resolvePorts(args);
    } catch (err) {
      fail(err.message);
    }
    const base = `http://127.0.0.1:${ports.server}`;
    const api = client(base);
    const health = await api('GET', '/api/health').catch(() => null);
    if (!health?.ok) fail(`no HoldMySpot server answers on ${base}. Pass the same port flags as the server.`);
    const d = await api('GET', `/api/bids/${encodeURIComponent(args.bid)}`, { as: 'ops' }).catch((e) => fail(`could not read ${args.bid}: ${e.message}`));
    if (!d.hold?.paypalOrderId) fail(`${args.bid} has no PayPal order (bid ${d.bid.status}).`);
    if (d.hold.paypalOrderId.startsWith('FAKE-') || health.mode !== 'sandbox') fail(`${args.bid} is on the simulated PayPal (ids like ${d.hold.paypalOrderId}): there is nothing to read from PayPal. Run it on npm run dev:sandbox.`);
    const jobIds = new Set(d.jobs.map((j) => j.id));
    const payouts = (await api('GET', '/api/payouts', { as: 'ops' })).payouts
      .filter((p) => jobIds.has(p.reference))
      .map((p) => ({ id: p.id, purpose: p.purpose, cents: p.amount.cents, status: p.status, batchId: p.paypalBatchId, itemId: p.paypalItemId, feeCents: p.paypalFeeCents ?? null }));
    server = { bid: d.bid, hold: d.hold, ledger: d.ledger.filter((e) => e.kind !== 'paid_out'), jobs: d.jobs, payouts };
  }

  // PayPal: the server's own REST client, sandbox host only.
  const secrets = secretsChoice();
  let pp;
  try {
    pp = await import(pathToFileURL(path.join(REPO, 'server', 'src', 'paypal', 'index.ts')).href);
  } catch (err) {
    fail(`could not load server/src/paypal (run npm run setup): ${err.message}`);
  }
  const loaded = pp.loadSandboxEnvFile({ dir: secrets.dir });
  if (!loaded.ok) fail(`no sandbox keys (${loaded.missing.length > 0 ? `missing ${loaded.missing.join(', ')}` : 'sandbox.env not usable'}). Save them with npm run keys; secrets folder: ${secrets.source}.`);
  const paypal = pp.createSandboxPayPal({ settings: loaded.settings, baseUrl: pp.SANDBOX_BASE_URL, timeoutMs: 30_000, log: () => {} });

  const orderId = args.order ?? server.hold.paypalOrderId;
  const order = await paypal.getOrder(orderId);
  console.log(bold(`PayPal sandbox, read back ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC (GET calls only)`));
  console.log(`  Order ${order.orderId}: ${order.status}, intent ${order.intent ?? '-'}, ${usd(order.amountCents)}${order.invoiceId ? `, invoice ${order.invoiceId}` : ''}${order.customId ? `, custom_id ${order.customId}` : ''}`);
  for (const t of order.trackers ?? []) console.log(`  Tracking ${t.trackingNumber} on capture ${t.captureId ?? '-'}: ${t.status ?? '-'}`);

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok, detail });
    console.log(`  ${ok ? green('[OK]') : red('[MISMATCH]')} ${name}: ${detail}`);
  };

  if (!server) {
    const authId = order.authorizations?.[0]?.authorizationId ?? null;
    if (authId) {
      const a = await paypal.getAuthorization(authId);
      console.log(`  Authorization ${a.authorizationId}: ${a.status}, ${usd(a.amountCents)}`);
    }
    for (const c of order.captures ?? []) console.log(`  Capture ${c.captureId}: ${c.status}, ${usd(c.amountCents)}${c.finalCapture ? ' final' : ''}`);
    return 0;
  }

  const { bid, hold, ledger, jobs, payouts } = server;
  console.log(`\n${bold(`Server ${bid.id}`)}: request ${bid.status}, hold ${hold.status} ${usd(hold.amount.cents)}, captured ${usd(hold.capturedCents)}, released ${usd(hold.releasedCents)}`);
  check('order amount', order.amountCents === hold.amount.cents, `PayPal ${usd(order.amountCents)}, server hold ${usd(hold.amount.cents)}`);
  if (!hold.authorizationId) {
    console.log(dim(`  Not authorized yet (PayPal ${order.status}). Approve it in PayPal's window, then run this again.`));
    return checks.every((c) => c.ok) ? 0 : 1;
  }
  const auth = await paypal.getAuthorization(hold.authorizationId);
  check('authorization', auth.amountCents === hold.amount.cents, `${auth.authorizationId} ${auth.status} ${usd(auth.amountCents)}; server hold ${hold.status} ${usd(hold.amount.cents)}`);

  const captured = ledger.filter((e) => e.kind === 'captured');
  let paypalCaptured = 0;
  for (const e of captured) {
    const id = e.paypal?.captureId;
    if (!id) {
      check(`capture ${usd(e.amount.cents)}`, e.status !== 'succeeded', `server ${e.status}, no PayPal capture id`);
      continue;
    }
    const c = await paypal.getCapture(id);
    if (c.status === 'COMPLETED') paypalCaptured += c.amountCents;
    check(
      `capture ${id}`,
      c.amountCents === e.amount.cents && (e.status !== 'succeeded' || c.status === 'COMPLETED') && (e.paypal?.feeCents == null || c.paypalFeeCents === e.paypal.feeCents),
      `PayPal ${usd(c.amountCents)} ${c.status}${c.finalCapture ? ' final' : ''}, PayPal's fee ${usd(c.paypalFeeCents)}; ledger ${usd(e.amount.cents)} ${e.status}, fee ${usd(e.paypal?.feeCents ?? null)}`,
    );
  }
  if (captured.length === 0) console.log(dim('  Nothing captured yet: the receipt capture comes after a checked receipt (npm run errand plays the queuer).'));
  else check('captured total', paypalCaptured === hold.capturedCents, `PayPal ${usd(paypalCaptured)} COMPLETED, server ${usd(hold.capturedCents)}`);
  if (auth.status === 'CAPTURED' || auth.status === 'VOIDED') {
    check('released rest', hold.releasedCents === auth.amountCents - paypalCaptured, `server ${usd(hold.releasedCents)}, PayPal remainder ${usd(auth.amountCents - paypalCaptured)} (authorization ${auth.status})`);
  }
  for (const j of jobs) {
    if (!j.shipment?.trackingNumber) continue;
    check(`tracking ${j.shipment.trackingNumber}`, (order.trackers ?? []).some((t) => t.trackingNumber === j.shipment.trackingNumber), `on the PayPal order: ${(order.trackers ?? []).map((t) => t.trackingNumber).join(', ') || 'none'}`);
  }
  for (const p of payouts) {
    if (!p.batchId) {
      console.log(dim(`  Payout ${p.id} (${p.purpose}) ${usd(p.cents)}: ${p.status}, not sent to PayPal yet`));
      continue;
    }
    const batch = await paypal.getPayoutBatch(p.batchId);
    const item = batch.items.find((i) => i.itemId === p.itemId) ?? batch.items[0] ?? null;
    check(
      `payout ${p.purpose} batch ${p.batchId}`,
      item !== null && item.amountCents === p.cents && (p.status !== 'succeeded' || item.status === 'SUCCESS') && (p.feeCents == null || item.feeCents === p.feeCents),
      `PayPal ${item ? `${usd(item.amountCents)} ${item.status}, fee ${usd(item.feeCents ?? null)}` : 'no item'} (batch ${batch.batchStatus}); server ${usd(p.cents)} ${p.status}, fee ${usd(p.feeCents)}`,
    );
  }
  const ok = checks.every((c) => c.ok);
  console.log(`\n${ok ? green('PayPal matches the server to the cent.') : yellow('PayPal and the server differ: see the lines marked MISMATCH.')}`);
  return ok ? 0 : 1;
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(`\n${red('Stopped:')} ${err?.message ?? err}`);
    process.exit(2);
  },
);
