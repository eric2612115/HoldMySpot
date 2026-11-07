import type { MarketRules } from '@holdmyspot/shared';
import type { AiProvider } from '@holdmyspot/shared/ports';
import type { AiPort, AiPortOptions, CheckInPhotoInput, PurchaseProofInput } from '../ports/ai.ts';
import { runAgent } from './agent.ts';
import { aiBootLine, resolveAiSettings } from './config.ts';
import type { ResolveOptions } from './config.ts';
import { AiError } from './errors.ts';
import { estimateEta, feeEstimate, shippingEstimate } from './estimates.ts';
import { decodeImage } from './image.ts';
import { reassignNote } from './notes.ts';
import { dHash } from './phash.ts';
import { checkInPhoto, confidenceOf, purchaseProof, reasonsOf } from './proof.ts';
import { createProvider } from './provider.ts';
import type { ProviderOverrides } from './provider.ts';
import type { CheckInResult, HmsAiPort, PurchaseResult } from './types.ts';

/**
 * HoldMySpot AI services: the real AiPort (server/src/ports/ai.ts).
 *
 *   const ai = await createAiPort({ config, log });   // logs one line: key names and presence only
 *
 * - checkInPhoto / purchaseProof: hashes, QR, model read, then the shared
 *   rules decide. Errors are thrown (AiError); the core turns them into
 *   needs_review.
 * - feeEstimate / shippingEstimate: shared formulas; a model phrases the
 *   explanation outside rules-only mode.
 * - reassignNote: one sentence for the ops board.
 * Extras beyond the port:
 * - dHash(bytes, contentType): pass as `saveUpload(..., { dHash: ai.dHash })`
 *   so every upload gets a perceptual hash for duplicate checks;
 * - eta(...): travel, arrival, wait and earning rate for the task list;
 * - biddingAgent(...): one agent run for one bid; apply `decision` through
 *   PATCH /api/bids/:bidId or cancel, log it as an AgentAction with `ai`,
 *   and schedule the next run at `nextRunAt`.
 *
 * Provider and mode (docs/AI-SERVICES.md section 2): `auto` picks Anthropic
 * when ANTHROPIC_API_KEY is found, else Muse when MODEL_API_KEY is found,
 * else rules only. Without a key nothing touches the network: saved answers
 * replay from server/fixtures/ai, and demo photos read from their truth
 * sidecars in server/fixtures/proofs.
 */

export interface BuildAiPortOptions extends ResolveOptions, ProviderOverrides {
  /** Use this provider instead of building one (tests and the eval). */
  provider?: AiProvider;
  rules?: MarketRules;
  /**
   * The server's rules-only fake (server/src/fakes/ai.ts). Photos uploaded
   * with a simulated scenario go to it (after an offline read, when the photo
   * is a rendered fixture), and so do unknown photos when no AI reader exists
   * (no key), instead of being sent to review.
   */
  scenarioFallback?: AiPort | null;
}

