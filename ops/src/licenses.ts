import { LicenseManager as ChartsLicense } from 'ag-charts-enterprise';
import { LicenseManager as GridLicense } from 'ag-grid-enterprise';
import { AgStudioLicenseManager } from 'ag-studio';

/**
 * The AG licence key, injected at dev-server or build time by vite.config.ts
 * (from the git-ignored ops/.env.local or the owner's key file). Empty means
 * trial mode. The key goes to AG Grid and AG Charts here, and to AG Studio
 * through its provider (MarketView); it is never logged.
 */
declare const __HMS_AG_LICENSE__: string;

export const AG_LICENSE: string | undefined = __HMS_AG_LICENSE__ || undefined;

if (AG_LICENSE) {
  GridLicense.setLicenseKey(AG_LICENSE);
  ChartsLicense.setLicenseKey(AG_LICENSE);
}

/** What each product makes of the key, without the key itself (development only, for the licence check). */
export function licenseReport(): Record<string, unknown> {
  if (!AG_LICENSE) return { loaded: false };
  const strip = (d: Record<string, unknown>) => {
    const { licenseKey: _hidden, ...rest } = d;
    return rest;
  };
  const studio = (tier: string) => {
    try {
      return strip(AgStudioLicenseManager.getLicenseDetails(AG_LICENSE, new Set([tier]) as never) as Record<string, unknown>);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  };
  return {
    loaded: true,
    grid: strip(GridLicense.getLicenseDetails(AG_LICENSE) as Record<string, unknown>),
    studioCore: studio('STUDIO-CORE'),
    studioProAi: studio('STUDIO-PRO-AI'),
  };
}

if (import.meta.env.DEV) (window as unknown as { hmsLicenseReport: typeof licenseReport }).hmsLicenseReport = licenseReport;
