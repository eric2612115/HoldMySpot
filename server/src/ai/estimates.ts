import {
  DEFAULT_RULES,
  FEE_CENTS_PER_WAIT_MINUTE,
  PACKING_GRAMS,
  SHIPPING_BASE_CENTS,
  SHIPPING_NOTES,
  SHIPPING_PER_100G_CENTS,
  distanceMeters,
  expectedWaitMinutes,
  formatUsd,
  shippingNumbers,
  suggestedClock,
  suggestedFeeCents,
  travelMinutes,
} from '@holdmyspot/shared';
import { DUTY_RATE_BPS } from '@holdmyspot/shared';
import type { AiStamp, FeeEstimate, ShippingEstimate } from '@holdmyspot/shared';
import type { AiProvider, AiTask } from '@holdmyspot/shared/ports';
import type { FeeEstimateInput, ShippingEstimateInput } from '../ports/ai.ts';
import { FAKE_MODEL } from './fake.ts';
import { ESTIMATE_SYSTEM } from './prompts.ts';
import { fixtureKey } from './replay.ts';
import { SENTENCES_SCHEMA } from './schemas.ts';
import type { SentencesOutput } from './schemas.ts';
import { oneSentence, unitWord, units } from './text.ts';
import { hhmm } from './time.ts';
import type { EtaEstimate, EtaInput } from './types.ts';

/**
 * Fee, ETA, shipping and duty estimates (docs/AI-SERVICES.md 4.3 and 4.4).
 * Every number comes from the shared formulas in @holdmyspot/shared (the same
 * ones the rules-only fake uses) and the catalog. Outside rules-only mode a
 * model phrases the explanation; any failure keeps the written template.
 * The stamp says which one wrote the text.
 */

const templateStamp: AiStamp = { provider: 'fake', model: FAKE_MODEL, mode: 'fake', latencyMs: 0 };

async function modelSentences(provider: AiProvider | null, task: AiTask, facts: Record<string, unknown>, instruction: string): Promise<{ sentences: string[]; stamp: AiStamp } | null> {
  if (!provider || provider.mode === 'fake') return null;
  const prompt = `${instruction}\nFacts (JSON):\n${JSON.stringify(facts)}`;
  try {
    const res = await provider.json<SentencesOutput>({
      task,
      system: ESTIMATE_SYSTEM,
      prompt,
      images: [],
      schemaName: 'sentences',
      schema: SENTENCES_SCHEMA,
      effort: 'low',
      fixtureKey: fixtureKey({ task, schemaName: 'sentences', system: ESTIMATE_SYSTEM, prompt, images: [] }),
    });
    const sentences = res.data.sentences.map((s) => oneSentence(s)).filter(Boolean).slice(0, 3);
    return sentences.length > 0 ? { sentences, stamp: res.stamp } : null;
  } catch {
    // No fixture in replay, a timeout or a refusal: the template stands.
    return null;
  }
}

export async function feeEstimate(input: FeeEstimateInput, provider: AiProvider | null = null): Promise<FeeEstimate> {
  const { shop, item } = input;
  const people = input.latestLinePhoto?.peopleAhead ?? null;
  const wait = expectedWaitMinutes(item, people);
  const fee = suggestedFeeCents(item, wait);
  const clock = suggestedClock(item, fee);
  const per = unitWord(1, item.kind);
  const template = [
    input.latestLinePhoto && people !== null
      ? `Line photo at ${hhmm(input.latestLinePhoto.at, shop.timezone)} shows about ${people} people ahead: about ${wait} minutes of waiting.`
      : `${shop.name} usually has about a ${wait}-minute wait for this item.`,
    `Suggested fee ${formatUsd(fee, { exact: true })} per ${per} (estimate): about ${FEE_CENTS_PER_WAIT_MINUTE} cents per minute of waiting, and at least the ${formatUsd(item.minFeeCents, { exact: true })} minimum.`,
    `Suggested fee clock for helpers: ${formatUsd(clock.feeCents, { exact: true })}, down ${formatUsd(clock.stepCents, { exact: true })} every 5 minutes to a lowest fee of ${formatUsd(clock.floorCents, { exact: true })}.`,
  ];
  const written = await modelSentences(
    provider,
    'fee_estimate',
    { shop: shop.name, item: item.name, waitMinutes: wait, peopleAhead: people, suggestedFeeCents: fee, minFeeCents: item.minFeeCents, clock },
    'Explain this queue-fee estimate in two or three sentences. Amounts are US cents; write them as dollars.',
  );
  return {
    expectedWaitMinutes: wait,
    peopleAhead: people,
    suggestedFeeCents: fee,
    minFeeCents: item.minFeeCents,
    clock,
    basis: written?.sentences ?? template,
    ai: written?.stamp ?? templateStamp,
  };
}

export async function shippingEstimate(input: ShippingEstimateInput, provider: AiProvider | null = null): Promise<ShippingEstimate> {
  const { item, qty } = input;
  const n = shippingNumbers(item, qty);
  const ratePct = (DUTY_RATE_BPS[item.dutyCategory] ?? 0) / 100;
  const template = [
    `${units(qty, item.kind)} of ${item.weightGrams.toLocaleString('en-US')} g plus ${PACKING_GRAMS} g of packing make a ${n.parcelGrams.toLocaleString('en-US')} g parcel; ${n.service} charges ${formatUsd(SHIPPING_BASE_CENTS, { exact: true })} plus ${formatUsd(SHIPPING_PER_100G_CENTS, { exact: true })} per started 100 g.`,
    `Duty is estimated at ${ratePct}% of the declared value (an illustrative rate, not tax advice); the budget adds a 30% margin.`,
  ];
  const written = await modelSentences(
    provider,
    'shipping_estimate',
    { item: item.name, qty, parcelGrams: n.parcelGrams, shippingCents: n.shippingCents, dutyCents: n.dutyCents, dutyRatePercent: ratePct, budgetCents: n.budgetCents, service: n.service, days: n.days },
    'Explain this shipping and duty estimate in one or two sentences. Amounts are US cents; write them as dollars.',
  );
  return {
    parcelGrams: n.parcelGrams,
    shippingCents: n.shippingCents,
    dutyCents: n.dutyCents,
    budgetCents: n.budgetCents,
    service: n.service,
    days: { ...n.days },
    notes: [...(written?.sentences ?? template), ...SHIPPING_NOTES],
    ai: written?.stamp ?? templateStamp,
  };
}

/** Travel time, arrival, expected wait and earning rate for a queuer looking at a task (pure). */
export function estimateEta(input: EtaInput): EtaEstimate {
  const rules = input.rules ?? DEFAULT_RULES;
  const travel = travelMinutes(input.from, input.shop.lngLat, rules);
  const wait = input.waitMinutes ?? input.item.expectedWaitMinutes;
  const etaAt = input.now + travel * 60_000;
  const fee = input.feeCents !== undefined ? input.feeCents * (input.qty ?? 1) : null;
  return {
    distanceMeters: Math.round(distanceMeters(input.from, input.shop.lngLat)),
    travelMinutes: travel,
    etaAt,
    waitMinutes: wait,
    doneAt: etaAt + wait * 60_000,
    inRange: travel <= rules.maxTravelMinutes,
    centsPerHour: fee !== null ? Math.round((fee * 60) / Math.max(1, travel + wait)) : null,
  };
}
