import { formatUsd } from '@holdmyspot/shared';
import type { Cents, ItemKind, LocalMoney } from '@holdmyspot/shared';

/** Small text helpers: money and unit wording, sentence clean-up, and name comparison for the eval. */

/** Uppercase, "&" as "AND", letters and digits only, single spaces. */
export function normalizeName(s: string): string {
  return s
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    prev = cur;
  }
  return prev[b.length] ?? 0;
}

/** 0..1: how alike two names are (best of an edit-distance ratio and word overlap). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const ca = na.replace(/ /g, '');
  const cb = nb.replace(/ /g, '');
  const edit = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return Math.max(edit, common / (ta.size + tb.size - common));
}

/** "$38.00", or "NT$1,680" for a receipt in TWD. */
export function formatLocal(m: LocalMoney): string {
  if (m.currency === 'USD') return formatUsd(m.minor, { exact: true });
  return `NT$${m.minor.toLocaleString('en-US')}`;
}

export function formatCents(c: Cents): string {
  return formatUsd(c, { exact: true });
}

const UNIT_WORDS: Readonly<Record<ItemKind, [string, string]>> = {
  cake: ['cake', 'cakes'],
  plush: ['plush', 'plush toys'],
  ramen: ['bowl', 'bowls'],
};

/** "2 cakes", "1 plush". */
export function units(n: number, kind: ItemKind): string {
  const [one, many] = UNIT_WORDS[kind];
  return `${n} ${n === 1 ? one : many}`;
}

/** "cake" or "cakes". */
export function unitWord(n: number, kind: ItemKind): string {
  const [one, many] = UNIT_WORDS[kind];
  return n === 1 ? one : many;
}

/**
 * Amounts a model wrote in cents ("1100 cents", "1,100 US cents", "50¢") as dollars ("$11.00"). The agents read
 * the market in integer cents, and a person reads their reasons, so code fixes the wording whatever the model wrote.
 */
export function centsAsDollars(text: string): string {
  return text.replace(/\b(\d{1,3}(?:,\d{3})+|\d+)\s?(?:US\s)?(?:cents?\b|¢)/gi, (_m, n: string) =>
    formatUsd(Number(n.replace(/,/g, '')), { exact: true }),
  );
}

/** First sentence, single line, at most `max` characters. Used on model-written reasons. */
export function oneSentence(text: string, max = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const m = /^(.+?[.!?])(\s|$)/.exec(flat);
  const s = m?.[1] ?? flat;
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}.` : s;
}
