import { ContractError, distanceMeters, zonedLocalToEpoch } from '@holdmyspot/shared';
import type { DemoCue, DemoScriptSummary, DemoState, FilePurpose, Job, LngLat, User } from '@holdmyspot/shared';
import type { App } from '../app/app.ts';
import { user as findUser } from '../app/catalog.ts';
import { saveUpload } from '../app/files.ts';
import { resetMarket } from '../app/seed.ts';
import { ALL } from '../app/views.ts';
import type { StoredFile } from '../db/store.ts';
import { placeholderPng } from '../util/images.ts';
import { uploadFixtureOr, uploadHash } from './fixtures.ts';

/**
 * The demo director (docs/ARCHITECTURE.md section 8). A script is an
 * ordered list of steps at market times; each step acts through the same
 * commands a persona would use (never writing rows directly). Steps run from
 * the scheduler at their exact market time, so the same script gives the
 * same screens every run. `wait_for` steps hold the script until something
 * happens (for example a real sandbox approval).
 */

export type StepKind =
  | 'bid.create'
  | 'bid.approve'
  | 'wait_for'
  | 'ask.create'
  | 'bid.claim'
  | 'move'
  | 'claim.checkIn'
  | 'job.bought'
  | 'job.proof'
  | 'job.shipment'
  | 'job.handover'
  | 'agent.run'
  | 'job.refund_request'
  | 'dispute.open'
  | 'clock.jump'
  | 'cue';

export interface StepContext {
  app: App;
  /** Market time of this step. */
  at: number;
  refs: Map<string, string>;
  ref(name: string): string;
  user(id: string): User;
  /** Market time of "HH:MM" on the script's day, in the script's zone. */
  time(hhmm: string): number;
  /** Uploads a placeholder photo whose bytes depend only on the label (with a simulated scenario for the fake AI). */
  upload(ownerId: string, purpose: FilePurpose, label: string, scenario: string | null): Promise<StoredFile>;
  /** Uploads the rendered fixture `<case>/<file>` when it exists (read for real by the AI services), else a placeholder. */
  photo(ownerId: string, purpose: FilePurpose, fixture: string | null, label: string, scenario: string | null): Promise<StoredFile>;
  /** The job of a queuer for a requester (latest first). */
  job(queuerId: string, requesterId: string): Job;
  cue(cue: DemoCue): void;
  /** Starts a synthetic walk (queuer.moved events) to `to`, arriving at `arriveAt`. */
  walk(userId: string, to: LngLat, arriveAt: number): void;
  jumpTo(hhmm: string): void;
}

export interface DemoStep {
  at: string;
  kind: StepKind;
  label: string;
  run(ctx: StepContext): Promise<void>;
  /** For wait_for: the script stays here until this is true. */
  until?(ctx: StepContext): boolean;
}

export interface DemoScript {
  id: string;
  title: string;
  description: string;
  /** ISO 8601 with offset. */
  startsAt: string;
  timeZone: string;
  speed: number;
  /** Runs after the reset, before the first step (for example an older photo for a duplicate check). */
  setup?(ctx: StepContext): Promise<void>;
  steps: DemoStep[];
}

interface Walk {
  userId: string;
  from: LngLat;
  to: LngLat;
  startAt: number;
  endAt: number;
  nextAt: number;
}

const WALK_SAMPLE_MS = 30_000;

export class Director {
  readonly #app: App;
  readonly #scripts: Map<string, DemoScript>;
  #script: DemoScript | null = null;
  #status: DemoState['status'] = 'idle';
  #index = 0;
  #seed: number;
  #refs = new Map<string, string>();
  #walks: Walk[] = [];

  constructor(app: App, scripts: DemoScript[]) {
    this.#app = app;
    this.#scripts = new Map(scripts.map((s) => [s.id, s]));
    this.#seed = app.config.seed;
  }

