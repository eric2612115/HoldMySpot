/**
 * Output schemas for every model call (docs/AI-SERVICES.md section 5), plus a
 * small validator. Providers are asked for structured output against these
 * schemas, and every result (live, replayed or fake) is validated again here
 * before any rule reads it.
 *
 * Nullable fields use `anyOf` with `{ type: 'null' }`, which both providers'
 * structured-output modes accept. No numeric or length constraints: they are
 * not supported by structured outputs and the rules check ranges anyway.
 */

export type JsonSchema = Record<string, unknown>;

const nullable = (schema: JsonSchema, description?: string): JsonSchema => ({
  anyOf: [schema, { type: 'null' }],
  ...(description ? { description } : {}),
});

export interface PurchaseExtraction {
  printedName: string | null;
  sellerTaxId: string | null;
  invoiceNumber: string | null;
  /** "YYYY-MM-DD HH:MM" as printed. */
  issuedAtLocal: string | null;
  currency: 'TWD' | 'USD' | null;
  lines: { name: string; qty: number; unitMinor: number; totalMinor: number }[];
  totalMinor: number | null;
  itemPhoto: { codeSeen: string | null; unitsVisible: number | null };
  anomalies: string[];
}

export const PURCHASE_PROOF_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['printedName', 'sellerTaxId', 'invoiceNumber', 'issuedAtLocal', 'currency', 'lines', 'totalMinor', 'itemPhoto', 'anomalies'],
  properties: {
    printedName: nullable({ type: 'string' }, 'Shop name as printed at the top of the receipt'),
    sellerTaxId: nullable({ type: 'string' }, 'Store, seller or business ID as printed, digits only'),
    invoiceNumber: nullable({ type: 'string' }, 'Invoice or receipt number as printed'),
    issuedAtLocal: nullable({ type: 'string' }, 'Printed date and time as YYYY-MM-DD HH:MM (24-hour)'),
    currency: nullable({ type: 'string', enum: ['TWD', 'USD'] }),
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'qty', 'unitMinor', 'totalMinor'],
        properties: {
          name: { type: 'string' },
          qty: { type: 'integer' },
          unitMinor: { type: 'integer', description: 'Unit price in minor units (TWD: whole dollars, USD: cents)' },
          totalMinor: { type: 'integer', description: 'Line total in minor units' },
        },
      },
    },
    totalMinor: nullable({ type: 'integer' }, 'Printed grand total in minor units'),
    itemPhoto: {
      type: 'object',
      additionalProperties: false,
      required: ['codeSeen', 'unitsVisible'],
      properties: {
        codeSeen: nullable({ type: 'string' }, 'Code written on the note next to the item, letters and digits only'),
        unitsVisible: nullable({ type: 'integer' }, 'Units of the item visible in the second photo'),
      },
    },
    anomalies: { type: 'array', items: { type: 'string' } },
  },
};

export interface CheckInExtraction {
  lineVisible: boolean;
  peopleAhead: number | null;
  codeSeen: string | null;
  storefrontText: string | null;
}

export const CHECK_IN_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['lineVisible', 'peopleAhead', 'codeSeen', 'storefrontText'],
  properties: {
    lineVisible: { type: 'boolean', description: 'True when a line of waiting people is visible' },
    peopleAhead: nullable({ type: 'integer' }, 'Approximate number of people visible in the line'),
    codeSeen: nullable({ type: 'string' }, 'One-time code shown on a card or screen, letters and digits only'),
    storefrontText: nullable({ type: 'string' }, 'Shop sign or storefront text'),
  },
};

export interface AgentDecisionOutput {
  action: 'raise_fee' | 'lower_fee' | 'keep' | 'reduce_qty' | 'cancel';
  maxFeeCents: number | null;
  qty: number | null;
  reason: string;
}

/** Decision mode for providers without tool calling: one JSON answer per run. */
export const AGENT_DECISION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'maxFeeCents', 'qty', 'reason'],
  properties: {
    action: { type: 'string', enum: ['raise_fee', 'lower_fee', 'keep', 'reduce_qty', 'cancel'] },
    maxFeeCents: nullable({ type: 'integer' }, 'New max fee per unit in US cents, for raise_fee or lower_fee'),
    qty: nullable({ type: 'integer' }, 'New quantity, for reduce_qty'),
    reason: { type: 'string', description: 'One plain sentence for the requester' },
  },
};

export interface SentencesOutput {
  sentences: string[];
}

/** Short explanations written by a model (estimate basis, notes). */
export const SENTENCES_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['sentences'],
  properties: { sentences: { type: 'array', items: { type: 'string' } } },
};

// ---------------------------------------------------------------------------
// Validator (the subset of JSON Schema used above)
// ---------------------------------------------------------------------------

function typeOk(type: string, v: unknown): boolean {
  switch (type) {
    case 'null':
      return v === null;
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'integer':
      return typeof v === 'number' && Number.isInteger(v);
    case 'number':
      return typeof v === 'number' && Number.isFinite(v);
    case 'array':
      return Array.isArray(v);
    case 'object':
      return typeof v === 'object' && v !== null && !Array.isArray(v);
    default:
      return false;
  }
}

/** Returns the problems found ("$.lines[0].qty: expected integer"), empty when valid. */
export function validateJson(schema: JsonSchema, value: unknown, path = '$'): string[] {
  const errors: string[] = [];
  const anyOf = schema.anyOf as JsonSchema[] | undefined;
  if (anyOf) {
    const branches = anyOf.map((s) => validateJson(s, value, path));
    if (!branches.some((b) => b.length === 0)) errors.push(`${path}: matches none of the allowed shapes`);
    return errors;
  }
  const type = schema.type as string | string[] | undefined;
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type];
    if (!types.some((t) => typeOk(t, value))) {
      errors.push(`${path}: expected ${types.join(' or ')}`);
      return errors;
    }
  }
  const en = schema.enum as unknown[] | undefined;
  if (en && !en.includes(value)) errors.push(`${path}: not one of ${en.map((e) => JSON.stringify(e)).join(', ')}`);
  if (Array.isArray(value) && schema.items) {
    value.forEach((v, i) => errors.push(...validateJson(schema.items as JsonSchema, v, `${path}[${i}]`)));
  }
  if (typeOk('object', value) && schema.properties) {
    const obj = value as Record<string, unknown>;
    const props = schema.properties as Record<string, JsonSchema>;
    for (const key of (schema.required as string[] | undefined) ?? []) {
      if (!(key in obj)) errors.push(`${path}.${key}: missing`);
    }
    for (const [key, v] of Object.entries(obj)) {
      const sub = props[key];
      if (!sub) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key}: not allowed`);
        continue;
      }
      errors.push(...validateJson(sub, v, `${path}.${key}`));
    }
  }
  return errors;
}
