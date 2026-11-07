import { clientToolRunner, createAiHarness, directLlmRunner } from 'ag-studio';
import type { AgAiHarness, AgAiHarnessSetupParams, AgAiParamsBuilder, AgAiPromptStarter, AgAiTool, AgAiToolContext, AgStudioApi } from 'ag-studio';
import type { Dispute, OpsAgentTurnResponse } from '@holdmyspot/shared';
import type { Brain } from '../../agents/brain.ts';
import type { MarketSnapshot } from '../../data/backend.ts';
import { clockText } from '../../data/time.ts';
import { W } from '../../data/vocab.ts';
import { shopLabel } from '../studioData.ts';
import { DEPTH_LADDER, GAP_BOARD, GAP_SPOTLIGHT } from '../widgets/defs.ts';
import { TOPICS, topicFacts } from './facts.ts';
import type { Topic } from './facts.ts';
import { PLACEHOLDER_ID, SPOTLIGHT_MAPPING, nextId, planTurn, slotFor } from './planner.ts';
import { serverLlmAdapter } from './serverAdapter.ts';

/**
 * The market desk: a custom agent in AG Studio's Agent Framework (D-100).
 *
 * With a live model on the server's AI port it is a `directLlmRunner` whose
 * LLM is our server (serverAdapter.ts): Studio runs the loop and the tools,
 * the server answers each turn. It reads the market with our `read_market`
 * tool, changes the page with Studio's own tools (add, remove and position
 * widgets, page filters) and hands work to three of Studio's built-in agents
 * with `delegate_to`: Widget (configures a chart or table), Page (layout and
 * filters) and Data (queries any table). Those three run on the same server
 * adapter. The harness is ours (`createAiHarness` with our roster), the desk
 * is its primary agent.
 *
 * Without a model it is a `clientToolRunner` whose turns come from the
 * offline planner (planner.ts): fixed topics, the same tools, and the UI says
 * "offline planner".
 */

export { PLACEHOLDER_ID } from './planner.ts';

export interface DeskOptions {
  getSnapshot(): MarketSnapshot;
  brain: Brain;
  /** PayPal disputes from the server, or null on the replay (which has none). */
  getDisputes(): Promise<Dispute[] | null>;
  /** Each model turn, for the strip above Studio. */
  onTurn?(agent: string, turn: OpsAgentTurnResponse): void;
}

/** The prompt starters: each shows a different part of the desk. Labels stay short; the prompt is what is sent. */
export const OFFLINE_STARTERS: AgAiPromptStarter[] = [
  { label: `Widest ${W.spread.toLowerCase()}`, prompt: `Which shop has the ${W.widestSpread} right now?` },
  { label: 'Holds and captures', prompt: 'How much is PayPal holding, and how much was captured or released so far?' },
  { label: 'Fill rates', prompt: 'What are the fill rates by shop?' },
  { label: 'Step-downs', prompt: 'Which fee clocks are stepping down, and where are they now?' },
  { label: 'Disputes', prompt: 'Any disputes, failed captures or rejected receipts?' },
];

export const MODEL_STARTERS: AgAiPromptStarter[] = [
  { label: `Widest ${W.spread.toLowerCase()}`, prompt: `Which shop has the ${W.widestSpread} right now?` },
  { label: 'Captures by shop', prompt: 'Chart the money PayPal captured, by shop, and tell me which capture was the largest.' },
  { label: 'Payouts so far', prompt: 'Who has been paid out so far, and is any payout still pending?' },
  { label: 'Step-downs', prompt: 'Which fee clocks are stepping down right now, and when is the next step?' },
  { label: 'Only Paper Moon', prompt: 'Show only Paper Moon Toys and tell me its fill rate.' },
];

const DESK_DESCRIPTION = `Answers questions about HoldMySpot's market (PayPal holds, captures, payouts, fill rates, fee-clock step-downs, disputes, ${W.bids}, ${W.asks} and the ${W.spread.toLowerCase()}) and changes the dashboard to show the answer.`;

