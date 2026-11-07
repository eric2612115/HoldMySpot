import { SEED_USERS } from '@holdmyspot/shared';
import { describe, expect, it } from 'vitest';
import { CAST_MODELS, FACE_CELLS, PORTRAIT_CELL, PORTRAIT_COLUMNS, PORTRAIT_ROWS, portraitCell, type CastMeta } from './castModels';
import { JOINTS } from './cozyPose';
import { CROWD_LOOKS, PEOPLE, PLAYER_LOOK, PLAYER_PALETTE, PASSERBY_LOOK, lookOfUser } from './presets';

const dir = new URL('../../../public/models/cast/', import.meta.url);
// The web app's types are the browser's; vitest runs in Node, so the file reader comes in untyped.
const fsModule = 'node:fs';
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as { readFileSync(path: URL): Uint8Array };
const bytes = (file: string) => readFileSync(new URL(file, dir));
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

interface Gltf {
  extensionsRequired?: string[];
  nodes: Array<{ name?: string; extras?: Record<string, unknown>; children?: number[]; mesh?: number; skin?: number }>;
  skins: Array<{ joints: number[] }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  accessors: Array<{ count: number }>;
}

/** The JSON chunk of a binary glTF. */
function glbJson(file: string): Gltf {
  const b = bytes(file);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(v.getUint32(0, true), `${file} magic`).toBe(0x46546c67);
  expect(v.getUint32(4, true), `${file} version`).toBe(2);
  const len = v.getUint32(12, true);
  expect(v.getUint32(16, true), `${file} JSON chunk`).toBe(0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(b.subarray(20, 20 + len))) as Gltf;
}

