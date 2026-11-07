import { useEffect } from 'react';
import type { MapScene } from '../../map/mapScene';
import { useMarket } from '../../state/market';
import { ErrandSheet } from './ErrandSheet';
import { HandoverCode } from './HandoverCode';
import { usePhone } from './phone';
import { PersonPicker, PhoneSwitch } from './PhoneSwitch';
import { startQueuer } from './store';
import './queuer.css';

/**
 * Everything the queuer's half adds to the map page, with the server only
 * (the in-browser market has no claims or proofs): the phone switch, the
 * people picker, the errand sheet on the queuer's phone, and the handover
 * code on the requester's phone.
 */
export function QueuerLayer({ scene }: { scene: MapScene | null }) {
  const backend = useMarket((s) => s.backend);
  const persona = useMarket((s) => s.persona);
  const phone = usePhone((s) => s.phone);

  useEffect(() => {
    if (backend === 'server' && persona) void startQueuer(persona);
  }, [backend, persona]);

  // The page says whose phone it is, so screens shared by both (the task sheet) can drop the other person's part.
  useEffect(() => {
    if (backend !== 'server') return;
    document.documentElement.dataset.phone = phone;
    return () => {
      delete document.documentElement.dataset.phone;
    };
  }, [backend, phone]);

  if (backend !== 'server' || !persona) return null;
  return (
    <>
      <PhoneSwitch />
      {phone === 'queuer' ? <ErrandSheet scene={scene} /> : <HandoverCode />}
      <PersonPicker />
    </>
  );
}