/** The desk's own instructions: the domain, the rules for numbers, and how to use Studio's tools and agents. */
export function deskInstructions(snap: MarketSnapshot): string {
  return `You are the Market desk in HoldMySpot's operator console, an agent inside AG Studio. HoldMySpot is a market on the queue fee: requesters post requests backed by PayPal holds; queuers near a shop post offers whose fee steps down on a clock after check-in, then stand in line and buy; a verified receipt triggers PayPal captures and PayPal Payouts.
Market time now: ${clockText(snap.at)}, San Francisco.

How to work:
1. Call read_market first with the topic that fits (holds, captures, payouts, fills, stepdowns, disputes, gaps, depth, earnings or overview), and a shop when the operator names one. Its sentences hold the only numbers you may use.
2. Answer in two to four short sentences with exact dollar amounts, names and times.
3. Change the dashboard when the operator asks to show, chart, compare, list, filter or explain something:
   - Widest ${W.spread.toLowerCase()}: call add_gap_spotlight. It places the "${GAP_SPOTLIGHT}" widget in the free slot and maps its fields.
   - Any chart or table: add_widget with a fitting built-in type (bar-chart-grouped, column-chart-grouped, pie-chart, donut-chart, grid or value) in a free slot, then delegate_to the "widget" agent with that widgetType and widgetId and one sentence naming the exact field ids, for example "categoryKey shops.shop, valueKey holds.capturedUsd summed; title Captured by shop". Prefer fields that need no filter (holds.capturedUsd, holds.releasedUsd, holds.openUsd, payouts.amountUsd, fills.qty).
   - When a delegate fails or returns no summary, say the widget was added but is not configured yet; never describe a chart you did not see built.
   - Filter to a shop: filter_shop with the shop's name ("all" clears it). Ask the "page" agent for any other layout or filter change.
   - Explain the page: view_page, then one line per widget.
   - A question read_market cannot answer: delegate_to the "data" agent, which can query every table.
4. A free slot: the "${PLACEHOLDER_ID}" slot if it is on the page, else a new row at xTrack 0, yTrack 97, xSpan 12, ySpan 18.
5. Never invent an amount, an id or a name, and never claim you moved or charged money: code decides money, and you only read it.

Tables and the fields you will use (table.field): shops.shop, shops.city; holds.requester, holds.heldUsd, holds.capturedUsd, holds.releasedUsd, holds.openUsd, holds.status, holds.funding, holds.renewalRequired; ledger.kind (Held, Captured, Released, Paid out, Renewed, Refunded), ledger.amountUsd, ledger.status, ledger.who, ledger.paypalObject, ledger.paypalId, ledger.slot, ledger.events; payouts.queuer, payouts.amountUsd, payouts.platformFeeUsd, payouts.purpose, payouts.status; fills.slot, fills.queuer, fills.requester, fills.qty, fills.feeUsd, fills.valueUsd; jobs.queuer, jobs.requester, jobs.stage, jobs.earningsUsd; bids.requester, bids.qty, bids.remainingQty, bids.maxFeeUsd, bids.status; asks.queuer, asks.feeNowUsd, asks.openFeeUsd, asks.floorUsd, asks.status; books.bestBidUsd, books.bestAskUsd, books.spreadUsd, books.bidQty, books.askCapacity. Every table joins shops on shopId, so a filter on shops.shop filters the whole page. Custom widget types: ${GAP_BOARD}, ${GAP_SPOTLIGHT}, ${DEPTH_LADDER}.`;
}

