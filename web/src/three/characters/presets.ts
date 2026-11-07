import type { ChibiPalette, ChibiSpec } from './chibi';

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

/** Extra queuer looks so a line of people does not look cloned. */
export const QUEUER_VARIANTS: Array<Partial<ChibiSpec> & { palette: ChibiPalette }> = [
  { hair: 'bun', top: 'tee', accessory: 'tote', palette: { skin: '#F1C19C', hair: '#7A4A2E', top: '#FF8FAB', bottom: '#56688F', shoes: '#FFFFFF', accent: '#FFD166' } },
  { hair: 'tousled', top: 'hoodie', accessory: 'none', palette: { skin: '#E3A47E', hair: '#2A2236', top: '#57C4E5', bottom: '#3A3F5C', shoes: '#F4F4F4', accent: '#FFB4A2' } },
  { hair: 'bob', top: 'tee', accessory: 'phone', palette: { skin: '#FFE0CC', hair: '#B5651D', top: '#FFD166', bottom: '#4E5D94', shoes: '#FF8FAB', accent: '#FFFFFF' } },
  { hair: 'beanie', top: 'jacket', accessory: 'none', palette: { skin: '#9C6644', hair: '#1B1B1B', top: '#F28482', bottom: '#2F3E46', shoes: '#FFFFFF', accent: '#84A59D' } },
];
