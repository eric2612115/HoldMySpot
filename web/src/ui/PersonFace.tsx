import { useId } from 'react';
import { PORTRAIT_COLUMNS, PORTRAIT_ROWS, PORTRAITS_URL, portraitCell, type CastModel } from '../three/characters/castModels';
import type { PersonLook } from '../three/characters/presets';

/**
 * A round badge of a person's face in the flat UI (chips, the people picker,
 * the money panel): their portrait from the cozy cast, rendered from the same
 * model the map and the characters page show (one sprite sheet for everyone),
 * on a disc in their top colour.
 */
export function CastFace({ model, top, size = 28 }: { model: CastModel; top: string; size?: number }) {
  const clip = `face${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const { col, row } = portraitCell(model);
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true" className="person-face">
      <defs>
        <clipPath id={clip}>
          <circle cx="20" cy="20" r="20" />
        </clipPath>
      </defs>
      <circle cx="20" cy="20" r="20" fill={top} />
      <circle cx="20" cy="20" r="20" fill="#FFFFFF" opacity="0.38" />
      <g clipPath={`url(#${clip})`}>
        <image href={PORTRAITS_URL} x={-col * 40} y={-row * 40} width={PORTRAIT_COLUMNS * 40} height={PORTRAIT_ROWS * 40} preserveAspectRatio="none" />
      </g>
    </svg>
  );
}

/** A person's face badge, `size` CSS pixels wide. */
export function LookFace({ look, size = 28 }: { look: PersonLook; size?: number }) {
  return <CastFace model={look.model} top={look.palette.top} size={size} />;
}
