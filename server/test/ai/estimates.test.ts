import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_RULES, SHIPPING_NOTES, findItem, findShop, travelMinutes } from '@holdmyspot/shared';
import { AiError } from '../../src/ai/errors.ts';
import { estimateEta, feeEstimate, shippingEstimate } from '../../src/ai/estimates.ts';
import { StubProvider, at } from './helpers.ts';

const shop = findShop('paper-moon-toys')!;
const item = findItem('plush-paper-moon')!;
const fee = (latestLinePhoto: { peopleAhead: number | null; at: number } | null) => ({ shop, item, at: at('10:31'), latestLinePhoto, rules: DEFAULT_RULES });

describe('fee estimate', () => {
  it('suggests $12 and a $15 to $8 clock for the Paper Moon plush at its 50-minute baseline', async () => {
    const e = await feeEstimate(fee(null));
    assert.equal(e.expectedWaitMinutes, 50);
    assert.equal(e.suggestedFeeCents, 1200);
    assert.deepEqual(e.clock, { feeCents: 1500, stepCents: 100, intervalMs: 300_000, floorCents: 800 });
    assert.match(e.basis[0] ?? '', /50-minute wait/);
    assert.deepEqual([e.ai.provider, e.ai.mode], ['fake', 'fake']);
  });

  it('uses the latest line photo when there is one', async () => {
    const e = await feeEstimate(fee({ peopleAhead: 20, at: at('10:50') }));
    assert.equal(e.expectedWaitMinutes, 25);
    assert.equal(e.suggestedFeeCents, 600);
    assert.equal(e.peopleAhead, 20);
    assert.match(e.basis[0] ?? '', /Line photo at 10:50 shows about 20 people/);
  });

  it('lets a live model phrase the basis, and keeps the template when it fails', async () => {
    const live = new StubProvider({ json: () => ({ sentences: ['About 50 minutes in line, so $12.00 per plush is a fair fee. Extra.', 'A helper may start at $15.00.'] }) });
    const e = await feeEstimate(fee(null), live);
    assert.deepEqual(e.basis, ['About 50 minutes in line, so $12.00 per plush is a fair fee.', 'A helper may start at $15.00.']);
    assert.equal(e.ai.mode, 'live');
    assert.equal(e.suggestedFeeCents, 1200, 'numbers never come from the model');
    assert.equal(live.jsonCalls[0]?.task, 'fee_estimate');
    const broken = new StubProvider({
      json: () => {
        throw new AiError('timeout', 'slow');
      },
    });
    const t = await feeEstimate(fee(null), broken);
    assert.equal(t.ai.provider, 'fake');
    assert.match(t.basis[1] ?? '', /Suggested fee \$12\.00 per plush/);
  });
});

describe('shipping estimate', () => {
  it('prices one plush to New York as in the worked example', async () => {
    const e = await shippingEstimate({ item, qty: 1, destination: { mode: 'ship', country: 'US', region: 'NY', city: 'New York', postalCode: null } });
    assert.deepEqual([e.parcelGrams, e.shippingCents, e.dutyCents, e.budgetCents], [650, 900, 0, 1200]);
    assert.equal(e.service, 'Harbor Parcel Ground, tracked');
    for (const note of SHIPPING_NOTES) assert.ok(e.notes.includes(note));
    assert.match(e.notes[0] ?? '', /650 g parcel/);
  });
});

describe('ETA estimate', () => {
  it('gives travel, arrival, wait and an earning rate', () => {
    const from: [number, number] = [-122.4385, 37.7779]; // Wei's home
    const now = at('10:35');
    const e = estimateEta({ from, shop, item, now, feeCents: 1200, qty: 2 });
    const travel = travelMinutes(from, shop.lngLat);
    assert.equal(e.travelMinutes, travel);
    assert.equal(e.etaAt, now + travel * 60_000);
    assert.equal(e.doneAt, e.etaAt + 50 * 60_000);
    assert.equal(e.inRange, true);
    assert.equal(e.centsPerHour, Math.round((2400 * 60) / (travel + 50)));
    assert.ok(e.distanceMeters > 1000 && e.distanceMeters < 2000);
  });
});
