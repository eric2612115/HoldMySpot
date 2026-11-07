import { lookOfUser } from '../../three/characters/presets';
import { LookFace } from '../PersonFace';

/**
 * Round faces for the demo people: their portraits from the cozy cast, the
 * same characters the map shows (three/characters/presets.ts, by the avatar
 * each seeded user carries). The look follows the person's id, so a face
 * never changes; the role is kept for callers and does not change the face.
 */
export function PersonaFace({ id, size = 28 }: { id: string; role?: 'requester' | 'queuer'; size?: number }) {
  return <LookFace look={lookOfUser(id)} size={size} />;
}
