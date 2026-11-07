import { lookOfUser } from '../../three/characters/presets';
import { LookFace } from '../PersonFace';

/**
 * Round chibi faces for the demo people, in the same species and colours as
 * their characters on the map (three/characters/presets.ts, by the avatar
 * each seeded user carries). The look follows the person's id, so a face
 * never changes; the role is kept for callers and does not change the face.
 */
export function PersonaFace({ id, size = 28 }: { id: string; role?: 'requester' | 'queuer'; size?: number }) {
  return <LookFace look={lookOfUser(id)} size={size} />;
}
