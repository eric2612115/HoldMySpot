import { clientToolRunner, createAiHarness } from 'ag-studio';
import type {
  AgAiEvent,
  AgAiHarness,
  AgAiHarnessSetupParams,
  AgAiMessage,
  AgAiParamsBuilder,
  AgAiPromptStarter,
  AgAiRunInput,
  AgAiTool,
  AgAiToolContext,
  AgStudioApi,
} from 'ag-studio';
import type { MarketSnapshot } from '../../data/backend.ts';
import { W } from '../../data/vocab.ts';
import { DEPTH_LADDER, GAP_SPOTLIGHT } from '../widgets/defs.ts';
import { marketFacts } from './facts.ts';
import type { MarketFacts } from './facts.ts';

/**
 * The market desk: a custom agent in AG Studio's Agent Framework. It answers
 * questions about the line-ups and builds a widget for each answer through
 * Studio's own tools (remove_widget, add_widget) plus one tool of ours
 * (read_market, which reads the same snapshot the console shows).
 *
 * In fake mode (no model key, the default in docs/ARCHITECTURE.md) its turns
 * come from a deterministic planner below instead of a model: Studio still
 * owns the loop, runs every tool call and shows each step in its chat panel
 * (clientToolRunner). A live model can replace `planTurn` without touching
 * the tools or the widgets.
 */

type Intent = 'gap' | 'depth' | 'holds' | 'earnings' | 'help';

export const PLACEHOLDER_ID = 'w-desk-note';

