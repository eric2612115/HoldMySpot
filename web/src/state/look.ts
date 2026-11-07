import { create } from 'zustand';
import type { ChibiPalette, PaletteSlot } from '../three/characters/chibi';
import { PLAYER_PALETTE } from '../three/characters/presets';

/** The player's colours. Kept per viewer in local storage (a convenience, not app data). */
const KEY = 'holdmyspot.look.v1';

function read(): ChibiPalette {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...PLAYER_PALETTE };
    const saved = JSON.parse(raw) as Partial<ChibiPalette>;
    return { ...PLAYER_PALETTE, ...saved };
  } catch {
    return { ...PLAYER_PALETTE };
  }
}

function write(p: ChibiPalette) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* Storage can be unavailable (private mode); colours just will not persist. */
  }
}

interface LookState {
  palette: ChibiPalette;
  setColor(slot: PaletteSlot, value: string): void;
  reset(): void;
}

export const useLook = create<LookState>()((set, get) => ({
  palette: read(),
  setColor(slot, value) {
    const palette = { ...get().palette, [slot]: value };
    write(palette);
    set({ palette });
  },
  reset() {
    write({ ...PLAYER_PALETTE });
    set({ palette: { ...PLAYER_PALETTE } });
  },
}));
