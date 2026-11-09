# Needs a person

The ops console's third page (`#/people`): the hard calls the AI and the rules could not settle, one row per open case. AI runs the routine; only these reach a person. Decisions: [DECISIONS.md](DECISIONS.md) D-160, D-161. Routes: [API.md](API.md).

| Kind | When a row appears | What a person does | Route |
|---|---|---|---|
| Receipt to review | A proof is `needs_review`: the AI and the rules could not settle it | Pass or Fail | `POST /api/ops/proofs/:proofId/review` |
| Refund | The requester asked for money back (`POST /api/jobs/:jobId/refund-request`), a job failed with money still captured, or a person picks a job from "Refund a job" | Enter an amount up to what is refundable and a reason; or Decline | `POST /api/ops/jobs/:jobId/refund`, `.../refund-request/close` |
| Dispute | The status sync found an open PayPal dispute on one of our `HMS-` invoices | Review the note, Send (evidence), Accept claim; or Settle (sandbox only) | `POST /api/ops/disputes/:disputeId/evidence`, `/accept`, `/adjudicate` |

No charge until the receipt passes AI reading, rules or human review. Receipts that fail the checks move $0.

## Where the money rules are

- A refund is capped by `capturedCents - refundedCents` in `refundJob` (`server/src/app/money.ts`). More is refused with `INVALID_AMOUNT`.
- The same `Idempotency-Key` replays the answer and moves nothing again. The console derives the key from the case, so a double click is one action.
- A job with an open dispute cannot be refunded here (`CONFLICT`): PayPal could return the same money twice. Settle the dispute first.
- A dispute PayPal settles for the buyer adds one `refunded` ledger line, keyed by the dispute id, and what is left to refund shrinks by it.
- Evidence is sent once, and accept or adjudicate once: a repeat is refused before it reaches PayPal.
- A dispute settled for the buyer is booked from PayPal's outcome; whether to recover a payout already sent to the queuer is a person's call.

## The AI's note on a dispute

The model words a short note from facts code supplies: the receipt it read, the tracking number, the ledger. It decides nothing about money or the outcome. `disputeNote` in `server/src/ai/notes.ts`:

- A number in the model's note that the facts do not hold sends the note back to the template.
- With no model, or on a provider error, the plain template (`shared/src/disputeNote.ts`) writes it, and the row says so.
- Provider, model and mode are stamped on the draft like other AI results.

A person reads and can edit the text, then presses Send. Receipt and item photos, receipt fields and tracking are attached by code from the job.

## Try it with no keys

- **In-browser replay:** `http://127.0.0.1:5197/?backend=mock&at=11:21#/people`, exactly one row of each kind. These are three side errands, separate from the hero day's money. The buttons stay in this browser; no PayPal, no model.
- **Live zero-key server:** run `npm run demo`, then the script below, then open `http://127.0.0.1:5197/#/people`. PayPal here is the emulator. A second run starts over.

```sh
curl -s -X POST http://127.0.0.1:8796/api/demo/start -H 'content-type: application/json' -d '{"scriptId":"needs-person","speed":600}'
```

The `needs-person` script runs three errands on its own market: Wei's receipt reprinted at the cap (the listed-price check sends it to a person), Jun's refund request, Priya's "item not received" dispute. To return to the hero day, `POST /api/demo/reset` with `{"scriptId":"hero"}`.

## On PayPal's sandbox

- **Gate G7:** a buyer's "item not received" dispute (`PP-R-UEL-10196964`) was settled in the seller's favour with `adjudicate` on the real sandbox and read back `RESOLVED_SELLER_FAVOUR` ([SANDBOX-GATES.md](SANDBOX-GATES.md)).
- **Through the console's routes** (`node scripts/sandbox-gates.mjs people`, with `HMS_SECRETS_DIR` set, 2026-11-08): a refund went through the route (a request over the limit refused, the same key twice one refund) and PayPal reads the capture `PARTIALLY_REFUNDED`. The status sync found the buyer's dispute on the job, and the seller's note was drafted for this page.
- The evidence, accept and adjudicate routes are covered by `npm test` on the emulator, which copies PayPal's recorded dispute answers.

`node scripts/sandbox-gates.mjs people --dispute <id> [--outcome buyer|seller] [--wait <minutes>]` runs the dispute steps for an open dispute on a fresh server.