export function buildAiPort(opts: BuildAiPortOptions = {}): HmsAiPort {
  const resolved = resolveAiSettings(opts);
  const provider = opts.provider ?? createProvider(resolved, opts);
  const info = opts.provider
    ? { provider: opts.provider.id, model: opts.provider.model, mode: opts.provider.mode }
    : { provider: resolved.settings.provider, model: resolved.settings.model, mode: resolved.settings.mode };
  const fallback = opts.scenarioFallback ?? null;
  const noReader = !opts.provider && resolved.settings.provider === 'fake';
  const unread = (e: unknown) => noReader && e instanceof AiError && e.kind === 'no_truth';
  // Replay and rules-only answers need no network: a staged demo photo that is a
  // rendered fixture is then read by the real pipeline (truth sidecar or saved answer).
  const offline = provider.mode === 'replay' || provider.mode === 'fake';
  const noTruth = (e: unknown) => e instanceof AiError && e.kind === 'no_truth';

  const fallbackCheckIn = async (input: CheckInPhotoInput, f: AiPort): Promise<CheckInResult> => {
    const v = await f.checkInPhoto(input);
    return { ...v, confidence: confidenceOf(v.status, v.checks, 0, null), reasons: reasonsOf(v.checks, [v.summary]), photos: [], extraction: null, qr: null, duplicateOf: input.duplicateOf, reading: null };
  };
  const fallbackPurchase = async (input: PurchaseProofInput, f: AiPort): Promise<PurchaseResult> => {
    const v = await f.purchaseProof(input);
    return { ...v, confidence: confidenceOf(v.status, v.checks, 0, null), reasons: reasonsOf(v.checks, [v.summary]), photos: [], extraction: null, qr: null, duplicateOf: input.duplicateOf, reading: null };
  };

  return {
    info,
    provider,
    keyReport: resolved.report,
    bootLine: aiBootLine(resolved) + (fallback ? '; simulated-scenario photos use the rules-only fake' : ''),
    checkInPhoto: async (input) => {
      if (fallback && input.photo.scenario !== null) {
        // A staged photo (simulated scenario): read it for real when that is offline and it is a
        // rendered fixture; placeholders go to the scenario fake, and never to a live model.
        if (!offline) return fallbackCheckIn(input, fallback);
        try {
          return await checkInPhoto(input, provider);
        } catch (e) {
          if (noTruth(e)) return fallbackCheckIn(input, fallback);
          throw e;
        }
      }
      try {
        return await checkInPhoto(input, provider);
      } catch (e) {
        if (fallback && unread(e)) return fallbackCheckIn(input, fallback);
        throw e;
      }
    },
    purchaseProof: async (input) => {
      if (fallback && (input.receipt.scenario !== null || input.itemPhoto.scenario !== null)) {
        if (!offline) return fallbackPurchase(input, fallback);
        try {
          return await purchaseProof(input, provider);
        } catch (e) {
          if (noTruth(e)) return fallbackPurchase(input, fallback);
          throw e;
        }
      }
      try {
        return await purchaseProof(input, provider);
      } catch (e) {
        if (fallback && unread(e)) return fallbackPurchase(input, fallback);
        throw e;
      }
    },
    feeEstimate: (input) => feeEstimate(input, provider),
    shippingEstimate: (input) => shippingEstimate(input, provider),
    reassignNote: async (input) => (await reassignNote(input, provider)).text,
    dHash: async (bytes) => {
      const pixels = await decodeImage(bytes);
      return pixels ? dHash(pixels) : null;
    },
    eta: (input) => estimateEta(input),
    biddingAgent: (input) => runAgent(input, provider),
  };
}

/** The server's rules-only fake, loaded by path so this module does not depend on it at compile time. */
async function loadScenarioFake(): Promise<AiPort | null> {
  try {
    const mod = (await import(new URL('../fakes/ai.ts', import.meta.url).href)) as { FakeAi?: new () => AiPort };
    return mod.FakeAi ? new mod.FakeAi() : null;
  } catch {
    return null;
  }
}

/** The factory server/src/ports/ai.ts names: builds the port from the server config and logs one line. */
export async function createAiPort(options: AiPortOptions): Promise<HmsAiPort> {
  const c = options.config;
  const port = buildAiPort({
    runtimeMode: c.mode,
    secretsDir: c.secretsDir,
    aiProvider: c.ai.provider,
    aiMode: c.ai.mode,
    timeoutMs: c.ai.timeoutMs,
    fixturesDir: c.ai.fixturesDir,
    rules: c.rules,
    scenarioFallback: await loadScenarioFake(),
  });
  options.log(port.bootLine);
  return port;
}

export type * from './types.ts';
export { agentCeilingCents, goalUrgency, policyDecision, runAgent } from './agent.ts';
export { SecretValue, aiBootLine, resolveAiSettings } from './config.ts';
export type { AiSettings, ResolvedAi } from './config.ts';
export { AiError } from './errors.ts';
export { estimateEta, feeEstimate, shippingEstimate } from './estimates.ts';
export { FakeProvider, FixtureTruth, MemoryTruth } from './fake.ts';
export { decodeImage, generatorMetadata } from './image.ts';
export { DUPLICATE_DISTANCE, dHash, findDuplicates, hammingDistance, photoFacts } from './phash.ts';
export type { PhotoFacts } from './phash.ts';
export { checkInPhoto, purchaseProof, toLineReading, toPurchaseReading } from './proof.ts';
export { buildReceiptQr, parseReceiptQr, readQrCodes } from './qr.ts';
export type { ReceiptQr } from './qr.ts';
export { FixtureStore, RecordingProvider, ReplayProvider, fixtureKey } from './replay.ts';
export type { CheckInExtraction, PurchaseExtraction } from './schemas.ts';
