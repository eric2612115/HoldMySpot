import {
  disputeNoteTemplate,
  evaluateCheckIn,
  evaluatePurchase,
  expectedWaitMinutes,
  formatUsd,
  shippingNumbers,
  suggestedClock,
  suggestedFeeCents,
  SHIPPING_NOTES,
  epochToZonedLocal,
} from '@holdmyspot/shared';
import type { AiStamp, FeeEstimate, ShippingEstimate } from '@holdmyspot/shared';
import type {
  AiPort,
  CheckInPhotoInput,
  CheckInPhotoResult,
  DisputeNoteInput,
  DisputeNoteResult,
  FeeEstimateInput,
  PurchaseProofInput,
  PurchaseProofResult,
  ReassignNoteInput,
  ShippingEstimateInput,
} from '../ports/ai.ts';
import { lineReading, purchaseReading } from './scenarios.ts';

/**
 * Rules-only AI for fake mode and tests (provider "fake", model "rules-v1",
 * mode "fake"). Photo readings come from simulated scenarios
 * (fakes/scenarios.ts); every decision and amount comes from the shared rules
 * and formulas, the same code the real AI services use. Each photo verdict's
 * stamp names the simulated reading (`ai.simulated`, D-128), so no screen
 * says a model checked the photo.
 */
export class FakeAi implements AiPort {
  readonly info = { provider: 'fake' as const, model: 'rules-v1', mode: 'fake' as const };

  #stamp(simulated?: string): AiStamp {
    return { ...this.info, latencyMs: 0, ...(simulated ? { simulated } : {}) };
  }

  async checkInPhoto(input: CheckInPhotoInput): Promise<CheckInPhotoResult> {
    const reading = lineReading(input.photo.scenario, input);
    const verdict = evaluateCheckIn(reading, {
      code: input.claim.checkInCode ?? '',
      geofence: input.geofence,
      duplicateOf: input.duplicateOf,
    });
    // No model read this photo: the stamp names the simulated reading the rules got (D-128).
    return { ...verdict, ai: this.#stamp(input.photo.scenario ?? 'line_ok') };
  }

  async purchaseProof(input: PurchaseProofInput): Promise<PurchaseProofResult> {
    const scenarios = [...new Set([input.receipt.scenario, input.itemPhoto.scenario].filter((s): s is string => s !== null))];
    const reading = purchaseReading(scenarios, input);
    const verdict = evaluatePurchase(reading, {
      shop: input.shop,
      item: input.item,
      job: {
        qty: input.job.qty,
        proofCode: input.job.proofCode ?? '',
        retailCapCents: input.job.caps.retailCents,
        twdPerUsd: input.job.fx?.twdPerUsd ?? null,
      },
      checkedInAt: input.checkedInAt,
      uploadedAt: input.uploadedAt,
      duplicateOf: input.duplicateOf,
    });
    return { ...verdict, ai: this.#stamp(scenarios.join('+') || 'genuine') };
  }

  async feeEstimate(input: FeeEstimateInput): Promise<FeeEstimate> {
    const people = input.latestLinePhoto?.peopleAhead ?? null;
    const wait = expectedWaitMinutes(input.item, people);
    const fee = suggestedFeeCents(input.item, wait);
    const clock = suggestedClock(input.item, fee);
    const basis: string[] = [];
    if (input.latestLinePhoto && people !== null) {
      basis.push(`Line photo at ${epochToZonedLocal(input.latestLinePhoto.at, input.shop.timezone).slice(11)} shows about ${people} people ahead.`);
    } else {
      basis.push(`${input.shop.name} usually has about a ${input.item.expectedWaitMinutes}-minute wait for this item.`);
    }
    basis.push(`Suggested fee ${formatUsd(fee, { exact: true })} per unit for about ${wait} minutes in line (estimate).`);
    return {
      expectedWaitMinutes: wait,
      peopleAhead: people,
      suggestedFeeCents: fee,
      minFeeCents: input.item.minFeeCents,
      clock,
      basis,
      ai: this.#stamp(),
    };
  }

  async shippingEstimate(input: ShippingEstimateInput): Promise<ShippingEstimate> {
    const s = shippingNumbers(input.item, input.qty);
    return {
      parcelGrams: s.parcelGrams,
      shippingCents: s.shippingCents,
      dutyCents: s.dutyCents,
      budgetCents: s.budgetCents,
      service: s.service,
      days: s.days,
      notes: [...SHIPPING_NOTES],
      ai: this.#stamp(),
    };
  }

  async disputeNote(input: DisputeNoteInput): Promise<DisputeNoteResult> {
    return { text: disputeNoteTemplate(input.facts), ai: this.#stamp(), template: true, templateReason: 'no_model' };
  }

  async reassignNote(input: ReassignNoteInput): Promise<string> {
    const units = `${input.job.qty === 1 ? 'The unit' : `The ${input.job.qty} units`}`;
    if (!input.takenBy) return `${input.job.queuerName}'s job ended (${input.reason}); ${units.toLowerCase()} went back to the book.`;
    return `${input.job.queuerName}'s job ended (${input.reason}); ${units.toLowerCase()} went back to the book and ${input.takenBy.queuerName}'s offer (${formatUsd(input.takenBy.feeCents, { exact: true })}) took it.`;
  }
}
