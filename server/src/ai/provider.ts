import type { AiProvider } from '@holdmyspot/shared/ports';
import { AnthropicProvider } from './anthropic.ts';
import type { AnthropicProviderOptions } from './anthropic.ts';
import type { ResolvedAi } from './config.ts';
import { FakeProvider, FixtureTruth } from './fake.ts';
import type { TruthSource } from './fake.ts';
import { MuseProvider } from './muse.ts';
import { FixtureStore, RecordingProvider, ReplayProvider } from './replay.ts';

/**
 * Builds the provider stack from resolved settings:
 *   live   -> the live provider
 *   record -> live, saving every answer as a fixture
 *   replay -> saved answers, else rules-only fake
 *   fake   -> rules-only fake (truth sidecars of demo photos)
 */

export interface ProviderOverrides {
  truth?: TruthSource;
  fetch?: typeof fetch;
  anthropicClient?: AnthropicProviderOptions['client'];
}

export function createLiveProvider(r: ResolvedAi, o: ProviderOverrides = {}): AiProvider | null {
  const s = r.settings;
  if (s.provider === 'anthropic' && r.keys.anthropic) {
    return new AnthropicProvider({
      apiKey: r.keys.anthropic,
      model: s.anthropicModel,
      timeoutMs: s.timeoutMs,
      agentTimeoutMs: s.agentTimeoutMs,
      ...(o.anthropicClient ? { client: o.anthropicClient } : {}),
    });
  }
  if (s.provider === 'muse' && r.keys.muse) {
    return new MuseProvider({ apiKey: r.keys.muse, model: s.museModel, url: s.museUrl, timeoutMs: s.timeoutMs, ...(o.fetch ? { fetch: o.fetch } : {}) });
  }
  return null;
}

export function createProvider(r: ResolvedAi, o: ProviderOverrides = {}): AiProvider {
  const s = r.settings;
  const fake = new FakeProvider(o.truth ?? new FixtureTruth(s.proofFixturesDir));
  const live = createLiveProvider(r, o);
  const store = new FixtureStore(s.fixturesDir);
  if (s.mode === 'fake') return fake;
  if (s.mode === 'live' && live) return live;
  if (s.mode === 'record' && live) return new RecordingProvider(store, live);
  return new ReplayProvider(store, fake, { id: s.provider, model: s.model });
}
