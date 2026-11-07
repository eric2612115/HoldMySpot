/**
 * Why an AI call did not produce a usable answer. Services never let one of
 * these pass a proof: they fall back to "needs review", a template or the
 * rules-only policy, and say so on the result.
 */
export type AiErrorKind =
  /** No provider can serve this call (no key, SDK missing, network down). */
  | 'unavailable'
  | 'timeout'
  /** The model declined (stop_reason "refusal"). */
  | 'refusal'
  /** The answer was not JSON, was cut off, or did not match the schema. */
  | 'invalid_output'
  /** The provider answered with an HTTP error. */
  | 'http'
  /** Rules-only mode: this photo is not a demo fixture, so nothing was read. */
  | 'no_truth'
  /** The provider does not support this kind of call (for example tool use). */
  | 'unsupported';

export class AiError extends Error {
  readonly kind: AiErrorKind;
  readonly status: number | null;

  constructor(kind: AiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = 'AiError';
    this.kind = kind;
    this.status = status;
  }
}

export function asAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AiError('unavailable', message);
}
