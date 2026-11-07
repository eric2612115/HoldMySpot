import { create } from 'zustand';

/** Where the book was opened from: the requester's shop sheet, a queuer's task card, a map label, or a link (`?book=`). */
export type BookEntry = 'sheet' | 'task' | 'label' | 'link';

interface BookState {
  /** The item whose order book is open over the map, or null. */
  itemId: string | null;
  from: BookEntry | null;
  open(itemId: string, from: BookEntry): void;
  close(): void;
}

/** `?book=<itemId>` opens that item's book as soon as the market has loaded (for demos and recordings). */
function fromUrl(): string | null {
  try {
    return new URLSearchParams(window.location.search).get('book') || null;
  } catch {
    return null;
  }
}

const initial = fromUrl();

export const useBook = create<BookState>()((set) => ({
  itemId: initial,
  from: initial ? 'link' : null,
  open: (itemId, from) => set({ itemId, from }),
  close: () => set({ itemId: null, from: null }),
}));

export function openBook(itemId: string, from: BookEntry): void {
  useBook.getState().open(itemId, from);
}