export function createMarketDesk(opts: DeskOptions) {
  return (params: AgAiHarnessSetupParams): AgAiHarness => {
    // The setup params type the API as the core API; at runtime it is the full Studio API.
    const api = params.api as unknown as AgStudioApi;
    return createAiHarness(api, ({ tools, builtIn }) => {
      const readMarket: AgAiTool = api.defineAiTool({
        name: 'read_market',
        description: `Reads HoldMySpot's market at the current market time, as plain sentences with every number: PayPal holds and releases, captures (with PayPal capture ids), payouts, fill rates by shop, fee-clock step-downs, disputes and failed captures, the ${W.spread.toLowerCase()} per shop, the ${W.depth.toLowerCase()} at a shop, queuer earnings, or an overview.`,
        params: (s: AgAiParamsBuilder) =>
          s.object({
            topic: s.enum([...TOPICS]),
            shop: s.string({ description: 'Optional: a shop name (or part of it) to narrow the answer to.' }).optional(),
          }),
        execute: async (args: { topic: Topic; shop?: string }, ctx: AgAiToolContext) => {
          const snap = opts.getSnapshot();
          const disputes = args.topic === 'disputes' ? await opts.getDisputes().catch(() => null) : null;
          return ctx.success(topicFacts(snap, args.topic, args.shop, disputes), { topic: args.topic, time: clockText(snap.at) });
        },
      } as never);

      // Our own small tool over two of Studio's: one shop for the whole page (every table joins shops).
      const shops = opts.getSnapshot().shops;
      const names = shops.map((x) => shopLabel(x, shops));
      const addFilter = tools.studio.addPageFilter();
      const removeFilter = tools.studio.removePageFilter();
      const filterShop: AgAiTool = api.defineAiTool({
        name: 'filter_shop',
        description: 'Filters the whole dashboard to one shop (every table joins shops), replacing any shop filter; "all" clears it.',
        params: (s: AgAiParamsBuilder) => s.object({ shop: s.enum(['all', ...names]) }),
        execute: async (args: { shop: string }, ctx: AgAiToolContext) => {
          const state = api.getState();
          const page = state.pages.find((p) => p.id === state.selectedPageId) ?? state.pages[0];
          const current = (page?.filter?.page ?? []) as { field: { id: string } }[];
          for (let i = current.length - 1; i >= 0; i--) {
            if (current[i]?.field.id !== 'shops.shop') continue;
            await removeFilter.execute?.({ toolCallId: `${ctx.run.runId}-unfilter-${i}`, name: removeFilter.name, args: { op: 'remove', index: i } }, ctx);
          }
          if (args.shop === 'all') return ctx.success('Cleared the shop filter: the page shows every shop.');
          const res = await addFilter.execute?.(
            { toolCallId: `${ctx.run.runId}-filter`, name: addFilter.name, args: { op: 'append', value: { field: { id: 'shops.shop' }, model: { operator: 'equals', value: args.shop } } } },
            ctx,
          );
          return res && !res.success ? res : ctx.success(`The page now shows ${args.shop} only.`);
        },
      } as never);

      // Our own tool over three of Studio's: the spotlight in the free slot, with its fields mapped.
      const removeWidget = tools.studio.removeWidget();
      const addWidget = tools.studio.addWidget();
      const configureSpotlight = tools.studio.configureWidget({ widgetType: GAP_SPOTLIGHT });
      const addSpotlight: AgAiTool = api.defineAiTool({
        name: 'add_gap_spotlight',
        description: `Puts the ${W.widestSpread} spotlight on the page (custom widget ${GAP_SPOTLIGHT}): the shop with the ${W.widestSpread}, why, and the runners-up. Replaces the desk's note when it is there.`,
        params: (s: AgAiParamsBuilder) => s.object({}),
        execute: async (_args: unknown, ctx: AgAiToolContext) => {
          const { slot, replace } = slotFor(api);
          const id = (step: string) => `${ctx.run.runId}-${step}`;
          if (replace) await removeWidget.execute?.({ toolCallId: id('remove'), name: removeWidget.name, args: { widgetId: replace } }, ctx);
          const widgetId = nextId('w-desk');
          const added = await addWidget.execute?.({ toolCallId: id('add'), name: addWidget.name, args: { widgetId, type: GAP_SPOTLIGHT, ...slot } }, ctx);
          if (added && !added.success) return added;
          const value = {
            dataMapping: SPOTLIGHT_MAPPING,
            format: { title: { enabled: true, text: `The ${W.widestSpread} right now` }, subtitle: { enabled: true, text: `Built by the market desk at ${clockText(opts.getSnapshot().at)}` } },
          };
          const configured = await configureSpotlight.execute?.({ toolCallId: id('configure'), name: configureSpotlight.name, args: { op: 'patch', widgetId, value } }, ctx);
          return configured && !configured.success ? configured : ctx.success(`Added the ${W.widestSpread} spotlight (${widgetId}) with its fields mapped.`, { widgetId });
        },
      } as never);

      if (opts.brain.kind !== 'model') {
        const desk = clientToolRunner({
          id: 'market-desk',
          name: 'Market desk (offline planner)',
          description: DESK_DESCRIPTION,
          maxTurns: 6,
          instructions: () => 'Offline planner: fixed topics, no model. Calls read_market, then answers; builds a widget for the gap and depth questions.',
          tools: () => [readMarket, filterShop, tools.studio.viewPage(), tools.studio.removeWidget(), tools.studio.addWidget(), tools.studio.configureWidget({ widgetType: GAP_SPOTLIGHT })],
          run: (input, ctx) => planTurn(input, ctx.signal, api, opts.getSnapshot),
        });
        return { agents: [desk], primary: 'market-desk', promptStarters: OFFLINE_STARTERS };
      }

      const adapter = (agent: string) => serverLlmAdapter(agent, { onTurn: opts.onTurn });
      const desk = directLlmRunner({
        id: 'market-desk',
        name: 'Market desk',
        description: DESK_DESCRIPTION,
        schema: (s) => s.undefined(),
        maxTurns: 16,
        instructions: () => deskInstructions(opts.getSnapshot()),
        tools: (ctx) => [
          readMarket,
          addSpotlight,
          ctx.studio.viewPage(),
          ctx.studio.addWidget(),
          ctx.studio.removeWidget(),
          ctx.studio.positionWidget(),
          filterShop,
          ctx.tools.delegateTo(['widget', 'page', 'data']),
          ctx.tools.renameThread(),
        ],
        adapter: adapter('market-desk'),
      });
      // Three of Studio's own agents on the same model. The Widget agent loses its widget-filter tools: their
      // 20 kB schema doubles every turn's prompt, and the desk asks only for mappings that need no filter.
      const widget = builtIn.widget;
      const helpers = [
        directLlmRunner({ ...widget, tools: (ctx, p) => (widget.tools?.(ctx, p) ?? []).filter((t) => !/_widget_filter$/.test(t.name)), adapter: adapter('widget') }),
        directLlmRunner({ ...builtIn.page, adapter: adapter('page') }),
        directLlmRunner({ ...builtIn.data, adapter: adapter('data') }),
      ];
      return { agents: [desk, ...helpers], primary: 'market-desk', promptStarters: MODEL_STARTERS };
    });
  };
}
