import type { ItemLook } from '../domain/types';

/** Flat, original item illustrations for lists, dots and the sheet header. */
export function ItemIcon({ look, size = 56 }: { look: ItemLook; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true" className="item-icon">
      {look === 'cake' && (
        <g strokeLinejoin="round" strokeLinecap="round">
          <ellipse cx="32" cy="50" rx="24" ry="5" fill="#FFFFFF" stroke="#C9C3E6" strokeWidth="2" />
          <path d="M14 30h36v16c0 3-8 5-18 5s-18-2-18-5z" fill="#FFF6EC" stroke="#E2CDB8" strokeWidth="2" />
          <path d="M14 30c0-3 8-5 18-5s18 2 18 5v4c-2 0-2 4-4 4s-2-4-4-4-2 5-4 5-2-5-4-5-2 4-4 4-2-4-4-4-2 5-4 5-2-5-4-5-2 3-4 3z" fill="#FF9EBB" stroke="#E86A92" strokeWidth="2" />
          <circle cx="24" cy="23" r="4.5" fill="#FF4D6D" stroke="#C9304F" strokeWidth="2" />
          <circle cx="40" cy="23" r="4.5" fill="#FF4D6D" stroke="#C9304F" strokeWidth="2" />
          <circle cx="32" cy="19" r="5" fill="#FF4D6D" stroke="#C9304F" strokeWidth="2" />
          <path d="M30 14l2 3 2-3" fill="none" stroke="#3FA34D" strokeWidth="2" />
        </g>
      )}
      {look === 'bunny' && (
        <g strokeLinejoin="round" strokeLinecap="round">
          {/* Sakura mochi: a pale pink bunny with a small cream muzzle (never a face framed like a hood), the cast's eyes and "w" mouth, a blossom on a ribbon at the neck. */}
          <ellipse cx="23" cy="17" rx="6" ry="14" fill="#FFD9E2" stroke="#E6AFBF" strokeWidth="2" transform="rotate(-10 23 17)" />
          <ellipse cx="23" cy="18" rx="2.8" ry="9.5" fill="#FFB0C4" transform="rotate(-10 23 18)" />
          <ellipse cx="41" cy="17" rx="6" ry="14" fill="#FFD9E2" stroke="#E6AFBF" strokeWidth="2" transform="rotate(12 41 17)" />
          <ellipse cx="41" cy="18" rx="2.8" ry="9.5" fill="#FFB0C4" transform="rotate(12 41 18)" />
          <ellipse cx="32" cy="40" rx="18" ry="16" fill="#FFD9E2" stroke="#E6AFBF" strokeWidth="2" />
          <ellipse cx="32" cy="45.3" rx="5.6" ry="3.9" fill="#FFF6EC" />
          <ellipse cx="25.5" cy="40" rx="2" ry="2.6" fill="#2B2340" />
          <ellipse cx="38.5" cy="40" rx="2" ry="2.6" fill="#2B2340" />
          <circle cx="26.2" cy="38.9" r="0.8" fill="#FFFFFF" />
          <circle cx="39.2" cy="38.9" r="0.8" fill="#FFFFFF" />
          <ellipse cx="21" cy="46" rx="3.2" ry="2" fill="#FF9DB4" opacity="0.8" />
          <ellipse cx="43" cy="46" rx="3.2" ry="2" fill="#FF9DB4" opacity="0.8" />
          <ellipse cx="32" cy="44" rx="1.5" ry="1.1" fill="#FF8FA8" />
          <path d="M29.6 46q1.2 1.3 2.4 0q1.2 1.3 2.4 0" fill="none" stroke="#7A3F52" strokeWidth="1.5" />
          <path d="M19 55.5q13 6 26 0" fill="none" stroke="#7CC88A" strokeWidth="4" />
          {[0, 1, 2, 3, 4].map((i) => (
            <circle key={i} cx={39.5 + Math.cos((i / 5) * Math.PI * 2 - Math.PI / 2) * 2.2} cy={57.6 + Math.sin((i / 5) * Math.PI * 2 - Math.PI / 2) * 2.2} r="1.9" fill="#FF8FB8" />
          ))}
          <circle cx="39.5" cy="57.6" r="1.2" fill="#F7C948" />
        </g>
      )}
      {look === 'cat' && (
        <g strokeLinejoin="round" strokeLinecap="round">
          <path d="M14 26 L18 8 L28 20 Z" fill="#FFFFFF" stroke="#D9D2C4" strokeWidth="2" />
          <path d="M50 26 L46 8 L36 20 Z" fill="#FFFFFF" stroke="#D9D2C4" strokeWidth="2" />
          <path d="M17 22 L19 13 L24 19 Z" fill="#FFB3C1" />
          <path d="M47 22 L45 13 L40 19 Z" fill="#FFB3C1" />
          <ellipse cx="32" cy="36" rx="19" ry="17" fill="#FFFFFF" stroke="#D9D2C4" strokeWidth="2" />
          <ellipse cx="25.5" cy="34" rx="2" ry="2.6" fill="#2B2340" />
          <ellipse cx="38.5" cy="34" rx="2" ry="2.6" fill="#2B2340" />
          <circle cx="26.2" cy="32.9" r="0.8" fill="#FFFFFF" />
          <circle cx="39.2" cy="32.9" r="0.8" fill="#FFFFFF" />
          <ellipse cx="32" cy="38.6" rx="1.4" ry="1" fill="#FF9DB4" />
          <path d="M29.6 40.6q1.2 1.3 2.4 0q1.2 1.3 2.4 0" fill="none" stroke="#7A3F52" strokeWidth="1.5" />
          <path d="M18 50q14 7 28 0" fill="none" stroke="#E5484D" strokeWidth="4" />
          <circle cx="32" cy="54" r="3.6" fill="#F7C948" stroke="#B5891A" strokeWidth="1.5" />
        </g>
      )}
      {look === 'otter' && (
        <g strokeLinejoin="round" strokeLinecap="round">
          {/* An otter, not a bear: a wide flat head, tiny ears low on the sides, a pale muzzle with whiskers. */}
          <ellipse cx="12.5" cy="31" rx="3.8" ry="3.4" fill="#8A5A3C" stroke="#66402A" strokeWidth="2" />
          <ellipse cx="51.5" cy="31" rx="3.8" ry="3.4" fill="#8A5A3C" stroke="#66402A" strokeWidth="2" />
          <ellipse cx="32" cy="35" rx="21" ry="15.5" fill="#9C6B47" stroke="#66402A" strokeWidth="2" />
          <path d="M15.5 39c4-9 29-9 33 0-2 8-8 11.5-16.5 11.5S17.5 47 15.5 39z" fill="#F4E2CC" />
          <ellipse cx="24.5" cy="31.5" rx="2.1" ry="2.5" fill="#2A1C14" />
          <ellipse cx="39.5" cy="31.5" rx="2.1" ry="2.5" fill="#2A1C14" />
          <ellipse cx="32" cy="38" rx="3.8" ry="2.5" fill="#3A2418" />
          <path d="M28.5 42q3.5 2.6 7 0" fill="none" stroke="#3A2418" strokeWidth="1.6" />
          <circle cx="25" cy="41" r="0.9" fill="#8A6A55" />
          <circle cx="23" cy="43" r="0.9" fill="#8A6A55" />
          <circle cx="39" cy="41" r="0.9" fill="#8A6A55" />
          <circle cx="41" cy="43" r="0.9" fill="#8A6A55" />
          <path d="M21 41.5l-9-2.5M21 44l-9 1.5M43 41.5l9-2.5M43 44l9 1.5" fill="none" stroke="#7A5A47" strokeWidth="1.2" />
          <path d="M17 56q15 5 30 0" fill="none" stroke="#6FC3E8" strokeWidth="4" />
        </g>
      )}
      {look === 'pup' && (
        <g strokeLinejoin="round" strokeLinecap="round">
          <ellipse cx="15" cy="32" rx="6" ry="12" fill="#B88763" stroke="#8C6446" strokeWidth="2" transform="rotate(18 15 32)" />
          <ellipse cx="49" cy="32" rx="6" ry="12" fill="#B88763" stroke="#8C6446" strokeWidth="2" transform="rotate(-18 49 32)" />
          <ellipse cx="32" cy="34" rx="18" ry="17" fill="#F4E3C8" stroke="#CDB28C" strokeWidth="2" />
          <ellipse cx="32" cy="41" rx="9" ry="6.5" fill="#FFF8F2" />
          <ellipse cx="25" cy="32" rx="2" ry="2.6" fill="#3A2B33" />
          <ellipse cx="39" cy="32" rx="2" ry="2.6" fill="#3A2B33" />
          <ellipse cx="32" cy="38" rx="2.8" ry="2" fill="#3A2B33" />
          <path d="M19 52q13 6 26 0" fill="none" stroke="#A78BFA" strokeWidth="4" />
        </g>
      )}
      {look === 'ramen' && (
        <g strokeLinejoin="round" strokeLinecap="round">
          <path d="M10 30h44c0 13-10 22-22 22S10 43 10 30z" fill="#2B2A33" stroke="#1A1A20" strokeWidth="2" />
          <ellipse cx="32" cy="30" rx="22" ry="6" fill="#F2C77D" stroke="#C9433B" strokeWidth="2" />
          <path d="M16 31q3-3 6 0t6 0 6 0 6 0 6 0" fill="none" stroke="#FFE08A" strokeWidth="2" />
          <circle cx="24" cy="28" r="3.6" fill="#FFFFFF" />
          <circle cx="24" cy="28" r="1.8" fill="#F6A623" />
          <ellipse cx="37" cy="27.5" rx="5" ry="2.6" fill="#C97B5A" />
          <rect x="43" y="20" width="5" height="8" rx="1" fill="#2D4A2B" transform="rotate(10 45 24)" />
          <path d="M14 18 L50 26M16 15 L52 23" stroke="#D9A66B" strokeWidth="2.4" />
          <rect x="24" y="40" width="16" height="5" rx="2" fill="#FFB454" />
        </g>
      )}
    </svg>
  );
}

/** Tiny round face of the player, used as the avatar in the top bar. */
export function PlayerFace({ hair, skin, top, size = 34 }: { hair: string; skin: string; top: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="20" fill={top} />
      <ellipse cx="20" cy="22" rx="12" ry="11" fill={skin} />
      <path d="M8 20c0-8 5-12 12-12s12 4 12 12c-2-3-5-4-8-4-1 2-3 3-5 3 0-1 0-2-1-3-3 0-7 1-10 4z" fill={hair} />
      <ellipse cx="15.5" cy="23" rx="1.6" ry="2.2" fill="#2B2340" />
      <ellipse cx="24.5" cy="23" rx="1.6" ry="2.2" fill="#2B2340" />
      <circle cx="13" cy="27" r="2" fill="#FF9DB4" opacity="0.7" />
      <circle cx="27" cy="27" r="2" fill="#FF9DB4" opacity="0.7" />
      <path d="M18.5 28.5q1.5 1.4 3 0" fill="none" stroke="#5A2E3A" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}
