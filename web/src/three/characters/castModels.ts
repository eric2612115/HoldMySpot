/**
 * The cozy cast: the soft plush people of the HoldMySpot film, baked into one
 * small skinned model each (web/public/models/cast/<id>.glb). Every vertex of
 * a model belongs to one joint (hips, spine, neck, head, shoulders, elbows,
 * wrists, legs, knees, ankles, tail, ears, ponytails), so the app moves the
 * same joints the film poses. Each model has two face atlases (neutral, blink
 * and happy side by side): `faces/<id>-stage.webp` with the film's faces, and
 * `faces/<id>-map.webp`, smaller and without lashes, for the map. The round face
 * badges in the flat UI come from `portraits.webp`, one 128 px cell per model
 * in the order below. Faces and portraits are WebP.
 */

/** Every baked model, in the order of the portrait sheet (8 to a row). */
export const CAST_MODELS = [
  'you',
  'mia',
  'wei',
  'lin',
  'rex',
  'priya',
  'jun',
  'sam',
  'noor',
  'leo',
  'rin',
  'ava',
  'jo',
  'dana',
  'theo',
  'mo',
  'crowd-grandpa',
  'crowd-curls',
  'crowd-beanie',
  'crowd-kid',
  'crowd-cat',
  'crowd-dog',
  'crowd-bunny',
  'crowd-squirrel',
] as const;

export type CastModel = (typeof CAST_MODELS)[number];

export const PORTRAIT_COLUMNS = 8;
export const PORTRAIT_ROWS = Math.ceil(CAST_MODELS.length / PORTRAIT_COLUMNS);
/** Pixel size of one portrait cell in portraits.webp. */
export const PORTRAIT_CELL = 128;

/** The face atlases' cells, left to right. */
export const FACE_CELLS = ['neutral', 'blink', 'happy'] as const;
export type FaceCell = (typeof FACE_CELLS)[number];

/** Where a model's portrait sits in portraits.webp (column and row). */
export function portraitCell(model: CastModel): { col: number; row: number } {
  const i = CAST_MODELS.indexOf(model);
  if (i < 0) throw new Error(`Unknown cast model ${model}`);
  return { col: i % PORTRAIT_COLUMNS, row: Math.floor(i / PORTRAIT_COLUMNS) };
}

/** URL of a file in public/models/cast. */
export function castUrl(file: string): string {
  return `${import.meta.env.BASE_URL}models/cast/${file}`;
}

export const modelUrl = (model: CastModel) => castUrl(`${model}.glb`);
export const faceUrl = (model: CastModel, set: 'stage' | 'map') => castUrl(`faces/${model}-${set}.webp`);
export const PORTRAITS_URL = castUrl('portraits.webp');

type R3 = [number, number, number];

/** What the bake stores in each model's root node (glTF extras). */
export interface CastMeta {
  id: CastModel;
  name: string;
  kind: 'human' | 'bunny' | 'cat' | 'dog' | 'fox' | 'squirrel' | 'raccoon';
  /** The figure's own scale (already in the model). */
  scale: number;
  /** Top of the tallest part (hair, ears, tail) in model units, feet at 0. */
  height: number;
  width: number;
  /** Head centre in the bind pose: the face is projected from here by angle. */
  headCenter: R3;
  /** Longitude and latitude spans the face atlas covers (radians). */
  faceSpan: [number, number];
  faces: string[];
  /** The one thing held on the map. */
  prop: 'phone' | 'coffee' | 'boba' | 'strap' | null;
  /** Arms that hold it (they keep the hold pose while walking). */
  heldArms: Array<'L' | 'R'>;
  /** Local joint rotations (and shoulder positions) of the hold. */
  hold: Record<string, { r: R3; order: string; t?: R3 }>;
  /** Models whose hair, top and trousers are recoloured live (the player): their base colours. */
  tint: { hair: string; top: string; bottom: string } | null;
  colors: { skin: string; hair: string | null; top: string; bottom: string; shoes: string };
  /** Positions are 16-bit in the model's box: bind position = stored * half + centre. */
  dequant: { centre: R3; half: number };
}

/** Vertex slots in the model's `_DATA` attribute (x). */
export const SLOT = { plain: 0, face: 1, hair: 2, top: 3, bottom: 4, prop: 5 } as const;
