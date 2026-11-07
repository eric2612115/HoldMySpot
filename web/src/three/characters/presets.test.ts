import { CROWD_NAMES, HERO, SEED_USERS } from '@holdmyspot/shared';
import { describe, expect, it } from 'vitest';
import { CROWD_LOOKS, PEOPLE, lookOfName, lookOfUser, personSpec, specOf, userOfName, type PersonLook } from './presets';

const speciesOf = (id: string) => lookOfUser(id).species;

/** sRGB hex to CIELAB (D65). */
function lab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => lin(c / 255)) as [number, number, number];
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/** CIE76 colour difference. */
function deltaE(a: string, b: string): number {
  const [l1, a1, b1] = lab(a);
  const [l2, a2, b2] = lab(b);
  return Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}

/** HSL saturation and lightness of a hex colour. */
function satLight(hex: string): { s: number; l: number } {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

const describeLook = (l: PersonLook) => `${l.species} ${l.palette.skin} in ${l.palette.top}`;

describe('the cast: humans and animal-people', () => {
  it('gives every seeded user a look keyed by the avatar string they carry', () => {
    for (const u of SEED_USERS) {
      expect(u.avatar, u.id).toBeTruthy();
      expect(PEOPLE[u.avatar!], u.id).toBeDefined();
    }
    expect(Object.keys(PEOPLE).sort()).toEqual(SEED_USERS.map((u) => u.avatar).sort());
  });

  it('keeps the film leads human and gives the other demo people their species', () => {
    expect(speciesOf(HERO.requesterId)).toBe('human');
    expect(speciesOf(HERO.queuerId)).toBe('human');
    expect(speciesOf(HERO.fakeReceiptQueuerId)).toBe('raccoon');
    expect(speciesOf(HERO.nextQueuerId)).toBe('fox');
    expect({ rin: speciesOf('rin'), ava: speciesOf('ava'), jo: speciesOf('jo'), dana: speciesOf('dana'), jun: speciesOf('jun'), leo: speciesOf('leo') }).toEqual({
      rin: 'cat',
      ava: 'squirrel',
      jo: 'dog',
      dana: 'bunny',
      jun: 'cat',
      leo: 'dog',
    });
  });

  it('dresses the crowd half in humans and half in animal-people, and a name always gets the same look', () => {
    const animals = CROWD_LOOKS.filter((l) => l.species !== 'human').length;
    expect(animals * 2).toBe(CROWD_LOOKS.length);
    for (const name of CROWD_NAMES) {
      expect(userOfName(name)).toBeUndefined();
      expect(lookOfName(name)).toBe(lookOfName(name));
      expect(CROWD_LOOKS).toContain(lookOfName(name));
    }
  });

  it('finds demo people by the names lines and offers carry', () => {
    expect(userOfName('Wei')?.id).toBe('wei');
    expect(userOfName('Mia R.')?.id).toBe('mia');
    expect(lookOfName('Rex')).toBe(PEOPLE['queuer-rex']);
    expect(userOfName('Kit')).toBeUndefined();
  });

  it('builds specs with their own palette copies, fur for animal-people and hair for humans', () => {
    const a = personSpec('queuer-lin');
    const b = personSpec('queuer-lin');
    expect(a.species).toBe('fox');
    expect(a.fur?.light).toBeTruthy();
    a.palette.top = '#000000';
    expect(b.palette.top).not.toBe('#000000');
    expect(PEOPLE['queuer-lin']!.palette.top).not.toBe('#000000');
    const wei = specOf(PEOPLE['queuer-wei']!, 'wei');
    expect(wei.species).toBe('human');
    expect(wei.hair).toBe('tousled');
    expect(wei.fur).toBeUndefined();
  });
});

describe('crowd extras never look like a named person', () => {
  const named = Object.values(PEOPLE);

  it('never reuses a named person\'s top colour', () => {
    const tops = new Set(named.map((l) => l.palette.top.toLowerCase()));
    for (const c of CROWD_LOOKS) expect(tops.has(c.palette.top.toLowerCase()), describeLook(c)).toBe(false);
  });

  it('never reuses a named human\'s skin and hair pair', () => {
    const pairs = new Set(named.filter((l) => l.species === 'human').map((l) => `${l.palette.skin}/${l.palette.hair}`.toLowerCase()));
    for (const c of CROWD_LOOKS.filter((l) => l.species === 'human')) expect(pairs.has(`${c.palette.skin}/${c.palette.hair}`.toLowerCase()), describeLook(c)).toBe(false);
  });

  it('keeps a crowd animal at least 20 apart (CIE76) from a named animal of the same species', () => {
    for (const c of CROWD_LOOKS.filter((l) => l.species !== 'human')) {
      for (const p of named.filter((l) => l.species === c.species)) {
        expect(deltaE(c.palette.skin, p.palette.skin), `${describeLook(c)} vs ${describeLook(p)}`).toBeGreaterThan(20);
      }
    }
  });

  it('keeps every bunny out of grey fur and blue tops (no grey rabbit, no uniform)', () => {
    for (const l of [...named, ...CROWD_LOOKS].filter((x) => x.species === 'bunny')) {
      const { s, l: light } = satLight(l.palette.skin);
      expect(s < 0.18 && light > 0.2 && light < 0.85, describeLook(l)).toBe(false);
      const top = lab(l.palette.top);
      // Blue tops have a strongly negative b* with little red.
      expect(top[2] < -20 && top[1] < 15, describeLook(l)).toBe(false);
    }
  });
});