  scripts(): DemoScriptSummary[] {
    return [...this.#scripts.values()].map((s) => {
      const start = Date.parse(s.startsAt);
      const last = s.steps.at(-1);
      const end = last ? this.#timeOf(s, last.at) : start;
      return { id: s.id, title: s.title, description: s.description, startsAt: s.startsAt, speed: s.speed, steps: s.steps.length, durationMs: end - start };
    });
  }

  state(): DemoState {
    const step = this.#script?.steps[this.#index];
    return {
      enabled: true,
      scriptId: this.#script?.id ?? null,
      status: this.#status,
      stepIndex: this.#index,
      nextStepAt: step && !step.until && this.#status !== 'finished' ? this.#timeOf(this.#script!, step.at) : null,
      seed: this.#seed,
    };
  }

  #emitState(): void {
    this.#app.emit('demo.state', this.state(), ALL);
  }

  #timeOf(script: DemoScript, hhmm: string): number {
    const day = script.startsAt.slice(0, 10);
    const t = zonedLocalToEpoch(`${day} ${hhmm}`, script.timeZone);
    if (t === null) throw new ContractError('BAD_REQUEST', `Bad step time ${hhmm}.`);
    return t;
  }

  #script_(id: string): DemoScript {
    const s = this.#scripts.get(id);
    if (!s) throw new ContractError('NOT_FOUND', `No demo script ${id}.`, { scripts: [...this.#scripts.keys()] });
    return s;
  }

  #context(at: number): StepContext {
    const app = this.#app;
    const script = this.#script!;
    return {
      app,
      at,
      refs: this.#refs,
      ref: (name) => {
        const v = this.#refs.get(name);
        if (!v) throw new ContractError('CONFLICT', `Demo reference ${name} is not set yet.`);
        return v;
      },
      user: (id) => findUser(app, id),
      time: (hhmm) => this.#timeOf(script, hhmm),
      upload: (ownerId, purpose, label, scenario) =>
        saveUpload(app, ownerId, purpose, 'image/png', placeholderPng(`${script.id}/${label}`), { scenario, dHash: uploadHash(app) }),
      photo: (ownerId, purpose, fixture, label, scenario) =>
        uploadFixtureOr(app, ownerId, purpose, fixture, scenario, () =>
          saveUpload(app, ownerId, purpose, 'image/png', placeholderPng(`${script.id}/${label}`), { scenario, dHash: uploadHash(app) }),
        ),
      job: (queuerId, requesterId) => {
        const j = app.store.jobs.where('queuer_id = ? AND requester_id = ?', queuerId, requesterId).at(-1);
        if (!j) throw new ContractError('CONFLICT', `No job for ${queuerId} and ${requesterId} yet.`);
        return j;
      },
      cue: (cue) => app.emit('demo.cue', cue, ALL),
      walk: (userId, to, arriveAt) => {
        const home = app.store.users.must(userId).user.home ?? to;
        this.#walks = this.#walks.filter((w) => w.userId !== userId);
        this.#walks.push({ userId, from: home, to, startAt: at, endAt: arriveAt, nextAt: at });
      },
      jumpTo: (hhmm) => {
        const t = this.#timeOf(script, hhmm);
        if (t > app.clock.now()) app.clock.jumpTo(t);
        app.emit('clock.updated', app.clock.state(), ALL);
      },
    };
  }

  /** Resets the market to a script's start (idle until started). */
  async reset(scriptId: string | null, seed: number | null): Promise<DemoState> {
    const script = this.#script_(scriptId ?? this.#script?.id ?? this.#app.config.demoScript);
    this.#script = script;
    this.#seed = seed ?? this.#app.config.seed;
    this.#status = 'idle';
    this.#index = 0;
    this.#refs = new Map();
    this.#walks = [];
    await resetMarket(this.#app, { seed: this.#seed, marketStart: Date.parse(script.startsAt), speed: script.speed, paused: true, crowd: this.#app.config.crowd });
    if (script.setup) await script.setup(this.#context(this.#app.now()));
    this.#app.tx(() => this.#emitState());
    return this.state();
  }

  async start(scriptId: string, speed: number | null): Promise<DemoState> {
    await this.reset(scriptId, null);
    if (speed !== null) this.#app.clock.setSpeed(speed);
    this.#status = 'running';
    this.#app.clock.resume();
    this.#app.tx(() => {
      this.#app.emit('clock.updated', this.#app.clock.state(), ALL);
      this.#emitState();
    });
    return this.state();
  }

  pause(): DemoState {
    if (this.#status === 'running') this.#status = 'paused';
    this.#app.clock.pause();
    this.#app.tx(() => {
      this.#app.emit('clock.updated', this.#app.clock.state(), ALL);
      this.#emitState();
    });
    return this.state();
  }

  resume(): DemoState {
    // A finished script stays on its last moment; POST /api/demo/clock {"paused": false} runs the market on.
    if (this.#status === 'finished') return this.state();
    if (this.#status === 'paused' || this.#status === 'idle') this.#status = 'running';
    this.#app.clock.resume();
    this.#app.tx(() => {
      this.#app.emit('clock.updated', this.#app.clock.state(), ALL);
      this.#emitState();
    });
    return this.state();
  }

  /** Runs the next step now (jumping the clock to its time when it is still ahead). */
  async step(): Promise<DemoState> {
    const script = this.#script;
    const step = script?.steps[this.#index];
    if (!script || !step) return this.state();
    const at = this.#timeOf(script, step.at);
    if (at > this.#app.clock.now()) this.#app.clock.jumpTo(at);
    await this.#app.atTime(Math.max(at, this.#app.clock.now()), async () => {
      await this.#app.exec(() => this.#runStep(at));
      await this.#app.idle();
    });
    return this.state();
  }

  async #runStep(at: number): Promise<void> {
    const script = this.#script!;
    const step = script.steps[this.#index];
    if (!step) return;
    const ctx = this.#context(at);
    this.#app.inDemoStep = true;
    try {
      await step.run(ctx);
    } catch (err) {
      this.#app.log(`demo step ${this.#index} (${step.label}) failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.#app.inDemoStep = false;
    }
    this.#index++;
    if (this.#index >= script.steps.length) {
      // The market holds still on the closing numbers instead of running on at demo speed.
      this.#status = 'finished';
      this.#app.clock.pause();
      this.#app.saveClock();
      this.#app.tx(() => {
        this.#app.emit('clock.updated', this.#app.clock.state(), ALL);
        this.#emitState();
      });
      return;
    }
    this.#app.tx(() => this.#emitState());
  }

  /** The next thing the director needs to do, for the scheduler. */
  nextDue(): { at: number; run: () => Promise<void>; key: string } | null {
    if (this.#status !== 'running' || !this.#script) return null;
    const candidates: { at: number; run: () => Promise<void>; key: string }[] = [];
    const step = this.#script.steps[this.#index];
    if (step) {
      const at = this.#timeOf(this.#script, step.at);
      const ready = !step.until || step.until(this.#context(at));
      if (ready) {
        const when = step.until ? Math.max(at, this.#app.clock.now()) : at;
        const index = this.#index;
        candidates.push({ at: when, key: `demo:${this.#script.id}:${index}`, run: () => this.#runStep(when) });
      }
    }
    for (const w of this.#walks) {
      candidates.push({ at: w.nextAt, key: `walk:${w.userId}:${w.startAt}`, run: async () => this.#sampleWalk(w) });
    }
    candidates.sort((a, b) => a.at - b.at);
    return candidates[0] ?? null;
  }

  #sampleWalk(w: Walk): void {
    const t = w.nextAt;
    const f = w.endAt <= w.startAt ? 1 : Math.min(1, Math.max(0, (t - w.startAt) / (w.endAt - w.startAt)));
    const lngLat: LngLat = [w.from[0] + (w.to[0] - w.from[0]) * f, w.from[1] + (w.to[1] - w.from[1]) * f];
    const heading = (Math.atan2(w.to[0] - w.from[0], w.to[1] - w.from[1]) * 180) / Math.PI;
    this.#app.bus.live({
      seq: 0,
      type: 'queuer.moved',
      at: t,
      audience: ALL,
      data: { userId: w.userId, lngLat, heading: (heading + 360) % 360, synthetic: true },
    });
    if (f >= 1 || distanceMeters(lngLat, w.to) < 1) this.#walks = this.#walks.filter((x) => x !== w);
    else w.nextAt = Math.min(w.endAt, t + WALK_SAMPLE_MS);
  }
}
