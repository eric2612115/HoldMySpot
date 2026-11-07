import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ENDPOINTS, endpointParts, HERO } from '@holdmyspot/shared';
import type { ApiKey } from '@holdmyspot/shared';
import { placeholderPng } from '../src/util/images.ts';
import { DAY, ITEM, SHOP, MIN, NY_SHIP, testServer, type TestServer } from './helpers.ts';

describe('HTTP contract', () => {
  let s: TestServer;
  before(async () => {
    s = await testServer({ crowd: true });
  });
  after(() => s.done());

  it('registers every endpoint in the contract table', () => {
    for (const key of Object.keys(ENDPOINTS) as ApiKey[]) {
      const { method, path } = endpointParts(key);
      assert.ok(s.fastify.hasRoute({ method, url: path }), key);
    }
  });

  it('answers 501 NOT_BUILT for endpoints not built yet', async () => {
    const res = await s.call('POST', '/api/paypal/webhook', { body: {} });
    assert.equal(res.status, 501);
    assert.equal(res.json.error.code, 'NOT_BUILT');
  });

  it('serves config, clock, cities, shops, users and books', async () => {
    const cfg = await s.call('GET', '/api/config');
    assert.equal(cfg.status, 200);
    assert.equal(cfg.json.mode, 'fake');
    assert.equal(cfg.json.paypal.clientId, null);
    assert.equal(cfg.json.ai.provider, 'fake');
    assert.equal(cfg.json.rules.platformFeeBps, 1000);
    const books = await s.call('GET', '/api/books?cityId=sf');
    assert.equal(books.json.books.length, 13);
    const hero = books.json.books.find((b: { itemId: string }) => b.itemId === HERO.itemId);
    assert.equal(hero.bids.count, 12);
    assert.equal(hero.bids.bestFeeCents, 1100);
    assert.ok(hero.bids.latestDeadlineAt > s.app.now());
    assert.equal((await s.call('GET', '/api/books?cityId=nyc')).json.books.length, 4);
    const users = await s.call('GET', '/api/users?role=queuer');
    assert.ok(users.json.users.every((u: { home: unknown }) => u.home === null), 'home positions are private');
    const me = await s.call('GET', '/api/me', { as: 'wei' });
    assert.deepEqual(me.json.user.home, [-122.4385, 37.7779]);
    assert.equal((await s.call('GET', `/api/shops/${SHOP.id}`)).json.books.length, 1);
  });

  it('requires a known persona and validates bodies', async () => {
    const none = await s.call('POST', '/api/bids', { body: {} });
    assert.equal(none.status, 401);
    assert.equal(none.json.error.code, 'UNAUTHORIZED');
    const crowd = await s.call('GET', '/api/me', { as: 'crowd-01' });
    assert.equal(crowd.status, 401);
    const bad = await s.call('POST', '/api/bids', { as: 'mia', body: { shopId: SHOP.id, itemId: ITEM, qty: 0 } });
    assert.equal(bad.status, 400);
    assert.equal(bad.json.error.code, 'BAD_REQUEST');
    assert.ok(Array.isArray(bad.json.error.details.issues));
    const rule = await s.call('POST', '/api/bids', {
      as: 'mia',
      body: { shopId: SHOP.id, itemId: ITEM, qty: 2, retailCapCents: 2000, maxFeeCents: 1200, shippingBudgetCents: 3500, destination: NY_SHIP, deadlineAt: s.app.now() + DAY, funding: 'paypal', agent: null },
    });
    assert.equal(rule.status, 400);
    assert.equal(rule.json.error.code, 'RETAIL_CAP_TOO_LOW');
  });

  it('runs the whole loop over HTTP: quote, hold, ask, check-in, proof, captures and payouts', async () => {
    const quote = await s.call('POST', '/api/bids/quote', { as: 'mia', body: { shopId: SHOP.id, itemId: ITEM, qty: 2, destination: NY_SHIP } });
    assert.equal(quote.status, 200, JSON.stringify(quote.json));
    // $26.00 a plush: cap $28; 50 minutes in line: $12 fee; 800 g parcel: $9.50 shipping, $13 budget;
    // plus the processing reserve for two one-plush jobs at their caps ($6.42).
    assert.deepEqual(quote.json.suggested, { retailCapCents: 2800, maxFeeCents: 1200, shippingBudgetCents: 1300 });
    assert.equal(quote.json.limitCents, 9942);
    assert.equal(quote.json.processingReserveCents, 642);
    assert.match(quote.json.disclosures[0], /PayPal holds up to \$99\.42/);
    assert.match(quote.json.disclosures[2], /^Processing and payouts: up to \$6\.42/);

    const body = {
      shopId: SHOP.id,
      itemId: ITEM,
      qty: 2,
      ...quote.json.suggested,
      destination: NY_SHIP,
      deadlineAt: s.app.now() + 2 * DAY,
      funding: 'paypal',
      agent: null,
    };
    const created = await s.call('POST', '/api/bids', { as: 'mia', body, idem: 'mia-bid-1' });
    assert.equal(created.status, 200, JSON.stringify(created.json));
    assert.equal(created.json.bid.status, 'awaiting_approval');
    assert.equal(created.json.checkout.next, 'fake_approve');
    const replay = await s.call('POST', '/api/bids', { as: 'mia', body, idem: 'mia-bid-1' });
    assert.equal(replay.json.bid.id, created.json.bid.id);
    assert.equal(replay.headers['idempotent-replay'], 'true');
    const conflict = await s.call('POST', '/api/bids', { as: 'mia', body: { ...body, qty: 1 }, idem: 'mia-bid-1' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.error.code, 'IDEMPOTENCY_CONFLICT');

    const bidId = created.json.bid.id as string;
    const orderId = created.json.checkout.orderId as string;
    const approve = await s.call('POST', `/api/fake/paypal/orders/${orderId}/approve`, { body: { funding: 'paypal', outcome: 'approve' } });
    assert.equal(approve.json.status, 'APPROVED');
    const auth = await s.call('POST', `/api/bids/${bidId}/authorize`, { as: 'mia', body: { orderId } });
    assert.equal(auth.status, 200, JSON.stringify(auth.json));
    assert.equal(auth.json.hold.status, 'held');
    assert.equal(auth.json.hold.amount.cents, 9942);
    assert.equal((await s.call('GET', `/api/bids/${bidId}`, { as: 'jun' })).status, 403);

    // Wei posts a fixed $11 offer for 4: Mia's $12 is matched at once (the crowd rests at $8 or below).
    const wei = s.app.store.users.must('wei').user;
    const ask = await s.call('POST', '/api/asks', {
      as: 'wei',
      body: { shopId: SHOP.id, itemId: ITEM, capacity: 4, modes: ['ship'], feeCents: 1100, clock: null, etaAt: s.app.now() + 15 * MIN, from: { lngLat: wei.home, accuracyM: 10 } },
    });
    assert.equal(ask.status, 200, JSON.stringify(ask.json));
    const miaMatch = ask.json.matches.find((m: { bidId: string }) => m.bidId === bidId);
    assert.ok(miaMatch, 'Mia is matched');
    assert.equal(miaMatch.feeCents, 1100);
    const claimId = ask.json.claim.id as string;
    assert.ok(ask.json.claim.checkInCode);
    const publicClaim = await s.call('GET', `/api/claims/${claimId}`, { as: 'mia' });
    assert.equal(publicClaim.json.claim.checkInCode, null, 'codes only for the queuer');

    const linePhoto = await s.call('POST', '/api/files?purpose=line_photo&fixture=line_ok', { as: 'wei', body: placeholderPng('http-line') });
    assert.equal(linePhoto.status, 200, JSON.stringify(linePhoto.json));
    assert.equal(linePhoto.json.file.width, 16);
    const far = await s.call('POST', `/api/claims/${claimId}/check-in`, { as: 'wei', body: { lngLat: [SHOP.lngLat[0] + 0.01, SHOP.lngLat[1]], accuracyM: 8, photoFileId: linePhoto.json.file.id } });
    assert.equal(far.status, 422);
    assert.equal(far.json.error.code, 'OUTSIDE_GEOFENCE');
    const checkin = await s.call('POST', `/api/claims/${claimId}/check-in`, { as: 'wei', body: { lngLat: SHOP.lngLat, accuracyM: 8, photoFileId: linePhoto.json.file.id } });
    assert.equal(checkin.status, 200, JSON.stringify(checkin.json));
    assert.equal(checkin.json.claim.status, 'arrived');
    assert.equal(checkin.json.proof.status, 'verifying');
    await s.app.idle();
    assert.equal(s.app.store.claims.must(claimId).status, 'checked_in');

    const job = s.app.store.jobs.where('bid_id = ?', bidId)[0]!;
    assert.equal(job.status, 'queueing');
    const asMia = await s.call('GET', `/api/jobs/${job.id}`, { as: 'mia' });
    assert.equal(asMia.json.job.proofCode, null);
    const asWei = await s.call('GET', `/api/jobs/${job.id}`, { as: 'wei' });
    assert.equal(asWei.json.job.proofCode, job.proofCode);
    assert.equal(asWei.json.bid, null, "the queuer does not see the requester's bid");

    await s.at(s.app.now() + 40 * MIN);
    assert.equal((await s.call('POST', `/api/jobs/${job.id}/bought`, { as: 'wei' })).status, 200);
    const receipt = await s.call('POST', '/api/files?purpose=receipt', { as: 'wei', body: placeholderPng('http-receipt') });
    const photo = await s.call('POST', '/api/files?purpose=item_photo', { as: 'wei', body: placeholderPng('http-item') });
    assert.equal((await s.call('GET', `/api/files/${receipt.json.file.id}`, { as: 'jun' })).status, 403);
    const proof = await s.call('POST', `/api/jobs/${job.id}/proof`, { as: 'wei', body: { receiptFileId: receipt.json.file.id, itemFileId: photo.json.file.id } });
    assert.equal(proof.status, 200, JSON.stringify(proof.json));
    await s.app.idle();
    const file = await s.call('GET', `/api/files/${receipt.json.file.id}`, { as: 'mia' });
    assert.equal(file.status, 200, 'the requester can see the receipt of her job');
    assert.equal(file.headers['content-type'], 'image/png');

    const ledger = await s.call('GET', `/api/ledger?bidId=${bidId}`, { as: 'mia' });
    assert.deepEqual(
      ledger.json.entries.map((e: { kind: string; amount: { cents: number } }) => [e.kind, e.amount.cents]),
      [
        ['captured', 7770],
        ['held', 9942],
      ],
    );
    const shipped = await s.call('POST', `/api/jobs/${job.id}/shipment`, {
      as: 'wei',
      body: { carrierName: 'Harbor Parcel Ground', trackingNumber: 'HPG-HTTP-1', shippingCostCents: 1100, dutyPaidCents: 0, labelFileId: null },
      idem: 'ship-1',
    });
    assert.equal(shipped.status, 200, JSON.stringify(shipped.json));
    assert.equal(shipped.json.job.status, 'shipped');
    assert.deepEqual(
      shipped.json.ledger.map((e: { kind: string; amount: { cents: number }; userId: string }) => [e.kind, e.amount.cents, e.userId]),
      [
        ['captured', 1191, 'mia'],
        ['released', 981, 'mia'],
        ['paid_out', 6300, 'wei'],
      ],
    );
    const payouts = await s.call('GET', '/api/payouts?mine=1', { as: 'wei' });
    assert.deepEqual(payouts.json.payouts.map((p: { amount: { cents: number }; receiverEmail: string | null }) => [p.amount.cents, p.receiverEmail]), [
      [6300, null],
      [1980, null],
    ]);
    const opsPayouts = await s.call('GET', '/api/payouts', { as: 'ops' });
    assert.ok(opsPayouts.json.payouts.every((p: { receiverEmail: string | null }) => p.receiverEmail !== null), 'ops sees receiver emails');
  });

  it('serves the ops board and datasets', async () => {
    const board = await s.call('GET', '/api/ops/board?cityId=sf');
    assert.equal(board.status, 200);
    assert.ok(board.json.resources.some((r: { id: string }) => r.id === 'wei'));
    assert.ok(board.json.events.some((e: { kind: string }) => e.kind === 'claim_window'));
    assert.ok(board.json.timeRanges.length > 0);
    const fills = await s.call('GET', '/api/ops/datasets/fills');
    assert.equal(fills.json.name, 'fills');
    assert.ok(fills.json.rows.length > 0);
    assert.equal((await s.call('GET', '/api/ops/datasets/nope')).status, 404);
  });
});

describe('server-sent events', () => {
  let s: TestServer;
  let base = '';
  before(async () => {
    s = await testServer();
    await s.fastify.listen({ host: '127.0.0.1', port: 0 });
    const addr = s.fastify.server.address();
    base = typeof addr === 'object' && addr ? `http://127.0.0.1:${addr.port}` : '';
  });
  after(() => s.done());

  async function readEvents(url: string, until: (events: { event: string; data: any; id: string | null }[]) => boolean, headers: Record<string, string> = {}) {
    const ctrl = new AbortController();
    const res = await fetch(url, { headers, signal: ctrl.signal });
    assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    const reader = res.body!.getReader();
    const events: { event: string; data: any; id: string | null }[] = [];
    let buf = '';
    const deadline = Date.now() + 3000;
    while (!until(events) && Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const lines = chunk.split('\n');
        const ev = lines.find((l) => l.startsWith('event: '))?.slice(7);
        const data = lines.find((l) => l.startsWith('data: '))?.slice(6);
        const id = lines.find((l) => l.startsWith('id: '))?.slice(4) ?? null;
        if (ev && data) events.push({ event: ev, data: JSON.parse(data), id });
      }
    }
    ctrl.abort();
    return events;
  }

  it('sends hello, then only the events this persona may see, redacted', async () => {
    const pending = readEvents(`${base}/api/events?as=wei`, (evs) => evs.some((e) => e.event === 'claim.updated'));
    await new Promise((r) => setTimeout(r, 50));
    const { placeBid, postAsk } = await import('./helpers.ts');
    await placeBid(s.app, 'mia', { qty: 1, maxFeeCents: 1200 });
    await postAsk(s.app, 'wei', { capacity: 1, feeCents: 1100 });
    const events = await pending;
    assert.equal(events[0]!.event, 'hello');
    assert.equal(events[0]!.data.data.as, 'wei');
    assert.equal(events[0]!.data.data.mode, 'fake');
    const types = events.map((e) => e.event);
    assert.ok(!types.includes('bid.updated'), "Wei does not get Mia's bid");
    assert.ok(!types.includes('hold.updated'));
    assert.ok(types.includes('book.updated'));
    const claim = events.find((e) => e.event === 'claim.updated')!;
    assert.ok(claim.data.data.checkInCode, 'the queuer gets his own check-in code');
    assert.ok(Number(claim.id) > 0);
  });

  it('replays missed events after Last-Event-ID and redacts codes for others', async () => {
    const latest = s.app.bus.latestSeq();
    const firstClaimSeq = s.app.bus.after(0).find((e) => e.type === 'claim.updated')!.seq;
    const events = await readEvents(`${base}/api/events?as=mia`, (evs) => evs.some((e) => e.id === String(latest)), { 'last-event-id': String(firstClaimSeq - 1) });
    const claim = events.find((e) => e.event === 'claim.updated')!;
    assert.equal(claim.data.data.checkInCode, null);
    assert.ok(events.some((e) => e.event === 'bid.updated'), 'Mia gets her own bid');
    const resync = await readEvents(`${base}/api/events?as=mia&since=999999`, (evs) => evs.some((e) => e.event === 'resync'));
    assert.equal(resync.at(-1)!.data.data.reason, 'unknown_position');
  });
});