/** Width and height of a WebP (lossy, lossless or extended). */
function webpSize(file: string): { w: number; h: number } {
  const b = bytes(file);
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  expect(ascii(b, 0, 4)).toBe('RIFF');
  expect(ascii(b, 8, 12)).toBe('WEBP');
  const kind = ascii(b, 12, 16);
  const u24 = (at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
  if (kind === 'VP8X') return { w: 1 + u24(24), h: 1 + u24(27) };
  if (kind === 'VP8L') {
    const bits = v.getUint32(21, true);
    return { w: 1 + (bits & 0x3fff), h: 1 + ((bits >> 14) & 0x3fff) };
  }
  if (kind === 'VP8 ') return { w: v.getUint16(26, true) & 0x3fff, h: v.getUint16(28, true) & 0x3fff };
  throw new Error(`${file}: unknown WebP chunk ${kind}`);
}

const metas = new Map<string, CastMeta>(CAST_MODELS.map((m) => [m, glbJson(`${m}.glb`).nodes[0]!.extras as unknown as CastMeta]));

describe('the baked cozy cast (public/models/cast)', () => {
  it('has a skinned model for every cast member, named after it, with the joints the poses move', () => {
    for (const model of CAST_MODELS) {
      const g = glbJson(`${model}.glb`);
      expect(g.nodes[0]!.name).toBe(model);
      expect(metas.get(model)!.id).toBe(model);
      // Only extensions three.js loads (with the meshopt decoder the app sets).
      for (const e of g.extensionsRequired ?? []) expect(['KHR_mesh_quantization', 'EXT_meshopt_compression']).toContain(e);
      const names = new Set(g.skins[0]!.joints.map((i) => g.nodes[i]!.name));
      for (const j of JOINTS.filter((x) => !x.startsWith('pony') && x !== 'tail')) expect(names.has(j), `${model}: ${j}`).toBe(true);
      expect(names.has('tail'), `${model}: tail`).toBe(metas.get(model)!.kind !== 'human');
      const attrs = g.meshes[0]!.primitives[0]!.attributes;
      for (const a of ['POSITION', 'NORMAL', 'COLOR_0', 'JOINTS_0', 'WEIGHTS_0', '_DATA']) expect(attrs[a], `${model}: ${a}`).toBeDefined();
    }
  });

  it('keeps every model light enough for the map: at most 20 000 triangles and 160 KB', () => {
    for (const model of CAST_MODELS) {
      const g = glbJson(`${model}.glb`);
      const prim = g.meshes[0]!.primitives[0]! as unknown as { indices: number };
      expect(g.accessors[prim.indices]!.count / 3, model).toBeLessThanOrEqual(20000);
      expect(bytes(`${model}.glb`).length, model).toBeLessThanOrEqual(160 * 1024);
    }
  });

  it('has both face atlases for every model: one square cell per expression', () => {
    for (const model of CAST_MODELS) {
      for (const [set, cell] of [
        ['stage', 512],
        ['map', 256],
      ] as const) {
        const { w, h } = webpSize(`faces/${model}-${set}.webp`);
        expect({ w, h }, `${model} ${set}`).toEqual({ w: cell * FACE_CELLS.length, h: cell });
      }
    }
  });

  it('has one portrait per model in the sprite sheet, in the order of CAST_MODELS', () => {
    expect(webpSize('portraits.webp')).toEqual({ w: PORTRAIT_COLUMNS * PORTRAIT_CELL, h: PORTRAIT_ROWS * PORTRAIT_CELL });
    const cells = new Set(CAST_MODELS.map((m) => JSON.stringify(portraitCell(m))));
    expect(cells.size).toBe(CAST_MODELS.length);
    expect(portraitCell('you')).toEqual({ col: 0, row: 0 });
    expect(portraitCell(CAST_MODELS[CAST_MODELS.length - 1]!)).toEqual({ col: (CAST_MODELS.length - 1) % PORTRAIT_COLUMNS, row: PORTRAIT_ROWS - 1 });
  });
});

describe('every look wears its own baked model', () => {
  it('gives each demo person a model of their own, the crowd the crowd models, and the player "you"', () => {
    const named = Object.values(PEOPLE).map((l) => l.model);
    expect(new Set(named).size).toBe(named.length);
    for (const m of named) expect(m.startsWith('crowd-'), m).toBe(false);
    expect(CROWD_LOOKS.map((l) => l.model).sort()).toEqual(CAST_MODELS.filter((m) => m.startsWith('crowd-')).sort());
    expect(PLAYER_LOOK.model).toBe('you');
    expect(CROWD_LOOKS).toContain(PASSERBY_LOOK);
    // The film's leads and the people of the hero script wear the film's own characters.
    expect({ mia: lookOfUser('mia').model, wei: lookOfUser('wei').model, lin: lookOfUser('lin').model, rex: lookOfUser('rex').model, priya: lookOfUser('priya').model }).toEqual({
      mia: 'mia',
      wei: 'wei',
      lin: 'lin',
      rex: 'rex',
      priya: 'priya',
    });
    for (const u of SEED_USERS) expect(CAST_MODELS).toContain(lookOfUser(u.id).model);
  });

  it('matches the flat UI colours to the models: species, skin or fur, and the top every badge is ringed with', () => {
    for (const look of [...Object.values(PEOPLE), ...CROWD_LOOKS, PLAYER_LOOK]) {
      const meta = metas.get(look.model)!;
      expect(meta.kind, look.model).toBe(look.species);
      expect(meta.colors.top.toLowerCase(), look.model).toBe(look.palette.top.toLowerCase());
      expect(meta.colors.skin.toLowerCase(), look.model).toBe(look.palette.skin.toLowerCase());
      if (look.species === 'human') expect(meta.colors.hair?.toLowerCase(), look.model).toBe(look.palette.hair.toLowerCase());
    }
  });

  it('recolours only the player, from the player palette', () => {
    for (const model of CAST_MODELS) expect(metas.get(model)!.tint !== null, model).toBe(model === 'you');
    const tint = metas.get('you')!.tint!;
    expect({ hair: tint.hair, top: tint.top, bottom: tint.bottom }).toEqual({
      hair: PLAYER_PALETTE.hair.toLowerCase(),
      top: PLAYER_PALETTE.top.toLowerCase(),
      bottom: PLAYER_PALETTE.bottom.toLowerCase(),
    });
  });

  it('holds at most one prop, with the arms that hold it', () => {
    for (const model of CAST_MODELS) {
      const meta = metas.get(model)!;
      if (meta.prop === null) expect(meta.heldArms, model).toEqual([]);
      else expect(meta.heldArms.length, model).toBe(meta.prop === 'phone' ? 2 : 1);
      for (const side of meta.heldArms) expect(meta.hold[`shoulder${side}`], model).toBeDefined();
    }
  });
});
