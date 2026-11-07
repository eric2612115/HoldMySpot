import { create } from 'zustand';
import { useMarket } from '../../state/market';

/**
 * Whose phone the demo shows: the requester's (asks and pays) or the
 * queuer's (stands in line and is paid). `?phone=queuer` opens on the
 * queuer's phone; the switch keeps the choice in the URL so a reload stays
 * on the same phone. The personas themselves are `?as=` and `?queuer=`.
 */
export type Phone = 'requester' | 'queuer';

function initialPhone(): Phone {
  return new URLSearchParams(window.location.search).get('phone') === 'queuer' ? 'queuer' : 'requester';
}

interface PhoneState {
  phone: Phone;
  pickerOpen: boolean;
  setPhone(phone: Phone): void;
  openPicker(open: boolean): void;
}

export const usePhone = create<PhoneState>()((set) => ({
  phone: initialPhone(),
  pickerOpen: false,
  setPhone(phone) {
    set({ phone });
    const url = new URL(window.location.href);
    url.searchParams.set('phone', phone);
    window.history.replaceState(window.history.state, '', url);
  },
  openPicker(open) {
    set({ pickerOpen: open });
  },
}));

/** Opens another person's phone. The server driver reads its personas once per page load, so this reloads. */
export function switchPerson(role: Phone, userId: string): void {
  const url = new URL(window.location.href);
  url.searchParams.set(role === 'requester' ? 'as' : 'queuer', userId);
  url.searchParams.set('phone', role);
  window.location.assign(url.toString());
}

/** True on the queuer's phone with the server: the task sheet is the queuer's. */
export function useQueuerPhone(): boolean {
  const backend = useMarket((s) => s.backend);
  const phone = usePhone((s) => s.phone);
  return backend === 'server' && phone === 'queuer';
}
