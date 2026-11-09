import { SEED_USERS, type User } from '@holdmyspot/shared';
import type { CastModel } from './castModels';
import type { Accessory, ChibiPalette, ChibiSpec, FurColours, HairStyle, Species, TopStyle } from './chibi';

export type CastRole = 'player' | 'queuer' | 'buyer' | 'passerby';

export interface CastMember {
  role: CastRole;
  title: string;
  blurb: string;
  spec: ChibiSpec;
}

/** The player's default look. Hair, top and trousers are meant to be recoloured to match a real person. */
export const PLAYER_PALETTE: ChibiPalette = {
  skin: '#F6D0B8',
  hair: '#3B2F4A',
  top: '#6C5CE7',
  bottom: '#2E3A59',
  shoes: '#FFFFFF',
  accent: '#FFC53D',
};

/**
 * Role archetypes of the older procedural chibi (chibi.ts), which now only stands in when a cast model cannot load.
 * The app's own people are the cozy cast: `castLook`, `PEOPLE` and `CROWD_LOOKS` below.
 */
export const CAST: CastMember[] = [
  {
    role: 'player',
    title: 'You',
    blurb: 'Walks the map, asks for things, and sometimes queues for others.',
    spec: { name: 'player', hair: 'tousled', top: 'hoodie', accessory: 'backpack', palette: { ...PLAYER_PALETTE }, seed: 1 },
  },
  {
    role: 'queuer',
    title: 'Queuer',
    blurb: 'Stands in line, buys at the shop price, uploads the receipt.',
    spec: {
      name: 'queuer',
      hair: 'bun',
      top: 'tee',
      accessory: 'tote',
      palette: { skin: '#F1C19C', hair: '#7A4A2E', top: '#FF8FAB', bottom: '#56688F', shoes: '#FFFFFF', accent: '#FFD166' },
      seed: 2,
    },
  },
  {
    role: 'buyer',
    title: 'Buyer',
    blurb: 'Asks for an item with a PayPal hold and pays only when a receipt is checked.',
    spec: {
      name: 'buyer',
      hair: 'bob',
      top: 'jacket',
      accessory: 'phone',
      palette: { skin: '#C98D69', hair: '#1F1A2B', top: '#3FB7A5', bottom: '#E9D6BF', shoes: '#8D6BE0', accent: '#FFF3D6' },
      seed: 3,
    },
  },
  {
    role: 'passerby',
    title: 'Passer-by',
    blurb: 'Spots a glowing task nearby and decides to help.',
    spec: {
      name: 'passerby',
      hair: 'beanie',
      top: 'tee',
      accessory: 'coffee',
      palette: { skin: '#8A5A3C', hair: '#2B1D16', top: '#9AD26A', bottom: '#3C4466', shoes: '#FF9248', accent: '#F45B69' },
      seed: 4,
    },
  },
];

/** Fresh copy of a cast member's spec (palettes are mutable). */
export function castSpec(role: CastRole, seed?: number): ChibiSpec {
  const member = CAST.find((c) => c.role === role)!;
  return { ...member.spec, palette: { ...member.spec.palette }, seed: seed ?? member.spec.seed };
}

// ------------------------------------------------------------------ people

/**
 * A person's look. `model` is their baked character from the film's cozy cast
 * (castModels.ts): what the map, the characters page and the face badges show.
 * The rest describes the same person in plain terms: species, colours (humans
 * have hair; animal-people have fur colours instead and their main fur is
 * `palette.skin`), and the hair, top and accessory the older procedural chibi
 * uses if a model cannot load. Every look is original.
 */
export interface PersonLook {
  model: CastModel;
  species: Species;
  hair?: HairStyle;
  top: TopStyle;
  accessory: Accessory;
  palette: ChibiPalette;
  fur?: FurColours;
}

export const SPECIES_NAMES: Record<Species, string> = {
  human: 'Human',
  bunny: 'Bunny',
  cat: 'Cat',
  dog: 'Dog',
  fox: 'Fox',
  squirrel: 'Squirrel',
  raccoon: 'Raccoon',
};

/** For animal palettes: the hair slot is unused, so it carries the darkest fur tone (outlines of brows never show). */
const NO_HAIR = '#3A2B33';

