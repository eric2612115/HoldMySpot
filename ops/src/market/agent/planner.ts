import type { AgAiEvent, AgAiMessage, AgAiRunInput, AgStudioApi } from 'ag-studio';
import type { MarketSnapshot } from '../../data/backend.ts';
import { W } from '../../data/vocab.ts';
import { DEPTH_LADDER, GAP_SPOTLIGHT } from '../widgets/defs.ts';
import { breakdownSpec } from './breakdown.ts';
import { marketFacts, otherTopicsNote, shopIn, topicFacts, topicOf } from './facts.ts';
import type { Topic } from './facts.ts';

/**
 * The market desk's offline planner (no model): it maps a question to one of
 * the read_market topics by keywords, calls read_market, builds a widget for
 * the gap and depth questions through Studio's own tools, and answers with
 * the tool's sentences. Studio runs every call and shows each step, exactly
 * as with a model (clientToolRunner). The UI labels it "offline planner".
 */

export const PLACEHOLDER_ID = 'w-desk-note';

/** Field mapping for the spotlight, as Studio's configure_widget tool expects it. */
export const SPOTLIGHT_MAPPING = {
  shop: [{ id: 'shops.shop' }],
  bestBid: [{ id: 'books.bestBidUsd', aggregation: 'max' }],
  bestAsk: [{ id: 'books.bestAskUsd', aggregation: 'min' }],
  bidDepth: [{ id: 'books.bidQty', aggregation: 'sum' }],
  askDepth: [{ id: 'books.askCapacity', aggregation: 'sum' }],
  askBy: [{ id: 'books.askBy' }],
  askNote: [{ id: 'books.askNote' }],
  nextStep: [{ id: 'books.nextStep' }],
  nextAsk: [{ id: 'books.nextAskUsd', aggregation: 'min' }],
};

let seq = 0;
export const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    });
  });

async function* say(text: string, signal?: AbortSignal): AsyncGenerator<AgAiEvent> {
  const messageId = nextId('msg');
  yield { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' };
  for (const chunk of text.match(/\S+\s*/g) ?? [text]) {
    if (signal?.aborted) break;
    yield { type: 'TEXT_MESSAGE_CONTENT', messageId, delta: chunk };
    await sleep(10, signal);
  }
  yield { type: 'TEXT_MESSAGE_END', messageId };
}

function* call(name: string, args: Record<string, unknown>): Generator<AgAiEvent> {
  const toolCallId = nextId('call');
  yield { type: 'TOOL_CALL_START', toolCallId, toolCallName: name };
  yield { type: 'TOOL_CALL_ARGS', toolCallId, delta: JSON.stringify(args) };
  yield { type: 'TOOL_CALL_END', toolCallId };
}

/** The arguments of the latest call to `name` in this turn, if any. */
function argsOf(messages: AgAiMessage[], name: string): Record<string, unknown> | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user') break;
    if (m?.role !== 'assistant') continue;
    const c = [...(m.toolCalls ?? [])].reverse().find((x) => x.function.name === name);
    if (c) {
      try {
        return JSON.parse(c.function.arguments) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** The question of this turn and the results already in, by tool name. */
function turnState(messages: AgAiMessage[]): { user: string; done: string[]; results: Record<string, string> } {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') last = i;
  });
  const user = last >= 0 ? (messages[last] as { content: string }).content : '';
  const tail = messages.slice(last + 1);
  const byCall = new Map(tail.filter((m) => m.role === 'tool').map((m) => [(m as { toolCallId: string }).toolCallId, (m as { content: string }).content]));
  const done: string[] = [];
  const results: Record<string, string> = {};
  for (const m of tail) {
    if (m.role !== 'assistant') continue;
    for (const c of m.toolCalls ?? []) {
      if (!byCall.has(c.id)) continue;
      done.push(c.function.name);
      results[c.function.name] = byCall.get(c.id) ?? '';
    }
  }
  return { user, done, results };
}

interface Slot {
  xTrack: number;
  yTrack: number;
  xSpan: number;
  ySpan: number;
}

/** Where an answer widget goes: the placeholder's slot if it is still there, else a free row at the bottom. */
export function slotFor(api: AgStudioApi): { slot: Slot; replace: string | null } {
  const state = api.getState();
  const page = state.pages.find((p) => p.id === state.selectedPageId) ?? state.pages[0];
  const layout = (page?.widgetLayout ?? {}) as Record<string, Slot | undefined>;
  const placeholder = layout[PLACEHOLDER_ID];
  if (placeholder) return { slot: placeholder, replace: PLACEHOLDER_ID };
  const bottom = Math.max(0, ...Object.values(layout).map((l) => (l ? l.yTrack + l.ySpan : 0)));
  return { slot: { xTrack: 0, yTrack: bottom, xSpan: 10, ySpan: 19 }, replace: null };
}

/** The text a tool result carries (Studio sends the tool's response string, sometimes wrapped in JSON). */
function resultText(raw: string | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw) as { response?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.response === 'string') return parsed.response;
  } catch {
    // plain text
  }
  return raw;
}

