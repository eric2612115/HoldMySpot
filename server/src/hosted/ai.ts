import { ContractError } from '@holdmyspot/shared';
import type { OpsAgentTurnRequest, OpsAgentTurnResponse } from '@holdmyspot/shared';
import { AiError } from '../ai/errors.ts';
import type { AiPort, CheckInPhotoInput, CheckInPhotoResult, PurchaseProofInput, PurchaseProofResult } from '../ports/ai.ts';
import type { HostedSettings } from './settings.ts';

/**
 * AI of a hosted market (D-163). Demo photos and everything else replay recorded answers. A
 * visitor's own photo (no recording, no simulated reading picked) gets a real model read when the
 * service has a key and the caps allow; the two ops agents think live under the same rule. Past a
 * cap the existing behaviour returns: the phone offers simulated readings, an unread photo goes to
 * a person, and the console's agents use their offline planner; the message says why.
 */

export interface MarketAiUse {
  reads: number;
  turns: number;
}

/** The live-AI allowance for the whole service, per UTC day, and the per-market caps. */
export class AiBudget {
  readonly #s: HostedSettings;
  readonly #now: () => number;
  #day = '';
  #reads = 0;
  #turns = 0;

  constructor(settings: HostedSettings, now: () => number = Date.now) {
    this.#s = settings;
    this.#now = now;
  }

  #roll(): void {
    const day = new Date(this.#now()).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#reads = 0;
      this.#turns = 0;
    }
  }

  readsLeft(use: MarketAiUse): number {
    this.#roll();
    return Math.max(0, Math.min(this.#s.aiReadsPerMarket - use.reads, this.#s.aiReadsPerDay - this.#reads));
  }

  turnsLeft(use: MarketAiUse): number {
    this.#roll();
    return Math.max(0, Math.min(this.#s.aiTurnsPerMarket - use.turns, this.#s.aiTurnsPerDay - this.#turns));
  }

  takeRead(use: MarketAiUse): boolean {
    if (this.readsLeft(use) <= 0) return false;
    use.reads++;
    this.#reads++;
    return true;
  }

  takeTurn(use: MarketAiUse): boolean {
    if (this.turnsLeft(use) <= 0) return false;
    use.turns++;
    this.#turns++;
    return true;
  }
}

const PAST_CAP = 'The live AI reads of this hosted demo are used up for now, so nothing read this photo: pick a simulated reading, or a person reviews it.';

export class HostedAi implements AiPort {
  readonly #replay: AiPort;
  readonly #live: AiPort | null;
  readonly #budget: AiBudget;
  readonly #use: MarketAiUse;

  constructor(replay: AiPort, live: AiPort | null, budget: AiBudget, use: MarketAiUse) {
    this.#replay = replay;
    this.#live = live;
    this.#budget = budget;
    this.#use = use;
  }

  /** The replay port's: the phones keep offering simulated readings next to a real read. */
  get info(): AiPort['info'] {
    return this.#replay.info;
  }

  async #ownPhoto<T>(scenario: string | null, replay: () => Promise<T>, live: (port: AiPort) => Promise<T>): Promise<T> {
    try {
      return await replay();
    } catch (err) {
      if (!(err instanceof AiError) || err.kind !== 'no_truth' || scenario !== null || !this.#live) throw err;
      if (!this.#budget.takeRead(this.#use)) throw new AiError('unavailable', PAST_CAP);
      return live(this.#live);
    }
  }

  checkInPhoto(input: CheckInPhotoInput): Promise<CheckInPhotoResult> {
    return this.#ownPhoto(input.photo.scenario, () => this.#replay.checkInPhoto(input), (p) => p.checkInPhoto(input));
  }

  purchaseProof(input: PurchaseProofInput): Promise<PurchaseProofResult> {
    return this.#ownPhoto(input.receipt.scenario ?? input.itemPhoto.scenario, () => this.#replay.purchaseProof(input), (p) => p.purchaseProof(input));
  }

  feeEstimate: AiPort['feeEstimate'] = (input) => this.#replay.feeEstimate(input);
  shippingEstimate: AiPort['shippingEstimate'] = (input) => this.#replay.shippingEstimate(input);
  reassignNote: NonNullable<AiPort['reassignNote']> = async (input) => (this.#replay.reassignNote ? this.#replay.reassignNote(input) : '');
  disputeNote: NonNullable<AiPort['disputeNote']> = (input) => {
    if (!this.#replay.disputeNote) throw new AiError('unavailable', 'No note writer on this server.');
    return this.#replay.disputeNote(input);
  };
  dHash: NonNullable<AiPort['dHash']> = async (bytes, contentType) => (this.#replay.dHash ? this.#replay.dHash(bytes, contentType) : null);
  biddingAgent: NonNullable<AiPort['biddingAgent']> = (input) => {
    if (!this.#replay.biddingAgent) throw new AiError('unavailable', 'No bidding agent on this server.');
    return this.#replay.biddingAgent(input);
  };

  async opsAgentTurn(req: OpsAgentTurnRequest): Promise<OpsAgentTurnResponse> {
    const turn = this.#live?.opsAgentTurn?.bind(this.#live);
    if (!turn) throw new ContractError('AI_UNAVAILABLE', 'No AI model on this hosted demo: the console uses its offline planner and rules.');
    if (!this.#budget.takeTurn(this.#use)) throw new ContractError('AI_UNAVAILABLE', 'The live agent turns of this hosted demo are used up for now: the console uses its offline planner and rules.', { kind: 'cap' });
    return turn(req);
  }
}