/**
 * The demo people, keyed by the `avatar` string each seeded user carries
 * (shared/src/seed.ts). Mia, Wei, Lin, Rex and Priya are the film's own
 * characters; the others are new looks made the same way. Mia and Wei, the
 * film's leads, stay human.
 */
export const PEOPLE: Record<string, PersonLook> = {
  // Requesters.
  'requester-mia': {
    model: 'mia',
    species: 'human',
    hair: 'bob',
    top: 'hoodie',
    accessory: 'phone',
    palette: { skin: '#f8d6c2', hair: '#3e3242', top: '#ff8fb8', bottom: '#3f4f86', shoes: '#fffaf5', accent: '#ff6f9e' },
  },
  'requester-jun': {
    model: 'jun',
    species: 'cat',
    top: 'jacket',
    accessory: 'phone',
    palette: { skin: '#f4e8d8', hair: NO_HAIR, top: '#3d5a98', bottom: '#e9d6bf', shoes: '#8d6be0', accent: '#fffdf8' },
    fur: { light: '#fbf3e8', mark: '#7a5a48', pattern: 'points' },
  },
  'requester-priya': {
    model: 'priya',
    species: 'human',
    hair: 'bun',
    top: 'jacket',
    accessory: 'coffee',
    palette: { skin: '#b97e5c', hair: '#261c20', top: '#3aa0a6', bottom: '#f2e2c4', shoes: '#e86a5c', accent: '#2f8d93' },
  },
  'requester-sam': {
    model: 'sam',
    species: 'human',
    hair: 'bun',
    top: 'hoodie',
    accessory: 'none',
    palette: { skin: '#ffdcc6', hair: '#b5651d', top: '#57c4e5', bottom: '#3a3f5c', shoes: '#ffb4a2', accent: '#ffb4a2' },
  },
  'requester-noor': {
    model: 'noor',
    species: 'human',
    hair: 'bun',
    top: 'jacket',
    accessory: 'tote',
    palette: { skin: '#8a5a3c', hair: '#2b1d16', top: '#b69cff', bottom: '#2f3e46', shoes: '#b69cff', accent: '#f2c14e' },
  },
  'requester-leo': {
    model: 'leo',
    species: 'dog',
    top: 'tee',
    accessory: 'coffee',
    palette: { skin: '#9a6646', hair: NO_HAIR, top: '#8fcbef', bottom: '#3c4466', shoes: '#f45b69', accent: '#f45b69' },
    fur: { light: '#f3dcc2', mark: '#5a3524', pattern: 'blaze' },
  },
  // Queuers.
  'queuer-wei': {
    model: 'wei',
    species: 'human',
    hair: 'tousled',
    top: 'hoodie',
    accessory: 'coffee',
    palette: { skin: '#f0c7a8', hair: '#352823', top: '#f4b93c', bottom: '#5574b6', shoes: '#f39c88', accent: '#4a64b4' },
  },
  'queuer-lin': {
    model: 'lin',
    species: 'fox',
    top: 'hoodie',
    accessory: 'phone',
    palette: { skin: '#f59a52', hair: NO_HAIR, top: '#b9a3f4', bottom: '#5f78b8', shoes: '#ffd36e', accent: '#3fb0a6' },
    fur: { light: '#fff3e6', mark: '#5e4038' },
  },
  'queuer-rin': {
    model: 'rin',
    species: 'cat',
    top: 'tee',
    accessory: 'phone',
    palette: { skin: '#686c7d', hair: NO_HAIR, top: '#1c9380', bottom: '#56688f', shoes: '#ffb4a2', accent: '#ffb4a2' },
    fur: { light: '#f6f4f8', mark: '#4b4f5f' },
  },
  'queuer-ava': {
    model: 'ava',
    species: 'squirrel',
    top: 'jacket',
    accessory: 'coffee',
    palette: { skin: '#9e9792', hair: NO_HAIR, top: '#278f5f', bottom: '#4e5d94', shoes: '#ff8fab', accent: '#fffaf6' },
    fur: { light: '#f4eee8', mark: '#5f5853' },
  },
  'queuer-jo': {
    model: 'jo',
    species: 'dog',
    top: 'hoodie',
    accessory: 'none',
    palette: { skin: '#45404c', hair: NO_HAIR, top: '#e2434f', bottom: '#2e3a59', shoes: '#2e3a59', accent: '#fff4e8' },
    fur: { light: '#fbf8f4', mark: '#2a2630', pattern: 'blaze' },
  },
  'queuer-rex': {
    model: 'rex',
    species: 'raccoon',
    top: 'hoodie',
    accessory: 'backpack',
    palette: { skin: '#bdb9c9', hair: NO_HAIR, top: '#e0507f', bottom: '#4a5168', shoes: '#8ec9f0', accent: '#5aa7e0' },
    fur: { light: '#f7f5f8', mark: '#3e3848' },
  },
  'queuer-dana': {
    model: 'dana',
    species: 'bunny',
    top: 'jacket',
    accessory: 'tote',
    palette: { skin: '#c9946c', hair: NO_HAIR, top: '#8fd9c0', bottom: '#56688f', shoes: '#ff8fab', accent: '#ff9fb8' },
    fur: { light: '#fff0e0', mark: '#8b5a3c', pattern: 'dutch' },
  },
  'queuer-theo': {
    model: 'theo',
    species: 'human',
    hair: 'tousled',
    top: 'jacket',
    accessory: 'coffee',
    palette: { skin: '#ffd6bf', hair: '#c68b59', top: '#3f525c', bottom: '#c9b79c', shoes: '#6b4a3a', accent: '#a9c4b5' },
  },
  'queuer-mo': {
    model: 'mo',
    species: 'human',
    hair: 'beanie',
    top: 'tee',
    accessory: 'phone',
    palette: { skin: '#9c6644', hair: '#1b1b1b', top: '#ff8a3d', bottom: '#3c4466', shoes: '#3fb7a5', accent: '#3fb7a5' },
  },
};

