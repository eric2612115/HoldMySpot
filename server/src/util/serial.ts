/**
 * Runs async functions one at a time in call order. Every command that
 * changes market state goes through one of these, so matching, money calls
 * and status changes never interleave.
 */
export class Serial {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(fn: () => Promise<T> | T): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Limits how many async tasks run at once (the AI queue runs two). */
export class Semaphore {
  #free: number;
  readonly #waiting: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((resolve) => this.#waiting.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/** Rejects with `onTimeout()` when `p` does not settle within `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}
