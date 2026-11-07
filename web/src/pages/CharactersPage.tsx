import { SEED_USERS, type User } from '@holdmyspot/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CastStage, type Motion, type StageLayout, type StageMember } from '../three/castStage';
import type { PaletteSlot } from '../three/characters/chibi';
import { castLook, lookOfAvatar, SPECIES_NAMES, type PersonLook } from '../three/characters/presets';
import { useLook } from '../state/look';
import { useMediaQuery } from '../ui/hooks';
import { PlayerFace } from '../ui/ItemIcon';
import { LookFace } from '../ui/PersonFace';

const SWATCHES: Array<{ slot: PaletteSlot; label: string; colors: string[] }> = [
  { slot: 'hair', label: 'Hair', colors: ['#3B2F4A', '#1E1B18', '#6B4226', '#C68B59', '#E8C27A', '#8E7CC3'] },
  { slot: 'top', label: 'Top', colors: ['#6C5CE7', '#FF8FAB', '#3FB7A5', '#FFC53D', '#2E3A59', '#FFFFFF'] },
  { slot: 'bottom', label: 'Trousers', colors: ['#2E3A59', '#1F1F24', '#56688F', '#C9B79C', '#7A8B6F', '#E9D6BF'] },
];

const PLAYER = 'player';

/**
 * The group photo: front row first. Mia, Wei and you stand in the middle of the front row. Ava stands
 * last in the back row, so her tall tail rises over empty background instead of a face.
 */
const LAYOUT: StageLayout = {
  wide: [
    ['jo', 'rin', 'mia', PLAYER, 'wei', 'lin', 'mo', 'rex'],
    ['priya', 'dana', 'sam', 'jun', 'theo', 'leo', 'noor', 'ava'],
  ],
  narrow: [
    ['rin', 'mia', 'wei', 'lin'],
    ['mo', PLAYER, 'rex', 'jo'],
    ['dana', 'sam', 'jun', 'priya'],
    ['leo', 'theo', 'noor', 'ava'],
  ],
};

const CITY: Record<string, string> = { sf: 'San Francisco', nyc: 'New York' };

interface Person {
  id: string;
  name: string;
  look: PersonLook;
  line: string;
}

function personOf(u: User): Person {
  const look = lookOfAvatar(u.avatar, u.id);
  const role = u.roles.includes('queuer') ? `queues in ${CITY[u.cityId]}` : `asks from ${CITY[u.cityId]}`;
  return { id: u.id, name: u.displayName, look, line: `${SPECIES_NAMES[look.species]} · ${role}` };
}

export function CharactersPage() {
  const host = useRef<HTMLDivElement>(null);
  const stage = useRef<CastStage | null>(null);
  const palette = useLook((s) => s.palette);
  const setColor = useLook((s) => s.setColor);
  const reset = useLook((s) => s.reset);
  const [motion, setMotion] = useState<Record<string, Motion>>({});
  const [focus, setFocus] = useState<string | null>(null);
  const touch = useMediaQuery('(pointer: coarse)');

  const people = useMemo(() => SEED_USERS.map(personOf), []);
  const queuers = people.filter((p) => SEED_USERS.find((u) => u.id === p.id)?.roles.includes('queuer'));
  const requesters = people.filter((p) => !queuers.includes(p));
  const animals = people.filter((p) => p.look.species !== 'human').length;

  useEffect(() => {
    if (!host.current) return;
    const members: StageMember[] = [
      { id: PLAYER, look: castLook('player') },
      ...SEED_USERS.map((u) => ({ id: u.id, look: lookOfAvatar(u.avatar, u.id) })),
    ];
    const s = new CastStage(host.current, members, LAYOUT, (id) => {
      setFocus(id);
      s.hop(id);
    });
    s.setPalette(PLAYER, useLook.getState().palette);
    stage.current = s;
    return () => {
      s.dispose();
      stage.current = null;
    };
  }, []);

  useEffect(() => {
    for (const [id, m] of Object.entries(motion)) stage.current?.setMotion(id, m);
  }, [motion]);

  useEffect(() => {
    stage.current?.setPalette(PLAYER, palette);
  }, [palette]);

  useEffect(() => {
    stage.current?.focus(focus);
  }, [focus]);

  const ids = [PLAYER, ...people.map((p) => p.id)];
  const allWalk = ids.every((id) => motion[id] === 'walk');
  const meet = (id: string) => {
    setFocus(id);
    stage.current?.hop(id);
    host.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const focused = focus === PLAYER ? null : people.find((p) => p.id === focus);

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
          <p>
            {people.length + 1} original characters, {animals} of them animal-people, the soft plush cast of our film. Tap anyone to meet them; drag to look around, {touch ? 'pinch' : 'scroll'}{' '}
            to zoom.
          </p>
        </div>
        <button
          type="button"
          className="ghost-button cast-head__toggle"
          onClick={() => {
            const m: Motion = allWalk ? 'idle' : 'walk';
            setMotion(Object.fromEntries(ids.map((id) => [id, m])));
          }}
        >
          {allWalk ? 'Everyone idle' : 'Everyone walk'}
        </button>
      </header>

      <div className={`cast-stage${focus ? ' is-focused' : ''}`}>
        <div className="cast-stage__gl" ref={host} />
        {focus && (
          <div className="cast-meet" role="group" aria-label={`Meet ${focused?.name ?? 'you'}`}>
            <span className="cast-meet__face">{focused ? <LookFace look={focused.look} size={44} /> : <PlayerFace hair={palette.hair} skin={palette.skin} top={palette.top} size={44} />}</span>
            <span className="cast-meet__who">
              <b>{focused?.name ?? 'You'}</b>
              <small>{focused?.line ?? 'Human · your colours, below'}</small>
            </span>
            <div className="segmented cast-meet__moves" role="group" aria-label="Animation">
              {(['idle', 'walk'] as Motion[]).map((m) => (
                <button key={m} type="button" aria-pressed={(motion[focus] ?? 'idle') === m} onClick={() => setMotion((s) => ({ ...s, [focus]: m }))}>
                  {m === 'idle' ? 'Idle' : 'Walk'}
                </button>
              ))}
              <button type="button" onClick={() => stage.current?.hop(focus)}>
                Hop
              </button>
            </div>
            <button type="button" className="text-button cast-meet__back" onClick={() => setFocus(null)}>
              Everyone
            </button>
          </div>
        )}
      </div>

      <section className="cast-roster" aria-label="Who is who">
        {[
          { title: 'Queuers', list: queuers },
          { title: 'Requesters', list: requesters },
        ].map(({ title, list }) => (
          <div key={title} className="cast-roster__group">
            <h2>{title}</h2>
            <ul>
              {title === 'Queuers' && (
                <li>
                  <button type="button" className={`cast-person${focus === PLAYER ? ' is-on' : ''}`} onClick={() => meet(PLAYER)}>
                    <PlayerFace hair={palette.hair} skin={palette.skin} top={palette.top} size={38} />
                    <span>
                      <b>You</b>
                      <small>Human · walks the map</small>
                    </span>
                  </button>
                </li>
              )}
              {list.map((p) => (
                <li key={p.id}>
                  <button type="button" className={`cast-person${focus === p.id ? ' is-on' : ''}`} onClick={() => meet(p.id)}>
                    <LookFace look={p.look} size={38} />
                    <span>
                      <b>{p.name}</b>
                      <small>{p.line}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

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