const HELP = `I am the offline planner: no AI model is connected, so I answer fixed topics with the same numbers the dashboard shows. Ask about holds and releases, captures, payouts, fill rates, fee-clock step-downs, disputes and failed captures, the ${W.widestSpread}, the ${W.depth.toLowerCase()} at a shop, or queuer earnings.`;

/** One turn of the offline planner, decided from what has run so far. */
export async function* planTurn(input: AgAiRunInput, signal: AbortSignal | undefined, api: AgStudioApi, getSnapshot: () => MarketSnapshot): AsyncGenerator<AgAiEvent> {
  const { user, done, results } = turnState(input.messages);
  const topic: Topic | 'help' = topicOf(user);
  const shop = shopIn(getSnapshot(), user);
  await sleep(200, signal);

  // "Only Paper Moon", "filter to ...", "show all shops": the page filter, through our filter_shop tool.
  const wantsFilter = /\b(only|filter|just)\b/i.test(user) && !!shop;
  const clears = /\b(all shops|every shop|clear the filter|remove the filter)\b/i.test(user);
  if ((wantsFilter || clears) && !done.includes('filter_shop')) {
    yield* call('filter_shop', { shop: clears ? 'all' : shop });
    return;
  }
  if (topic === 'help') {
    yield* say(done.includes('filter_shop') ? (clears ? 'The page shows every shop again.' : `The page now shows ${shop} only.`) : HELP, signal);
    return;
  }
  if (!done.includes('read_market')) {
    yield* call('read_market', { topic, ...(shop ? { shop } : {}) });
    return;
  }
  // Captures: a table of the PayPal captures by shop, built by add_breakdown from exact fields and filters (D-130).
  if (topic === 'captures' && !done.includes('add_breakdown')) {
    yield* call('add_breakdown', { measure: 'captures', by: 'shop' });
    return;
  }
  const wantsWidget = topic === 'gaps' || topic === 'depth';
  if (wantsWidget && !done.includes('add_widget')) {
    const { slot, replace } = slotFor(api);
    if (replace) yield* call('remove_widget', { widgetId: replace });
    yield* call('add_widget', { widgetId: nextId('w-desk'), type: topic === 'gaps' ? GAP_SPOTLIGHT : DEPTH_LADDER, ...slot });
    return;
  }
  // Studio's add_widget seeds an empty widget; configure_widget maps its fields.
  if (topic === 'gaps' && !done.includes('configure_widget')) {
    const widgetId = argsOf(input.messages, 'add_widget')?.widgetId;
    if (typeof widgetId === 'string') {
      const f = marketFacts(getSnapshot());
      yield* call('configure_widget', {
        op: 'patch',
        widgetId,
        value: {
          dataMapping: SPOTLIGHT_MAPPING,
          format: { title: { enabled: true, text: `The ${W.widestSpread} right now` }, subtitle: { enabled: true, text: `Built by the market desk at ${f.time}` } },
        },
      });
      return;
    }
  }
  const facts = resultText(results.read_market) || topicFacts(getSnapshot(), topic, shop);
  const built =
    topic === 'gaps'
      ? ` I put a ${W.widestSpread} spotlight on the page.`
      : topic === 'depth'
        ? ` I put a ${W.depth.toLowerCase()} ladder on the page.`
        : topic === 'captures' && done.includes('add_breakdown')
          ? ` I put a table of the captures by shop on the page. ${breakdownSpec(getSnapshot(), 'captures', 'shop').text}`
          : '';
  yield* say(`${facts}${built}${otherTopicsNote(user, topic)}`, signal);
}