/** Field mapping for the spotlight, as Studio's configure_widget tool expects it. */
const SPOTLIGHT_MAPPING = {
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

export const PROMPT_STARTERS: AgAiPromptStarter[] = [
  { label: `Widest ${W.spread.toLowerCase()}`, prompt: `Which shop has the ${W.widestSpread} right now?` },
  { label: `${W.depth} at Paper Moon`, prompt: 'How deep is the line-up at Paper Moon Toys?' },
  { label: 'Held versus captured', prompt: 'How much money is held versus captured?' },
  { label: 'Top earner', prompt: 'Which queuer earned the most today?' },
];

function intentOf(text: string): Intent {
  const t = text.toLowerCase();
  if (/(spread|gap|widest|difference|apart)/.test(t)) return 'gap';
  if (/(depth|deep|waiting|ladder|how many)/.test(t)) return 'depth';
  if (/(hold|held|captur|releas|money|paypal)/.test(t)) return 'holds';
  if (/(earn|paid|payout|queuer|best)/.test(t)) return 'earnings';
  return 'help';
}

let seq = 0;
const nextId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
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
    await sleep(12, signal);
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

/** Which of our calls already have results in this turn, by tool name. */
function finishedCalls(messages: AgAiMessage[]): { user: string; done: string[] } {
  let last = -1;
  messages.forEach((m, i) => {
    if (m.role === 'user') last = i;
  });
  const user = last >= 0 ? (messages[last] as { content: string }).content : '';
  const tail = messages.slice(last + 1);
  const results = new Set(tail.filter((m) => m.role === 'tool').map((m) => (m as { toolCallId: string }).toolCallId));
  const done: string[] = [];
  for (const m of tail) {
    if (m.role !== 'assistant') continue;
    for (const c of m.toolCalls ?? []) if (results.has(c.id)) done.push(c.function.name);
  }
  return { user, done };
}

interface Slot {
  xTrack: number;
  yTrack: number;
  xSpan: number;
  ySpan: number;
}

/** Where the answer goes: the placeholder's slot if it is still there, else a free row at the bottom. */
function slotFor(api: AgStudioApi): { slot: Slot; replace: string | null } {
  const state = api.getState();
  const page = state.pages.find((p) => p.id === state.selectedPageId) ?? state.pages[0];
  const layout = (page?.widgetLayout ?? {}) as Record<string, Slot | undefined>;
  const placeholder = layout[PLACEHOLDER_ID];
  if (placeholder) return { slot: placeholder, replace: PLACEHOLDER_ID };
  const bottom = Math.max(0, ...Object.values(layout).map((l) => (l ? l.yTrack + l.ySpan : 0)));
  return { slot: { xTrack: 0, yTrack: bottom, xSpan: 10, ySpan: 19 }, replace: null };
}

function answer(intent: Intent, f: MarketFacts, widgetName: string | null): string {
  const built = widgetName ? ` I put a ${widgetName} on the page.` : '';
  if (intent === 'gap') {
    const top = f.gaps[0];
    if (!top) return `No shop has both a ${W.bid} and an ${W.ask} at ${f.time}, so there is no ${W.spread.toLowerCase()} to compare.${built}`;
    const rest = f.gaps.slice(1, 3).map((g) => `${g.shop} ${g.gapText}`).join(', ');
    return `${top.shop} has the ${W.widestSpread} at ${f.time}: the ${W.bestBid.toLowerCase()} is ${top.bidText} and the ${W.bestAsk.toLowerCase()} is ${top.askText}, ${top.gapText} apart. ${top.why}${rest ? ` Next: ${rest}.` : ''}${built}`;
  }
  if (intent === 'depth') {
    const d = f.depth;
    if (!d) return `Nothing waits at Paper Moon Toys at ${f.time}.${built}`;
    return `${d.shop} has ${d.bidUnits} units waiting across ${d.bidLevels} fee levels, the top at ${d.topBid}, and ${d.askUnits} offered${d.bestAsk ? ` from ${d.bestAsk}` : ''}.${built}`;
  }
  if (intent === 'holds') {
    return `At ${f.time}, PayPal holds ${f.money.open} for open requests. So far ${f.money.captured} was captured, ${f.money.released} released and ${f.money.paidOut} paid out to queuers. Captures never go above a requester's own limit.`;
  }
  if (intent === 'earnings') {
    const e = f.earners[0];
    if (!e) return `No queuer has a verified receipt yet at ${f.time}, so nobody has earned a fee.`;
    return `${e.name} earned the most by ${f.time}: ${e.amount} in queue fees after the 10% platform fee, from ${e.jobs} jobs.${f.earners[1] ? ` ${f.earners[1].name} is next with ${f.earners[1].amount}.` : ''}`;
  }
  return `I answer questions about the line-ups: the widest ${W.spread.toLowerCase()}, the ${W.depth.toLowerCase()} at a shop, money held versus captured, and queuer earnings. Try one of the suggestions.`;
}

export function createMarketDesk(getSnapshot: () => MarketSnapshot) {
  return (params: AgAiHarnessSetupParams): AgAiHarness => {
    // The setup params type the API as the core API; at runtime it is the full Studio API.
    const api = params.api as unknown as AgStudioApi;
    return createAiHarness(api, ({ tools }) => {
      const readMarket: AgAiTool = api.defineAiTool({
        name: 'read_market',
        description: `Reads every shop's line-up at the current market time: ${W.bestBid.toLowerCase()}, ${W.bestAsk.toLowerCase()} after fee-clock steps, the ${W.spread.toLowerCase()}, units waiting, money held and captured, and queuer earnings.`,
        params: (s: AgAiParamsBuilder) => s.object({ focus: s.enum(['gap', 'depth', 'holds', 'earnings', 'help']) }),
        execute: (_args: unknown, ctx: AgAiToolContext) => {
          const f = marketFacts(getSnapshot());
          return ctx.success(f.summary, { time: f.time, gaps: f.gaps.length });
        },
      } as never);

      const desk = clientToolRunner({
        id: 'market-desk',
        name: 'Market desk',
        description: `Answers questions about HoldMySpot line-ups (${W.bids}, ${W.asks}, ${W.spread.toLowerCase()}s, holds, earnings) and builds a widget for each answer.`,
        maxTurns: 6,
        instructions: () =>
          [
            'You are the market desk of HoldMySpot, a market on the queue fee: requesters post requests backed by PayPal holds; queuers near a shop post offers whose fee steps down on a clock after check-in.',
            'Always call read_market first. Then answer in two or three plain sentences with exact dollar amounts.',
            `For questions about the ${W.widestSpread}, add a ${GAP_SPOTLIGHT} widget with add_widget; for depth questions add a ${DEPTH_LADDER} widget. Replace the "${PLACEHOLDER_ID}" note if it is on the page.`,
          ].join('\n'),
        tools: () => [
          readMarket,
          tools.studio.viewPage(),
          tools.studio.removeWidget(),
          tools.studio.addWidget(),
          tools.studio.configureWidget({ widgetType: GAP_SPOTLIGHT }),
        ],
        run: (input: AgAiRunInput, ctx) => planTurn(input, ctx.signal, api, getSnapshot),
      });

      return { agents: [desk], primary: 'market-desk', promptStarters: PROMPT_STARTERS };
    });
  };
}

/** The fake-mode planner: one turn of the market desk, decided from what has run so far. */
async function* planTurn(input: AgAiRunInput, signal: AbortSignal | undefined, api: AgStudioApi, getSnapshot: () => MarketSnapshot): AsyncGenerator<AgAiEvent> {
  const { user, done } = finishedCalls(input.messages);
  const intent = intentOf(user);
  await sleep(220, signal);

  if (!done.includes('read_market')) {
    yield* say(intent === 'help' ? 'Let me check what the market looks like first.' : 'Reading every line-up at the current market time.', signal);
    yield* call('read_market', { focus: intent });
    return;
  }

  const wantsWidget = intent === 'gap' || intent === 'depth';
  if (wantsWidget && !done.includes('add_widget')) {
    const { slot, replace } = slotFor(api);
    if (replace) yield* call('remove_widget', { widgetId: replace });
    yield* call('add_widget', { widgetId: nextId('w-desk'), type: intent === 'gap' ? GAP_SPOTLIGHT : DEPTH_LADDER, ...slot });
    return;
  }
  // Studio's add_widget seeds an empty widget; configure_widget maps its fields.
  if (intent === 'gap' && !done.includes('configure_widget')) {
    const widgetId = argsOf(input.messages, 'add_widget')?.widgetId;
    if (typeof widgetId === 'string') {
      const facts = marketFacts(getSnapshot());
      yield* call('configure_widget', {
        op: 'patch',
        widgetId,
        value: {
          dataMapping: SPOTLIGHT_MAPPING,
          format: { title: { enabled: true, text: `The ${W.widestSpread} right now` }, subtitle: { enabled: true, text: `Built by the market desk at ${facts.time}` } },
        },
      });
      return;
    }
  }

  const facts = marketFacts(getSnapshot());
  const widgetName = wantsWidget ? (intent === 'gap' ? `${W.widestSpread} spotlight` : `${W.depth.toLowerCase()} ladder`) : null;
  yield* say(answer(intent, facts, widgetName), signal);
}
