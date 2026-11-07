import { useId } from 'react';
import type { PersonLook } from '../three/characters/presets';

/**
 * A round badge of a person's face in the flat UI (chips, the people picker,
 * the money panel): the same species, fur, markings, hair and top colour as
 * their 3D character on the map. The badge's ring is their top.
 */

const EYE = '#2B2340';
const BLUSH = '#FF9DB4';
const PINK = '#F28CA8';
const NOSE = '#3A2B33';
const MOUTH = '#5A2E3A';

/** Mirrors an x coordinate across the face's centre line. */
const mx = (x: number) => 40 - x;

function Eyes({ y = 23.5, shine = 0.55 }: { y?: number; shine?: number }) {
  return (
    <>
      <ellipse cx="15.6" cy={y} rx="1.6" ry="2.2" fill={EYE} />
      <ellipse cx="24.4" cy={y} rx="1.6" ry="2.2" fill={EYE} />
      <circle cx="16.1" cy={y - 0.9} r={shine} fill="#FFFFFF" />
      <circle cx="24.9" cy={y - 0.9} r={shine} fill="#FFFFFF" />
    </>
  );
}

function Cheeks({ y = 27.6 }: { y?: number }) {
  return (
    <>
      <circle cx="12.6" cy={y} r="2.1" fill={BLUSH} opacity="0.7" />
      <circle cx="27.4" cy={y} r="2.1" fill={BLUSH} opacity="0.7" />
    </>
  );
}

/** The small "w" under an animal's nose. */
function AnimalMouth({ y = 29.2 }: { y?: number }) {
  return <path d={`M18.4 ${y}q0.8 0.9 1.6 0q0.8 0.9 1.6 0`} fill="none" stroke={MOUTH} strokeWidth="0.9" strokeLinecap="round" />;
}

function Human({ look }: { look: PersonLook }) {
  const { skin, hair, accent } = look.palette;
  const style = look.hair ?? 'tousled';
  return (
    <>
      {style === 'bun' && <circle cx="20" cy="8.6" r="4.6" fill={hair} />}
      {style === 'bob' && <path d="M7.4 27.5C6.4 15 11.5 9 20 9s13.6 6 12.6 18.5c-1.6 1-3.4 1-4.6 0.4V19H12v8.9c-1.2 0.6-3 0.6-4.6-0.4z" fill={hair} />}
      <ellipse cx="20" cy="22.5" rx="12" ry="11" fill={skin} />
      {style === 'tousled' && <path d="M8 20c0-8 5-12 12-12s12 4 12 12c-2-3-5-4-8-4-1 2-3 3-5 3 0-1 0-2-1-3-3 0-7 1-10 4z" fill={hair} />}
      {style === 'bun' && <path d="M8.2 20.5C8.5 12.6 13.4 9 20 9s11.5 3.6 11.8 11.5c-3.4-3.2-7.4-4.4-11.8-4.4S11.6 17.3 8.2 20.5z" fill={hair} />}
      {style === 'bob' && (
        <>
          <path d="M8.6 19.5C9.4 12.4 14 9.6 20 9.6s10.6 2.8 11.4 9.9c-3.6-1.8-7.4-2.6-11.4-2.6s-7.8 0.8-11.4 2.6z" fill={hair} />
          {/* Side locks run up into the fringe, as the 3D bob does (no gap that reads as earmuffs). */}
          <ellipse cx="9.4" cy="22.6" rx="2.5" ry="6.8" fill={hair} />
          <ellipse cx={mx(9.4)} cy="22.6" rx="2.5" ry="6.8" fill={hair} />
        </>
      )}
      {style === 'beanie' && (
        <>
          <path d="M8.2 22c0.4-1.8 1.4-3 2.6-3.6v5.2zM31.8 22c-0.4-1.8-1.4-3-2.6-3.6v5.2z" fill={hair} />
          <path d="M8 18.6C8 11 13.2 6.6 20 6.6S32 11 32 18.6z" fill={accent} />
          <rect x="7.4" y="16.4" width="25.2" height="3.6" rx="1.8" fill={accent} />
          <rect x="7.4" y="16.4" width="25.2" height="3.6" rx="1.8" fill="#000000" opacity="0.08" />
          <circle cx="20" cy="5.4" r="2.8" fill={accent} />
        </>
      )}
      <Eyes y={23} />
      <Cheeks />
      <path d="M18.5 28.5q1.5 1.4 3 0" fill="none" stroke={MOUTH} strokeWidth="1.2" strokeLinecap="round" />
    </>
  );
}

