import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CastStage, type Motion } from '../three/castStage';
import type { PaletteSlot } from '../three/characters/chibi';
import { CAST, type CastRole } from '../three/characters/presets';
import { useLook } from '../state/look';
import { useMediaQuery } from '../ui/hooks';

const SWATCHES: Array<{ slot: PaletteSlot; label: string; colors: string[] }> = [
  { slot: 'hair', label: 'Hair', colors: ['#3B2F4A', '#1E1B18', '#6B4226', '#C68B59', '#E8C27A', '#8E7CC3'] },
  { slot: 'top', label: 'Top', colors: ['#6C5CE7', '#FF8FAB', '#3FB7A5', '#FFC53D', '#2E3A59', '#FFFFFF'] },
  { slot: 'bottom', label: 'Trousers', colors: ['#2E3A59', '#1F1F24', '#56688F', '#C9B79C', '#7A8B6F', '#E9D6BF'] },
];

export function CharactersPage() {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<CastStage | null>(null);
  const palette = useLook((s) => s.palette);
  const setColor = useLook((s) => s.setColor);
  const reset = useLook((s) => s.reset);
  const [motion, setMotion] = useState<Record<CastRole, Motion>>({ player: 'idle', queuer: 'walk', buyer: 'idle', passerby: 'walk' });

  useEffect(() => {
    if (!host.current) return;
    const s = new CastStage(host.current);
    stage.current = s;
    return () => {
      s.dispose();
      stage.current = null;
    };
  }, []);

  useEffect(() => {
    for (const [role, m] of Object.entries(motion) as [CastRole, Motion][]) stage.current?.setMotion(role, m);
  }, [motion]);

  useEffect(() => {
    stage.current?.setPlayerPalette(palette);
  }, [palette]);

  const allWalk = Object.values(motion).every((m) => m === 'walk');
  const touch = useMediaQuery('(pointer: coarse)');

  return (
    <div className="cast-page">
      <header className="cast-head">
        <Link to={`/${window.location.search}`} className="back-link">
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back to the map
        </Link>
        <div className="cast-head__title">
          <h1>The cast</h1>
          <p>Four original characters, built from simple shapes. Drag to look around, {touch ? 'pinch' : 'scroll'} to zoom.</p>
        </div>
        <button
          type="button"
          className="ghost-button cast-head__toggle"
          onClick={() => {
            const m: Motion = allWalk ? 'idle' : 'walk';
            setMotion({ player: m, queuer: m, buyer: m, passerby: m });
          }}
        >
          {allWalk ? 'Everyone idle' : 'Everyone walk'}
        </button>
      </header>

      <div className="cast-stage" ref={host} />

      <ul className="cast-cards">
        {CAST.map((c) => (
          <li key={c.role} className="cast-card">
            <h2>{c.title}</h2>
            <p>{c.blurb}</p>
            <div className="segmented" role="group" aria-label={`${c.title} animation`}>
              {(['idle', 'walk'] as Motion[]).map((m) => (
                <button key={m} type="button" aria-pressed={motion[c.role] === m} onClick={() => setMotion((s) => ({ ...s, [c.role]: m }))}>
                  {m === 'idle' ? 'Idle' : 'Walk'}
                </button>
              ))}
              <button type="button" onClick={() => stage.current?.hop(c.role)}>
                Hop
              </button>
            </div>
          </li>
        ))}
      </ul>

      <section className="look" aria-labelledby="look-title">
        <div className="look__head">
          <h2 id="look-title">Your colours</h2>
          <p>Match the player to a real outfit. The map uses the same colours.</p>
          <button type="button" className="text-button" onClick={reset}>
            Reset
          </button>
        </div>
        {SWATCHES.map(({ slot, label, colors }) => (
          <div key={slot} className="look__row">
            <span className="look__label">{label}</span>
            <div className="swatches" role="radiogroup" aria-label={label}>
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={palette[slot].toLowerCase() === c.toLowerCase()}
                  aria-label={`${label} ${c}`}
                  className="swatch"
                  style={{ background: c }}
                  onClick={() => setColor(slot, c)}
                />
              ))}
              <label className="swatch swatch--custom" title={`Pick any ${label.toLowerCase()} colour`}>
                <input type="color" value={palette[slot]} onChange={(e) => setColor(slot, e.target.value)} aria-label={`Custom ${label.toLowerCase()} colour`} />
              </label>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
