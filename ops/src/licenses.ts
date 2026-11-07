import { LicenseManager as ChartsLicense } from 'ag-charts-enterprise';
import { LicenseManager as GridLicense } from 'ag-grid-enterprise';
import { AgStudioLicenseManager } from 'ag-studio';

/**
 * The AG licence keys, injected at dev-server or build time by vite.config.ts
 * (from ops/.env.local, the shell or a key file; D-82). Empty means AG's trial
 * mode: every feature works and AG Studio draws its watermark on hosts other
 * than localhost. Neither key is ever logged.
 *
 * - The AG Studio key goes to AG Studio through its provider (MarketView). It is
 *   the only key the console needs (D-83): AG Studio draws every grid and chart
 *   here, and AG Grid and AG Charts skip their own licence check inside it.
 * - The AG Grid and AG Charts Enterprise key goes to those two products, for a
 *   grid or chart drawn outside AG Studio (there is none today). An AG Studio key
 *   does not license them there, so it is never given to them.
 */
declare const __HMS_AG_STUDIO_LICENSE__: string;
declare const __HMS_AG_LICENSE__: string;

export const AG_STUDIO_LICENSE: string | undefined = __HMS_AG_STUDIO_LICENSE__ || undefined;
export const AG_GRID_LICENSE: string | undefined = __HMS_AG_LICENSE__ || undefined;

if (AG_GRID_LICENSE) {
  GridLicense.setLicenseKey(AG_GRID_LICENSE);
  ChartsLicense.setLicenseKey(AG_GRID_LICENSE);
}

/** AG Studio tiers: the console registers AgStudioAiModule, so it needs PRO-AI. */
const STUDIO_TIERS = ['CORE', 'PRO', 'PRO-AI'] as const;

/**
 * What AG Grid's and AG Studio's own licence managers make of each key, without
 * the keys (development only, for the licence check). AG Charts has no public
 * check; it follows the same product tags as AG Grid.
 */
export function licenseReport(): Record<string, unknown> {
  const hide = (d: object) => {
    const { licenseKey: _hidden, ...rest } = d as Record<string, unknown>;
    return rest;
  };
  const verdicts = (key: string | undefined) => {
    if (!key) return { loaded: false };
    const studio: Record<string, unknown> = {};
    for (const tier of STUDIO_TIERS) {
      try {
        studio[tier] = hide(AgStudioLicenseManager.getLicenseDetails(key, new Set([tier])));
      } catch (e) {
        studio[tier] = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    return { loaded: true, grid: hide(GridLicense.getLicenseDetails(key)), studio };
  };
  return {
    studioKey: verdicts(AG_STUDIO_LICENSE),
    gridKey: verdicts(AG_GRID_LICENSE),
    given: { agStudio: AG_STUDIO_LICENSE ? 'studio key' : 'none', agGridAndCharts: AG_GRID_LICENSE ? 'grid key' : 'none' },
  };
}

if (import.meta.env.DEV) (window as unknown as { hmsLicenseReport: typeof licenseReport }).hmsLicenseReport = licenseReport;