function Animal({ look, clip }: { look: PersonLook; clip: string }) {
  const fur = look.palette.skin;
  const light = look.fur?.light ?? '#FFF6EC';
  const mark = look.fur?.mark ?? '#5A3A2E';
  const mark2 = look.fur?.mark2 ?? mark;
  const pattern = look.fur?.pattern;
  const head = <ellipse cx="20" cy="23.5" rx="12.5" ry="11.5" fill={fur} />;
  const clipHead = `url(#${clip}-head)`;
  const headClip = (
    <clipPath id={`${clip}-head`}>
      <ellipse cx="20" cy="23.5" rx="12.5" ry="11.5" />
    </clipPath>
  );

  switch (look.species) {
    case 'bunny':
      return (
        <>
          {headClip}
          {[-1, 1].map((s) => (
            <g key={s} transform={`rotate(${s * 12} ${20 + s * 4.8} 9.5)`}>
              <ellipse cx={20 + s * 4.8} cy="9.5" rx="3.4" ry="8.6" fill={fur} />
              <ellipse cx={20 + s * 4.8} cy="10" rx="1.6" ry="6.2" fill={PINK} />
            </g>
          ))}
          {head}
          {/* A Dutch bunny's pale blaze, widening down to the muzzle. */}
          {pattern === 'dutch' && <path d="M20 13.2c1.4 0 2.2 3.8 2.8 8.4 0.4 3 2.8 4.6 2.8 6.6H14.4c0-2 2.4-3.6 2.8-6.6 0.6-4.6 1.4-8.4 2.8-8.4z" fill={light} clipPath={clipHead} />}
          <Eyes />
          <Cheeks />
          <ellipse cx="20" cy="28.6" rx="3.6" ry="2.5" fill={light} />
          <ellipse cx="20" cy="27.3" rx="1.2" ry="0.85" fill={PINK} />
          <AnimalMouth y={29.4} />
        </>
      );
    case 'cat': {
      // Viewer's left is the character's right: a calico's ginger ear and eye patch. A colour-point's
      // mask is centred on the nose. Nothing warm at the top right, where a bow would sit.
      const earL = pattern === 'calico' || pattern === 'points' ? mark : fur;
      const earR = pattern === 'calico' ? mark2 : pattern === 'points' ? mark : fur;
      const pads = pattern === 'points' ? mark : light;
      return (
        <>
          {headClip}
          <path d="M9.5 19L11.4 6.8 19 13.4z" fill={earL} />
          <path d={`M${mx(9.5)} 19L${mx(11.4)} 6.8 ${mx(19)} 13.4z`} fill={earR} />
          <path d="M11.6 16.6L12.5 10 16.6 13.8z" fill={PINK} />
          <path d={`M${mx(11.6)} 16.6L${mx(12.5)} 10 ${mx(16.6)} 13.8z`} fill={PINK} />
          {head}
          {pattern === 'calico' && (
            <g clipPath={clipHead}>
              <ellipse cx="13.5" cy="21.5" rx="6.5" ry="5.5" fill={mark} />
              <circle cx="30" cy="26" r="2" fill={mark2} />
            </g>
          )}
          {pattern === 'points' && <ellipse cx="20" cy="27.2" rx="8.6" ry="6.6" fill={mark} clipPath={clipHead} />}
          <Eyes />
          <Cheeks />
          <circle cx="18.2" cy="28.5" r="2.3" fill={pads} />
          <circle cx="21.8" cy="28.5" r="2.3" fill={pads} />
          <ellipse cx="20" cy="27" rx="1.15" ry="0.8" fill={PINK} />
          <path d="M16 27.8l-5.8-1M16 29.2l-5.6 0.9M24 27.8l5.8-1M24 29.2l5.6 0.9" stroke="#6B5B66" strokeWidth="0.6" strokeLinecap="round" />
        </>
      );
    }
    case 'dog':
      return (
        <>
          {headClip}
          {head}
          {pattern === 'blaze' && <ellipse cx="20" cy="16.5" rx="1.9" ry="5.4" fill={light} clipPath={clipHead} />}
          <Eyes />
          <Cheeks />
          <ellipse cx="20" cy="28.7" rx="5.3" ry="3.8" fill={light} />
          <ellipse cx="20" cy="26.7" rx="2.3" ry="1.6" fill={NOSE} />
          <path d="M18.3 29.5q1.7 1.4 3.4 0" fill="none" stroke={MOUTH} strokeWidth="0.9" strokeLinecap="round" />
          {/* Ears hang from the crown's edge and flare out. */}
          <ellipse cx="8.4" cy="21.4" rx="3.5" ry="7.6" fill={mark} transform="rotate(24 8.4 21.4)" />
          <ellipse cx={mx(8.4)} cy="21.4" rx="3.5" ry="7.6" fill={mark} transform={`rotate(-24 ${mx(8.4)} 21.4)`} />
        </>
      );
    case 'fox':
      return (
        <>
          {headClip}
          {[false, true].map((m) => {
            const x = (v: number) => (m ? mx(v) : v);
            return (
              <g key={String(m)}>
                <path d={`M${x(8.4)} 19L${x(10)} 3.6 ${x(18.6)} 12.6z`} fill={fur} />
                <path d={`M${x(10)} 3.6L${x(9.4)} 9.6 ${x(13.4)} 7.2z`} fill={mark} />
                <path d={`M${x(10.4)} 16.6L${x(11)} 8.8 ${x(16.4)} 13.2z`} fill={light} />
              </g>
            );
          })}
          {head}
          {/* Pale cheeks rising to the outer eye corners and a pale chin: the orange runs down the nose. */}
          <g clipPath={clipHead}>
            <ellipse cx="13.2" cy="28.6" rx="5.6" ry="3.3" fill={light} transform="rotate(28 13.2 28.6)" />
            <ellipse cx={mx(13.2)} cy="28.6" rx="5.6" ry="3.3" fill={light} transform={`rotate(-28 ${mx(13.2)} 28.6)`} />
            <ellipse cx="20" cy="32.8" rx="6.4" ry="3.6" fill={light} />
          </g>
          <ellipse cx="20" cy="28.4" rx="3.3" ry="2.5" fill={light} />
          <Eyes />
          <Cheeks />
          <ellipse cx="20" cy="26.9" rx="1.5" ry="1.05" fill={NOSE} />
          <AnimalMouth y={28.6} />
        </>
      );
    case 'squirrel':
      return (
        <>
          {/* The tall tail rises behind the head on the viewer's right; its curl stays inside the badge. */}
          <path d="M25 40C37 37 40.5 25 37.6 15.4 35.4 8.2 28.6 5.6 25.2 9.2c3.6 1.4 6 5.4 5.4 10.6C30 27 25.6 31.4 23 40z" fill={fur} stroke={mark} strokeWidth="0.9" strokeOpacity="0.55" />
          {[false, true].map((m) => {
            const x = (v: number) => (m ? mx(v) : v);
            return (
              <g key={String(m)}>
                {/* Tall tufts on tall ears, so the face reads as a squirrel even without the tail. */}
                <path d={`M${x(12.6)} 2.5L${x(10.6)} 10.5 ${x(14.6)} 10.5z`} fill={mark} />
                <ellipse cx={x(12.8)} cy="12.6" rx="2.6" ry="5" fill={fur} />
                <ellipse cx={x(12.8)} cy="13.2" rx="1.2" ry="2.9" fill={light} />
              </g>
            );
          })}
          {head}
          <Eyes />
          <Cheeks />
          <ellipse cx="20" cy="28.4" rx="3.8" ry="2.8" fill={light} />
          <ellipse cx="20" cy="27" rx="1.2" ry="0.85" fill={NOSE} />
          <AnimalMouth y={29.3} />
        </>
      );
    case 'raccoon':
      return (
        <>
          {headClip}
          {[false, true].map((m) => {
            const x = (v: number) => (m ? mx(v) : v);
            return (
              <g key={String(m)}>
                <circle cx={x(11.6)} cy="13.4" r="4.6" fill={light} />
                <circle cx={x(11.8)} cy="13.7" r="2.8" fill={mark} />
              </g>
            );
          })}
          {head}
          {/* A domino mask: two lobes drooping toward the cheeks, joined over the nose; two pale brow spots. */}
          <g clipPath={clipHead} fill={mark}>
            <ellipse cx="15.2" cy="24" rx="5" ry="3.3" transform="rotate(-20 15.2 24)" />
            <circle cx="11.6" cy="25.4" r="2.9" />
            <ellipse cx={mx(15.2)} cy="24" rx="5" ry="3.3" transform={`rotate(20 ${mx(15.2)} 24)`} />
            <circle cx={mx(11.6)} cy="25.4" r="2.9" />
            <ellipse cx="20" cy="22.4" rx="2.6" ry="1.4" />
          </g>
          <ellipse cx="15" cy="18.6" rx="2" ry="1.15" fill={light} transform="rotate(-8 15 18.6)" />
          <ellipse cx={mx(15)} cy="18.6" rx="2" ry="1.15" fill={light} transform={`rotate(8 ${mx(15)} 18.6)`} />
          <Eyes shine={0.8} />
          <Cheeks y={29.4} />
          <ellipse cx="20" cy="28.9" rx="4.6" ry="3" fill={light} />
          <ellipse cx="20" cy="27.2" rx="1.6" ry="1.1" fill={NOSE} />
          <AnimalMouth y={29.6} />
        </>
      );
    default:
      return <Human look={look} />;
  }
}

/** A person's face badge, `size` CSS pixels wide. */
export function LookFace({ look, size = 28 }: { look: PersonLook; size?: number }) {
  const clip = `face${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="person-face">
      <defs>
        <clipPath id={`${clip}-badge`}>
          <circle cx="20" cy="20" r="20" />
        </clipPath>
      </defs>
      <circle cx="20" cy="20" r="20" fill={look.palette.top} />
      <g clipPath={`url(#${clip}-badge)`}>{look.species === 'human' ? <Human look={look} /> : <Animal look={look} clip={clip} />}</g>
    </svg>
  );
}
