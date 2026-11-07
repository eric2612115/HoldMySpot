import '../styles/market.css';
import { AgStudioAiModule, enableStudioDevValidations } from 'ag-studio';
import type { AgAiHarnessSetup, AgStudioLocaleText } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { HEADERS } from '@holdmyspot/shared';
import type { ApiSpec, Dispute, OpsAgentTurnResponse } from '@holdmyspot/shared';
import type { Brain } from '../agents/brain.ts';
import { modelLabel } from '../agents/brain.ts';
import type { MarketSnapshot } from '../data/backend.ts';
import type { Market } from '../data/useMarket.ts';
import { W } from '../data/vocab.ts';
import { createMarketDesk } from './agent/marketDesk.ts';
import { studioData } from './studioData.ts';
import { INITIAL_STATE } from './studioState.ts';
import { hmsStudioTheme } from './theme.ts';
import { WIDGETS } from './widgets/defs.ts';
import { AG_STUDIO_LICENSE } from '../licenses.ts';

if (import.meta.env.DEV) enableStudioDevValidations();

/** The AG Studio key (D-82); without one Studio runs in trial mode. */
const LICENSE = AG_STUDIO_LICENSE;

const TOPIC_LABEL: Record<string, string> = {
  overview: 'the market',
  gaps: 'every line-up',
  depth: 'the line-up depth',
  holds: 'the PayPal holds',
  captures: 'the captures',
  payouts: 'the payouts',
  fills: 'the fill rates',
  stepdowns: 'the fee clocks',
  disputes: 'disputes and failed captures',
  earnings: 'queuer earnings',
};

/** How the market desk's own tool reads in Studio's chat panel. */
const TOOL_DISPLAY = {
  read_market: {
    label: ({ status, args }: { status: string; args: { topic?: string; shop?: string } }) => ({
      text: `${status === 'done' ? 'Read' : 'Reading'} ${TOPIC_LABEL[args.topic ?? ''] ?? 'the market'}`,
      pill: args.shop || undefined,
    }),
  },
  add_gap_spotlight: {
    label: ({ status }: { status: string }) => ({ text: `${status === 'done' ? 'Built' : 'Building'} the ${W.widestSpread} spotlight` }),
  },
  filter_shop: {
    label: ({ status, args }: { status: string; args: { shop?: string } }) => ({
      text: args.shop === 'all' ? 'Cleared the shop filter' : `${status === 'done' ? 'Filtered' : 'Filtering'} the page to one shop`,
      pill: args.shop && args.shop !== 'all' ? args.shop : undefined,
    }),
  },
};
const MODULES = [AgStudioAiModule];
// The registry generics of AgStudio are wider than this dashboard needs.
const Studio = AgStudio as unknown as ComponentType<Record<string, unknown>>;

/**
 * Real labels instead of Studio's "Captured (sum)": a field's own name is the
 * label (each one already says what it adds up), and the AI panel says who
 * answers: the market desk on a model, or its offline planner.
 */
function localeText(brain: Brain): AgStudioLocaleText {
  return {
    aggregationSumFieldName: '${name}',
    aggregationMaxFieldName: '${name}',
    aggregationMinFieldName: '${name}',
    aggregationAvgFieldName: 'Average ${name}',
    panelTitleAi: brain.kind === 'model' ? 'Market desk' : 'Market desk: offline planner',
    aiMessageInputPlaceholder:
      brain.kind === 'model' ? 'Ask about holds, captures, payouts, fill rates, step-downs, disputes...' : 'Offline planner: ask one of its fixed topics...',
  } as AgStudioLocaleText;
}

export default function MarketView({ market, brain }: { market: Market; brain: Brain }) {
  const { snapshot } = market;
  const latest = useRef<MarketSnapshot>(snapshot);
  latest.current = snapshot;
  const [turns, setTurns] = useState<{ count: number; last: OpsAgentTurnResponse | null }>({ count: 0, last: null });

  const getDisputes = useCallback(async (): Promise<Dispute[] | null> => {
    if (market.backend.kind !== 'server') return null;
    const admin = import.meta.env.VITE_HMS_ADMIN_KEY as string | undefined;
    const res = await fetch(`${(import.meta.env.VITE_HMS_API as string | undefined) ?? ''}/api/ops/disputes`, { headers: admin ? { [HEADERS.admin]: admin } : {} });
    if (!res.ok) return null;
    return ((await res.json()) as ApiSpec['GET /api/ops/disputes']['response']).disputes;
  }, [market.backend.kind]);

  // A new data definition per market moment; Studio reloads its engine and keeps the layout.
  const data = useMemo(() => studioData(snapshot), [snapshot]);
  const ai = useMemo<AgAiHarnessSetup>(
    () =>
      createMarketDesk({
        getSnapshot: () => latest.current,
        brain,
        getDisputes,
        onTurn: (_agent, turn) => setTurns((t) => ({ count: t.count + 1, last: turn })),
      }),
    // The harness is built once per brain; live data flows through the ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [brain],
  );
  const locale = useMemo(() => localeText(brain), [brain]);

  return (
    <section className="market" aria-label="Market dashboard">
      <div className={`desk-strip is-${brain.kind}`} title={brain.reason || undefined}>
        <span className="desk-dot" aria-hidden="true" />
        {brain.kind === 'model' ? (
          <span>
            <b>Market desk</b> runs on {brain.label}: free questions, answered with the dashboard's own numbers. It changes the page with Studio's tools and hands charts,
            layout and queries to Studio's Widget, Page and Data agents.
          </span>
        ) : (
          <span>
            <b>Market desk: offline planner.</b> No AI model here, so it answers fixed topics (holds, captures, payouts, fill rates, step-downs, disputes, the {W.widestSpread})
            from the dashboard's own numbers.
          </span>
        )}
        {brain.kind === 'model' && turns.count > 0 && (
          <span className="desk-turns">
            {turns.count} model turn{turns.count > 1 ? 's' : ''}
            {turns.last ? `, last by ${modelLabel(turns.last.ai.provider, turns.last.ai.model)} in ${(turns.last.ai.latencyMs / 1000).toFixed(1)} s` : ''}
          </span>
        )}
      </div>
      <div className="market-studio-wrap">
        <AgStudioProvider licenseKey={LICENSE} modules={MODULES}>
          <Studio
            className="market-studio"
            style={{ height: '100%', width: '100%' }}
            theme={hmsStudioTheme}
            loadThemeGoogleFonts={false}
            data={data}
            widgets={WIDGETS}
            initialState={INITIAL_STATE}
            mode="edit"
            ai={ai}
            localeText={locale}
            panels={{ edit: { left: ['data', 'edit', 'filters'], right: ['ai'] } }}
            aiToolDisplay={TOOL_DISPLAY}
            onApiReady={(e: { api: unknown }) => {
              if (import.meta.env.DEV) (window as unknown as { hmsStudioApi: unknown }).hmsStudioApi = e.api;
            }}
          />
        </AgStudioProvider>
      </div>
    </section>
  );
}
