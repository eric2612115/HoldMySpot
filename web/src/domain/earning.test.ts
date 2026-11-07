import { describe, expect, it } from 'vitest';
import { JAPANTOWN, distanceMeters } from '@holdmyspot/shared';
import { buildCatalog } from './catalog';
import { MAX_WALK_MINUTES, rateText, reachOf, reachRadiusMeters, travelFor } from './earning';

const T0 = Date.UTC(2026, 10, 12, 18, 30); // 10:30 in San Francisco
const sf = buildCatalog('sf', T0);
const at = (id: string) => sf.find((p) => p.id === id)!;

describe('reach and earning rate', () => {
  it('prices the Paper Moon plush from Japantown: a short walk, a long line, about $12 an hour after the 10% fee', () => {
    const r = reachOf(at('plush-paper-moon'), JAPANTOWN, T0);
    expect(r.claimable).toBe(true);
    expect(r.travelMode).toBe('walk');
    expect(r.walkMin).toBeLessThanOrEqual(2);
    expect(r.queueMin).toBe(50);
    expect(r.feeCents).toBe(1100);
    expect(r.keepCents).toBe(990);
    expect(r.centsPerHour).toBe(Math.round((990 * 60) / (r.travelMin + 50)));
    expect(rateText(r.centsPerHour)).toBe('$12/h');
  });

  it('greys out a shop more than 30 minutes away and requests that end before arrival', () => {
    expect(reachOf(at('cake-ocean-beach'), JAPANTOWN, T0)).toMatchObject({ claimable: false, reason: 'too_far' });
    expect(reachOf(at('plush-geneva-corner'), JAPANTOWN, T0)).toMatchObject({ claimable: false, reason: 'too_far' });
    expect(reachOf(at('ramen-dogpatch-noodle'), JAPANTOWN, T0)).toMatchObject({ claimable: false, reason: 'ends_before' });
  });

  it('walks up to 20 minutes and takes transit beyond, never faster than the market rule', () => {
    const near = reachOf(at('cake-butter-bell'), JAPANTOWN, T0);
    expect(near.travelMode).toBe('walk');
    expect(near.travelMin).toBe(near.walkMin);
    const far = reachOf(at('ramen-sunset-house'), JAPANTOWN, T0);
    expect(far.travelMode).toBe('transit');
    expect(far.travelMin).toBeGreaterThanOrEqual(MAX_WALK_MINUTES);
    for (const p of sf) {
      const r = reachOf(p, JAPANTOWN, T0);
      expect(r.travelMin).toBeGreaterThanOrEqual(r.ruleMin);
    }
  });

  it('never shows a farther shop as closer: travel minutes grow with distance', () => {
    const rows = sf.map((p) => reachOf(p, JAPANTOWN, T0)).sort((a, b) => a.distanceM - b.distanceM);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.travelMin).toBeGreaterThanOrEqual(rows[i - 1]!.travelMin);
    let last = 0;
    for (let d = 0; d <= 12_000; d += 25) {
      const t = travelFor(d, Math.max(1, Math.ceil(d / 250))).travelMin;
      expect(t).toBeGreaterThanOrEqual(last);
      last = t;
    }
  });

  it('draws the 30-minute ring where travel reaches 30 minutes, and greys exactly what lies outside it', () => {
    const radius = reachRadiusMeters(30);
    expect(radius).toBe(4800);
    for (const p of sf) {
      const r = reachOf(p, JAPANTOWN, T0);
      expect(r.reason === 'too_far').toBe(distanceMeters(JAPANTOWN, p.lngLat) > radius + 1);
    }
  });

  it('commits an arrival time that covers the trip it shows', () => {
    const r = reachOf(at('cake-butter-bell'), JAPANTOWN, T0);
    expect(r.arriveAt - T0).toBeGreaterThanOrEqual(r.travelMin * 60_000);
    expect(r.arriveAt - T0).toBeGreaterThanOrEqual(r.ruleMin * 60_000);
  });
});
