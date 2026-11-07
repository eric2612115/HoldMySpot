import { HEADERS } from '@holdmyspot/shared';
import type { AiProviderId, ApiErrorBody, ApiSpec, OpsAgentTurnRequest, OpsAgentTurnResponse } from '@holdmyspot/shared';

/**
 * Where the console's two agents think (D-100). With a live model on the
 * server's AI port (any provider the server's AI config picks: Anthropic,
 * Muse Spark, or an OpenAI-compatible endpoint), each turn is
 * POST /api/ops/agents/turn and the key never reaches the browser. Without
 * one, the market desk runs its offline planner and the rescheduler its
 * rules, and both say so on screen.
 *
 * On the live server the console asks the server's config. On the replay
 * (?backend=mock) it stays offline unless the URL says ?agents=model, so
 * the scripted screenshots and checks never call a model by surprise.
 * ?agents=offline forces the offline agents anywhere.
 */
export interface Brain {
  kind: 'model' | 'offline';
  provider: AiProviderId | null;
  model: string | null;
  /** For the screen, for example "Muse Spark 1.3 on the server". */
  label: string;
  /** Why the agents run offline, in one sentence (empty with a model). */
  reason: string;
}

const API = (import.meta.env?.VITE_HMS_API as string | undefined) ?? '';

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  const admin = import.meta.env?.VITE_HMS_ADMIN_KEY as string | undefined;
  if (admin) h[HEADERS.admin] = admin;
  return h;
}

/** "muse-spark-1.3" to "Muse Spark 1.3"; other model ids stay as they are. */
export function modelLabel(provider: AiProviderId | null, model: string | null): string {
  if (!model) return 'no model';
  if (provider === 'muse') return model.replace(/(^|-)([a-z])/g, (_m, sep: string, c: string) => `${sep ? ' ' : ''}${c.toUpperCase()}`).replace(/-/g, ' ');
  return model;
}

export const OFFLINE: Brain = { kind: 'offline', provider: null, model: null, label: 'offline planner', reason: '' };

export async function detectBrain(backend: 'mock' | 'server'): Promise<Brain> {
  const wanted = typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('agents');
  if (wanted === 'offline') return { ...OFFLINE, reason: 'The URL asks for the offline agents (?agents=offline).' };
  if (backend === 'mock' && wanted !== 'model') {
    return { ...OFFLINE, reason: 'The replay runs its agents offline; add ?agents=model to think on the server\'s AI port.' };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${API}/api/config`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(String(res.status));
    const config = (await res.json()) as ApiSpec['GET /api/config']['response'];
    const { provider, model, mode } = config.ai;
    if (provider !== 'fake' && (mode === 'live' || mode === 'record')) {
      return { kind: 'model', provider, model, label: `${modelLabel(provider, model)} on the server`, reason: '' };
    }
    const reason =
      provider === 'fake'
        ? 'The server has no AI key, so the agents run offline.'
        : `The server's AI is in ${mode} mode, which never calls a model; start it with --ai live.`;
    return { ...OFFLINE, reason };
  } catch {
    return { ...OFFLINE, reason: 'No HoldMySpot server answered, so the agents run offline.' };
  }
}

/** One model turn on the server's AI port. Throws with the server's message when it cannot answer. */
export async function askServer(req: OpsAgentTurnRequest, signal?: AbortSignal): Promise<OpsAgentTurnResponse> {
  const res = await fetch(`${API}/api/ops/agents/turn`, { method: 'POST', headers: headers(), body: JSON.stringify(req), ...(signal ? { signal } : {}) });
  if (!res.ok) {
    let message = `The server answered ${res.status}.`;
    try {
      message = ((await res.json()) as ApiErrorBody).error.message || message;
    } catch {
      // keep the status line
    }
    throw new Error(message);
  }
  return (await res.json()) as OpsAgentTurnResponse;
}