/**
 * Looks for everyone else (crowd requesters, people in a line who are not
 * demo users, walkers): the film's crowd, half humans (a grandpa in a
 * cardigan, a cloud of curls, a guy in a knit beanie, a kid with pigtails) and
 * half animal-people (a tabby in a scarf, a shaggy dog, a bunny in a lilac
 * raincoat, a squirrel with a huge tail). A name always gets the same look.
 * Extras never wear a named person's top colour, skin and hair pair, or the
 * same species in a close fur colour (presets.test.ts), so nobody seems to
 * appear twice.
 */
export const CROWD_LOOKS: PersonLook[] = [
  { model: 'crowd-grandpa', species: 'human', hair: 'tousled', top: 'jacket', accessory: 'none', palette: { skin: '#f1c6a8', hair: '#d2ccc8', top: '#d8c2a2', bottom: '#7d6b5c', shoes: '#c9b8a4', accent: '#8fb4d9' } },
  {
    model: 'crowd-bunny',
    species: 'bunny',
    top: 'jacket',
    accessory: 'none',
    palette: { skin: '#fbf6f2', hair: NO_HAIR, top: '#cbb7ef', bottom: '#5a6a9a', shoes: '#cbb7ef', accent: '#efe7fb' },
    fur: { light: '#ffffff', mark: '#e9dcd6' },
  },
  { model: 'crowd-curls', species: 'human', hair: 'bob', top: 'tee', accessory: 'phone', palette: { skin: '#8d5a3f', hair: '#2a1d1a', top: '#ff9a52', bottom: '#34437a', shoes: '#ff9a52', accent: '#9de2c9' } },
  {
    model: 'crowd-dog',
    species: 'dog',
    top: 'hoodie',
    accessory: 'none',
    palette: { skin: '#ead2aa', hair: NO_HAIR, top: '#f0785a', bottom: '#3c4a72', shoes: '#3c4a72', accent: '#fff4e8' },
    fur: { light: '#fff6e8', mark: '#a8774e', pattern: 'blaze' },
  },
  { model: 'crowd-beanie', species: 'human', hair: 'beanie', top: 'hoodie', accessory: 'coffee', palette: { skin: '#e2b08c', hair: '#3a2a22', top: '#4f9a6a', bottom: '#8a8f9e', shoes: '#e9574a', accent: '#e9574a' } },
  {
    model: 'crowd-squirrel',
    species: 'squirrel',
    top: 'jacket',
    accessory: 'none',
    palette: { skin: '#c8733f', hair: NO_HAIR, top: '#6f8fe0', bottom: '#7a4a32', shoes: '#6f8fe0', accent: '#6f8fe0' },
    fur: { light: '#fbe3c6', mark: '#7a3f22' },
  },
  { model: 'crowd-kid', species: 'human', hair: 'bun', top: 'tee', accessory: 'none', palette: { skin: '#ffe0cc', hair: '#4a3228', top: '#ffb59a', bottom: '#5f78b8', shoes: '#ff5a6a', accent: '#ff5a6a' } },
  {
    model: 'crowd-cat',
    species: 'cat',
    top: 'jacket',
    accessory: 'none',
    palette: { skin: '#a9a1a6', hair: NO_HAIR, top: '#a8c69a', bottom: '#4f5a7a', shoes: '#d9c3a5', accent: '#e9574a' },
    fur: { light: '#f2ede8', mark: '#6f666c' },
  },
];

