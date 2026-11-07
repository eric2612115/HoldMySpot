import { SEED_USERS, type User } from '@holdmyspot/shared';
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
  skin: '#FFD8C0',
  hair: '#3B2F4A',
  top: '#6C5CE7',
  bottom: '#2E3A59',
  shoes: '#FFFFFF',
  accent: '#FFC53D',
};

/** Role archetypes: the player, and the generic walkers the map falls back to. */
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
 * A person's look. Humans have hair; animal-people have fur colours instead
 * and their main fur is `palette.skin`. Every look is original: the human
 * chibi body and our everyday clothes, with our own heads and tails.
 */
export interface PersonLook {
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
 * (shared/src/seed.ts). Mia and Wei, the film's leads, stay human; Wei wears
 * the colours the film's opening uses for the owner's avatar.
 */
export const PEOPLE: Record<string, PersonLook> = {
  // Requesters.
  'requester-mia': {
    species: 'human',
    hair: 'bob',
    top: 'jacket',
    accessory: 'phone',
    palette: { skin: '#F5CDB0', hair: '#2B2033', top: '#FF7BAC', bottom: '#3E4B7C', shoes: '#FFFFFF', accent: '#FFF3D6' },
  },
  'requester-jun': {
    species: 'cat',
    top: 'jacket',
    accessory: 'phone',
    palette: { skin: '#F6E9D7', hair: NO_HAIR, top: '#3D5A98', bottom: '#E9D6BF', shoes: '#8D6BE0', accent: '#FFF3D6' },
    fur: { light: '#FFFFFF', mark: '#8C6A55', pattern: 'points' },
  },
  'requester-priya': {
    species: 'human',
    hair: 'bun',
    top: 'tee',
    accessory: 'tote',
    palette: { skin: '#B97A56', hair: '#1F1A2B', top: '#FFB454', bottom: '#4E5D94', shoes: '#FFFFFF', accent: '#7FD6C2' },
  },
  'requester-sam': {
    species: 'human',
    hair: 'beanie',
    top: 'hoodie',
    accessory: 'none',
    palette: { skin: '#FFE0CC', hair: '#B5651D', top: '#57C4E5', bottom: '#3A3F5C', shoes: '#F4F4F4', accent: '#FFB4A2' },
  },
  'requester-noor': {
    species: 'human',
    hair: 'bob',
    top: 'jacket',
    accessory: 'tote',
    palette: { skin: '#8A5A3C', hair: '#2B1D16', top: '#B69CFF', bottom: '#2F3E46', shoes: '#FFFFFF', accent: '#FFF3D6' },
  },
  'requester-leo': {
    species: 'dog',
    top: 'tee',
    accessory: 'coffee',
    palette: { skin: '#8A5A3C', hair: NO_HAIR, top: '#FFC53D', bottom: '#3C4466', shoes: '#FFFFFF', accent: '#F45B69' },
    fur: { light: '#F3DCC2', mark: '#5A3524', pattern: 'blaze' },
  },
  // Queuers.
  'queuer-wei': {
    species: 'human',
    hair: 'tousled',
    top: 'hoodie',
    accessory: 'backpack',
    palette: { skin: '#F2C7A6', hair: '#30251F', top: '#E9B24A', bottom: '#3E4B7C', shoes: '#F6F2EA', accent: '#EC8571' },
  },
  'queuer-lin': {
    species: 'fox',
    top: 'hoodie',
    accessory: 'tote',
    palette: { skin: '#F08A45', hair: NO_HAIR, top: '#B69CFF', bottom: '#3A3F5C', shoes: '#FFFFFF', accent: '#FFD166' },
    fur: { light: '#FFF6EC', mark: '#5A3A2E' },
  },
  'queuer-rin': {
    species: 'cat',
    top: 'tee',
    accessory: 'phone',
    palette: { skin: '#FFF4E8', hair: NO_HAIR, top: '#1C9380', bottom: '#56688F', shoes: '#FFFFFF', accent: '#FFB4A2' },
    fur: { light: '#FFFFFF', mark: '#F0A055', mark2: '#6E4B3A', pattern: 'calico' },
  },
  'queuer-ava': {
    species: 'squirrel',
    top: 'jacket',
    accessory: 'coffee',
    palette: { skin: '#C2703D', hair: NO_HAIR, top: '#278F5F', bottom: '#4E5D94', shoes: '#FF8FAB', accent: '#FFFFFF' },
    fur: { light: '#FBE6CC', mark: '#7A3F22' },
  },
  'queuer-jo': {
    species: 'dog',
    top: 'hoodie',
    accessory: 'none',
    palette: { skin: '#E3B27E', hair: NO_HAIR, top: '#F06A5E', bottom: '#2E3A59', shoes: '#FFFFFF', accent: '#FFD166' },
    fur: { light: '#FFF3E0', mark: '#8E5A33' },
  },
  'queuer-rex': {
    species: 'raccoon',
    top: 'hoodie',
    accessory: 'backpack',
    palette: { skin: '#A3A2AF', hair: NO_HAIR, top: '#B54C6E', bottom: '#2F3E46', shoes: '#FFFFFF', accent: '#9BE3C9' },
    fur: { light: '#F4F1EA', mark: '#5B5566' },
  },
  'queuer-dana': {
    species: 'bunny',
    top: 'hoodie',
    accessory: 'tote',
    palette: { skin: '#C9946C', hair: NO_HAIR, top: '#FFD166', bottom: '#56688F', shoes: '#FFFFFF', accent: '#FF8FAB' },
    fur: { light: '#FFF0E0', mark: '#8B5A3C' },
  },
  'queuer-theo': {
    species: 'human',
    hair: 'tousled',
    top: 'jacket',
    accessory: 'coffee',
    palette: { skin: '#FFD8C0', hair: '#C68B59', top: '#2F3E46', bottom: '#C9B79C', shoes: '#FFFFFF', accent: '#84A59D' },
  },
  'queuer-mo': {
    species: 'human',
    hair: 'beanie',
    top: 'tee',
    accessory: 'phone',
    palette: { skin: '#9C6644', hair: '#1B1B1B', top: '#FF9248', bottom: '#3C4466', shoes: '#FFFFFF', accent: '#3FB7A5' },
  },
};

/**
 * Looks for everyone else (crowd requesters, people in a line who are not
 * demo users, walkers): half humans, half animal-people. A name always gets
 * the same look. Extras are a quieter tier: muted tops, and never a named
 * person's top colour, skin and hair pair, or the same species in a close fur
 * colour (presets.test.ts), so nobody seems to appear twice.
 */
export const CROWD_LOOKS: PersonLook[] = [
  { species: 'human', hair: 'bun', top: 'tee', accessory: 'tote', palette: { skin: '#F1C19C', hair: '#7A4A2E', top: '#D9A0AE', bottom: '#56688F', shoes: '#FFFFFF', accent: '#E8C77A' } },
  {
    // A Dutch bunny: chocolate with a pale blaze down the face.
    species: 'bunny',
    top: 'tee',
    accessory: 'tote',
    palette: { skin: '#6E4F42', hair: NO_HAIR, top: '#E6B59C', bottom: '#3A3F5C', shoes: '#FFFFFF', accent: '#9DC4B5' },
    fur: { light: '#FFF6EE', mark: '#4A332B', pattern: 'dutch' },
  },
  { species: 'human', hair: 'tousled', top: 'hoodie', accessory: 'none', palette: { skin: '#E3A47E', hair: '#6B4A35', top: '#8FA3C7', bottom: '#3A3F5C', shoes: '#F4F4F4', accent: '#E8B4A8' } },
  {
    // Black and white, with a pale blaze and muzzle.
    species: 'dog',
    top: 'jacket',
    accessory: 'phone',
    palette: { skin: '#3B3644', hair: NO_HAIR, top: '#C98B7B', bottom: '#2E3A59', shoes: '#F28482', accent: '#F2E3C6' },
    fur: { light: '#FFFFFF', mark: '#2A2530', pattern: 'blaze' },
  },
  { species: 'human', hair: 'bob', top: 'tee', accessory: 'phone', palette: { skin: '#F3C9A8', hair: '#B5651D', top: '#E59A8C', bottom: '#4E5D94', shoes: '#FF8FAB', accent: '#FFFFFF' } },
  {
    species: 'squirrel',
    top: 'hoodie',
    accessory: 'none',
    palette: { skin: '#A7A39E', hair: NO_HAIR, top: '#A3B98E', bottom: '#2F3E46', shoes: '#FFFFFF', accent: '#FFFFFF' },
    fur: { light: '#F7F3EE', mark: '#6F6A66' },
  },
  { species: 'human', hair: 'beanie', top: 'jacket', accessory: 'none', palette: { skin: '#C68A62', hair: '#3A2A22', top: '#A7B4C9', bottom: '#2F3E46', shoes: '#FFFFFF', accent: '#84A59D' } },
  {
    species: 'cat',
    top: 'tee',
    accessory: 'coffee',
    palette: { skin: '#9AA3B5', hair: NO_HAIR, top: '#D4B060', bottom: '#4E5D94', shoes: '#FFFFFF', accent: '#FF8FAB' },
    fur: { light: '#F4F6FA', mark: '#6E768A' },
  },
];

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
