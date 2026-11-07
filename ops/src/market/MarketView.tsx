import '../styles/market.css';
import { AgStudioAiModule, enableStudioDevValidations } from 'ag-studio';
import type { AgAiHarnessSetup } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import { useMemo, useRef } from 'react';
import type { ComponentType } from 'react';
import type { MarketSnapshot } from '../data/backend.ts';
import type { Market } from '../data/useMarket.ts';
import { createMarketDesk } from './agent/marketDesk.ts';
import { studioData } from './studioData.ts';
import { INITIAL_STATE } from './studioState.ts';
import { hmsStudioTheme } from './theme.ts';
import { WIDGETS } from './widgets/defs.ts';
import { AG_LICENSE } from '../licenses.ts';

if (import.meta.env.DEV) enableStudioDevValidations();

const LICENSE = AG_LICENSE;

/** How the market desk's own tool reads in Studio's chat panel. */
const TOOL_DISPLAY = {
  read_market: {
    label: ({ status, result }: { status: string; result?: { success: boolean; data?: { gaps?: number } } }) => ({
      text: status === 'done' ? 'Read every line-up' : 'Reading every line-up',
      pill: result?.success && result.data?.gaps !== undefined ? `${result.data.gaps} two-sided` : undefined,
    }),
  },
};
const MODULES = [AgStudioAiModule];
// The registry generics of AgStudio are wider than this dashboard needs.
const Studio = AgStudio as unknown as ComponentType<Record<string, unknown>>;

export default function MarketView({ market }: { market: Market }) {
  const { snapshot } = market;
  const latest = useRef<MarketSnapshot>(snapshot);
  latest.current = snapshot;

  // A new data definition per market moment; Studio reloads its engine and keeps the layout.
  const data = useMemo(() => studioData(snapshot), [snapshot]);
  const ai = useMemo<AgAiHarnessSetup>(() => createMarketDesk(() => latest.current), []);

  return (
    <section className="market" aria-label="Market dashboard">
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
          panels={{ edit: { left: ['data', 'edit', 'filters'], right: ['ai'] } }}
          aiToolDisplay={TOOL_DISPLAY}
          onApiReady={(e: { api: unknown }) => {
            if (import.meta.env.DEV) (window as unknown as { hmsStudioApi: unknown }).hmsStudioApi = e.api;
          }}
        />
      </AgStudioProvider>
    </section>
  );
}