/** The player's look: the cozy cast's "You", whose hair, top and trousers follow the viewer's colours. */
export const PLAYER_LOOK: PersonLook = { model: 'you', species: 'human', hair: 'tousled', top: 'hoodie', accessory: 'phone', palette: { ...PLAYER_PALETTE } };

/** The generic passer-by on the map when nobody else fits: the crowd's guy in a knit beanie, with his coffee. */
export const PASSERBY_LOOK: PersonLook = CROWD_LOOKS.find((l) => l.model === 'crowd-beanie')!;

/** A fresh copy of a role's look (palettes are mutable). */
export function castLook(role: 'player' | 'passerby'): PersonLook {
  const l = role === 'player' ? PLAYER_LOOK : PASSERBY_LOOK;
  return { ...l, palette: { ...l.palette }, fur: l.fur ? { ...l.fur } : undefined };
}

function hash(key: string): number {
  let h = 7;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

/** The crowd look a name (or any key) always gets. */
export function crowdLook(key: string): PersonLook {
  return CROWD_LOOKS[hash(key) % CROWD_LOOKS.length]!;
}

/** A fresh chibi spec for a look (palettes are mutable, so every spec gets its own copy). */
export function specOf(look: PersonLook, name: string, seed?: number): ChibiSpec {
  return {
    name,
    hair: look.hair ?? 'tousled',
    top: look.top,
    accessory: look.accessory,
    palette: { ...look.palette },
    species: look.species,
    fur: look.fur ? { ...look.fur } : undefined,
    seed,
  };
}

/** The look of a seeded user's avatar string, or a crowd look for anything else. */
export function lookOfAvatar(avatar: string | null | undefined, fallbackKey = avatar ?? ''): PersonLook {
  return (avatar && PEOPLE[avatar]) || crowdLook(fallbackKey);
}

/** The look of a user by id (demo users by their avatar; crowd ids get a crowd look). */
export function lookOfUser(userId: string): PersonLook {
  return lookOfAvatar(SEED_USERS.find((u) => u.id === userId)?.avatar, userId);
}

/** The demo user a name belongs to, as lines and offers carry names ("Wei", "Mia R."). */
export function userOfName(name: string): User | undefined {
  const first = name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return SEED_USERS.find((u) => u.displayName === name) ?? SEED_USERS.find((u) => u.displayName.split(/\s+/)[0]?.toLowerCase() === first);
}

/** The look of someone known only by name: demo users wear their own; any other name gets its crowd look. */
export function lookOfName(name: string): PersonLook {
  return lookOfAvatar(userOfName(name)?.avatar, name);
}

/** A seeded person's spec by avatar string (used by the characters page and tests). */
export function personSpec(avatar: string, seed?: number): ChibiSpec {
  return specOf(lookOfAvatar(avatar), avatar, seed ?? (hash(avatar) % 97) + 1);
}

/** A crowd look's spec by index. */
export function crowdSpec(index: number, seed?: number): ChibiSpec {
  return specOf(CROWD_LOOKS[index % CROWD_LOOKS.length]!, `crowd-${index}`, seed ?? 50 + index);
}
