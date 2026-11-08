import type { User } from '@holdmyspot/shared';
import { useMarket } from '../../state/market';
import { params } from '../../state/services';
import { PersonaFace } from './faces';
import { firstName } from './logic';
import { switchPerson, usePhone } from './phone';
import { useQueuer } from './store';

/**
 * The demo's two phones: the requester who asks and pays, and the queuer who
 * stands in line and is paid. One tap swaps phones; "Switch people" picks
 * other demo users (GET /api/users).
 */
export function PhoneSwitch() {
  const persona = useMarket((s) => s.persona);
  const phone = usePhone((s) => s.phone);
  const setPhone = usePhone((s) => s.setPhone);
  const openPicker = usePhone((s) => s.openPicker);
  if (!persona || params.solo) return null;
  return (
    <div className="q-switch" role="group" aria-label="Whose phone">
      <button type="button" className={`q-switch__side${phone === 'requester' ? ' is-on' : ''}`} aria-pressed={phone === 'requester'} onClick={() => setPhone('requester')}>
        <PersonaFace id={persona.requesterId} role="requester" size={26} />
        <span>
          <b>{firstName(persona.requesterName)}</b>
          <small>asks</small>
        </span>
      </button>
      <button type="button" className={`q-switch__side${phone === 'queuer' ? ' is-on' : ''}`} aria-pressed={phone === 'queuer'} onClick={() => setPhone('queuer')}>
        <PersonaFace id={persona.queuerId} role="queuer" size={26} />
        <span>
          <b>{firstName(persona.queuerName)}</b>
          <small>queues</small>
        </span>
      </button>
      <button type="button" className="q-switch__more" onClick={() => openPicker(true)} aria-label="Switch people" title="Switch people">
        <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M4 7h11l-3-3M16 13H5l3 3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

function Row({ user, role, current }: { user: User; role: 'requester' | 'queuer'; current: boolean }) {
  const city = user.cityId === 'sf' ? 'San Francisco' : 'New York';
  return (
    <li>
      <button type="button" className={`q-people__row${current ? ' is-current' : ''}`} onClick={() => switchPerson(role, user.id)} disabled={current}>
        <PersonaFace id={user.id} role={role} size={34} />
        <span className="q-people__who">
          <b>{user.displayName}</b>
          <small>
            {city}
            {role === 'queuer' && user.reliability ? ` · reliability ${user.reliability.score}` : ''}
          </small>
        </span>
        <span className="q-people__go">{current ? 'This phone' : 'Open'}</span>
      </button>
    </li>
  );
}

export function PersonPicker() {
  const open = usePhone((s) => s.pickerOpen);
  const openPicker = usePhone((s) => s.openPicker);
  const users = useQueuer((s) => s.users);
  const persona = useMarket((s) => s.persona);
  const city = params.city.id;
  const queuers = users.filter((u) => u.roles.includes('queuer') && u.cityId === city);
  const requesters = users.filter((u) => u.roles.includes('requester'));
  return (
    <div className={`q-people${open ? ' is-open' : ''}`} role="dialog" aria-modal="true" aria-label="Switch people" aria-hidden={!open} onClick={() => openPicker(false)}>
      <div className="q-people__card" onClick={(e) => e.stopPropagation()}>
        <header className="q-people__head">
          <div>
            <h2>Whose phone?</h2>
            <p>Demo people from the server. Each phone sees only its own codes and money.</p>
          </div>
          <button type="button" className="close-button" onClick={() => openPicker(false)} aria-label="Close">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
            </svg>
          </button>
        </header>
        <h3>Queuers near {params.city.area}</h3>
        <ul className="q-people__list">
          {queuers.map((u) => (
            <Row key={u.id} user={u} role="queuer" current={u.id === persona?.queuerId} />
          ))}
        </ul>
        <h3>Requesters</h3>
        <ul className="q-people__list">
          {requesters.map((u) => (
            <Row key={u.id} user={u} role="requester" current={u.id === persona?.requesterId} />
          ))}
        </ul>
      </div>
    </div>
  );
}
