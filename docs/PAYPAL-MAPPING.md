# PayPal mapping

Status: proposed, 2026-11-07. Every PayPal call goes through the `PayPalPort` interface in `shared/src/ports.ts`. The server has two implementations: `server/src/paypal/fake.ts` (no network, same rules) and `server/src/paypal/sandbox.ts` (our own REST wrappers). Money rules are in [DOMAIN.md](DOMAIN.md) section 7; owner setup steps and gate results are in [SANDBOX-GATES.md](SANDBOX-GATES.md).

Items marked **probe** are not yet proven in our sandbox. Everything else in sections 2 and 8 was run against the real sandbox on 11-07 (section 12); the sanitized answers are test fixtures in `server/test/paypal/fixtures/recorded/`.

## 1. Accounts and roles

| Role | Sandbox account | Where it comes from |
|---|---|---|
| Platform merchant (payee of every hold, sender of every payout) | Existing sandbox app, US business account `<sandbox business account>` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_EMAIL`, `PAYPAL_MERCHANT_ID` in `sandbox.env` in the secrets folder (`.secrets/` written by `npm run keys`, or `HMS_SECRETS_DIR`) |
| Requester (buyer) | US personal account `<sandbox personal account>` (or a dedicated judge buyer) | `PAYPAL_BUYER_EMAIL`; the password is typed only on PayPal's own pages |
| Queuer payout receiver | Any US personal sandbox account other than the buyer (no Taiwan account is needed, owner 11-07) | `PAYPAL_PAYOUT_EMAIL` (its older name `PAYPAL_TW_PAYOUT_EMAIL` is still read, D-17). When `sandbox.env` has none (true on 11-07), the gate script takes `--payout-to <label>` from `sandbox-buyers.json` (never the buyer) and hands it to the server it starts as `PAYPAL_PAYOUT_EMAIL` in the environment (D-69). |

The platform app's transaction and dispute history can hold objects that are not HoldMySpot's. Every object we create carries an `HMS-` prefixed `invoice_id` and our id in `custom_id`; the poller, the webhook handler and the dispute list ignore anything without that prefix.

## 2. Step by step

Base URL `https://api-m.sandbox.paypal.com`. Every POST sends `PayPal-Request-Id: <idempotency key>` (keys in DOMAIN.md section 7) and `Prefer: return=representation`. Amounts are strings from `toPayPalValue(cents)`.

| # | Our step (trigger) | PayPal call | Notes |
|---|---|---|---|
| 0 | Any call | `POST /v1/oauth2/token` (client credentials) | Token cached in memory until 60 s before `expires_in`; never logged. |
| 1 | Bid form loads | Browser: JS SDK v6 core | `GET /api/config` gives `clientId`, `sdkUrl` and `testBuyerCountry`. See section 3. |
| 2 | `POST /api/bids` | `POST /v2/checkout/orders`, intent `AUTHORIZE` | Amount = bid limit, the processing reserve included as its own item line (D-105). Section 4. With `payment_source` PayPal answers **200** (not 201), status `PAYER_ACTION_REQUIRED`, a `payer-action` link to `www.sandbox.paypal.com/checkoutnow`. |
| 3 | Buyer approves; `POST /api/bids/:id/authorize` | `POST /v2/checkout/orders/{id}/authorize` | 201. Read `purchase_units[0].payments.authorizations[0]`: id, status, amount, `expiration_time` (29 days). Only `CREATED` for the hold's exact amount opens the request; `PENDING` waits for a later GET of the authorization, `DENIED` or another amount fails it and another amount is voided (D-150); funding from the `payment_source` key. The sandbox buyer's approval with `GET_FROM_FILE` returned **no** shipping address (11-07); nothing in the server reads it (the destination comes from the bid). `INSTRUMENT_DECLINED`: restart the SDK session so the buyer can pick another method. |
| 4 | Sweeper, day 4 to 29, untouched hold of an open bid | `POST /v2/payments/authorizations/{id}/reauthorize` with the same amount | Returns a NEW authorization id; new 3-day honor period; validity still from the original. Never more than the original (PayPal would allow up to 115%, at most +$75, in the US). Before day 4 PayPal refuses with `REAUTHORIZATION_TOO_SOON`, whose text says "only allowed once from Day 4 to Day 29" (11-07); a second renewal of the same original is **probe** (G10 `--probe-second`), as are Venmo-funded holds. |
| 5 | Proof verified (ship mode) | `POST /v2/payments/authorizations/{id}/capture` with `final_capture: false`, `invoice_id: HMS-<jobId>-R` | Retail from the checked receipt (capped), the matched fee and processing at cost: this capture's own PayPal fee plus $0.25 for each of the job's two payouts, grossed up so the net pays them exactly (D-105). 201 and `COMPLETED` at once in the sandbox. PayPal's own fee is in `seller_receivable_breakdown.paypal_fee`: 3.49% + $0.49 (the hero's $48.69 receipt capture: $2.19); the server stores it on the ledger line and the job and checks it against `PAYPAL_PRICING`. Payout of the fee only after status `COMPLETED`. Once the authorization is closed, GET shows `final_capture: true` on every one of its captures, including this one: the server keeps what it sent. |
| 6 | `POST /api/jobs/:id/shipment` | `POST /v2/checkout/orders/{orderId}/track` with `capture_id` of step 5, `carrier: "OTHER"`, `carrier_name_other` | Fictional carrier name. `notify_payer: true`. 201 with the order; the tracker id is `<captureId>-<trackingNumber>` (dashes in the number are fine); the same tracker again answers 200 and adds nothing; a capture of another order is `CAPTURE_ID_NOT_FOUND`. The buyer sees the carrier and number on PayPal's "Report a problem" page. |
| 7 | Right after step 6 | Capture again, `final_capture` from `isFinalCapture`, `invoice_id: HMS-<jobId>-S` | Shipping and prepaid duty as the queuer declares them (capped at the budget), plus this capture's own PayPal fee at cost. A final capture releases the rest. |
| 8 | `POST /api/jobs/:id/handover` (local mode) | One capture, `invoice_id: HMS-<jobId>-H` | Retail plus fee plus processing at cost (its PayPal fee and the one payout's $0.25), final if it is the last possible capture. Nothing is captured at the receipt in local mode. On the sandbox (11-08, run `20261108-1357-lifecycle-local`): $48.43 on Sam's $50.50 hold, `COMPLETED`, PayPal's fee $2.18, net $46.25 = $34.00 + $12.00 + $0.25; the final capture released $2.07 and the order shows no shipping. |
| 9 | Bid ends with nothing left to capture | `POST /v2/payments/authorizations/{id}/void` | Also after partial captures: 200 with the authorization `VOIDED` (G3). After a final capture PayPal refuses with `PREVIOUSLY_CAPTURED`. |
| 10 | After a COMPLETED capture | `POST /v1/payments/payouts` | One item per batch; `sender_batch_id` = our key (`payout:job_0001:fee@<run>` is accepted); `recipient_type: EMAIL`. 201, batch `PENDING`, no items yet. Section 5. |
| 11 | Poller | `GET /v1/payments/payouts/{batch_id}` | Item `transaction_status` to our payout status. The first read (right after creating) showed the item `PENDING` in all three sandbox payouts; 15 to 25 s later `SUCCESS` with the batch still `PROCESSING`, then `SUCCESS`. PayPal charged the platform $0.25 per item (`payout_item_fee`, stored on the payout; the requester's processing line covered it). |
| 12 | `POST /api/ops/jobs/:id/refund`, or not shipped in 5 days | `POST /v2/payments/captures/{id}/refund` | Partial or full. `invoice_id: HMS-<jobId>-F<n>`. |
| 13 | Buyer opens a dispute (sandbox site) | Poll `GET /v1/customer/disputes?start_time=...`, then `GET /v1/customer/disputes/{id}` | Keep only disputes whose transactions carry our invoice ids. The list items carry only `buyer_transaction_id` and the parties' ids, so the client reads every dispute in full (fixed 11-07: it used to drop all of them). |
| 14 | Ops sends evidence | `POST /v1/customer/disputes/{id}/provide-evidence` (multipart) | Receipt photo, item photo, AI and rule checks as text, tracking. |
| 15 | Ops accepts | `POST /v1/customer/disputes/{id}/accept-claim` | |
| 16 | Ops settles (sandbox only) | `POST /v1/customer/disputes/{id}/adjudicate` with `BUYER_FAVOR` or `SELLER_FAVOR` | `require-evidence` is also sandbox-only. On 11-07 a buyer's "item not received" report became a claim at once (`UNDER_REVIEW`, stage `CHARGEBACK`, `dispute_state: UNDER_PAYPAL_REVIEW`, money `HELD`). For the first 10 to 13 minutes its only offered action was `provide-supporting-info` and adjudicate answered 400 `ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE`; 23 minutes in, the dispute's links offered `accept_claim`, `adjudicate` and `require_evidence`, adjudicate `SELLER_FAVOR` answered 200, and about 3 minutes later the dispute read `RESOLVED` (`RESOLVED_SELLER_FAVOUR`, reason `INELIGIBLE_BUYER_PROTECTION_POLICY`). Adjudicate once, then read back. |
| 17 | `POST /api/paypal/webhook` | `POST /v1/notifications/verify-webhook-signature` | Needs `PAYPAL_WEBHOOK_ID` and a public URL. Section 6. |
| 18 | Unclaimed payout to cancel | `POST /v1/payments/payouts-item/{id}/cancel` | Only while `UNCLAIMED`; otherwise HTTP 400 `ITEM_INCORRECT_STATUS` (name only, no details). |

## 3. Browser: JS SDK v6

Built in `web/src/services/payments/paypalV6.ts` and proven on the sandbox on 11-07: the web app approved AUTHORIZE orders created with a `payment_source` through these sessions, a max-fee hold, Book now and a Venmo-funded hold (`7RB884471X718305E`, so `findEligibleMethods` offered Venmo; [WEB-INTEGRATION.md](WEB-INTEGRATION.md) section 5), then the hero's $63.70 hold in the web app run (order `0LK56938DW451581H`, authorization `88232929HR885933A`, D-121; [PayPal's window](../proto-shots/v3/final/03-paypal-window.png)). The session API names below match PayPal's v6 web SDK notes; the web app also passes `locale: 'en-US'` to `createInstance`.

```js
// script: https://www.sandbox.paypal.com/web-sdk/v6/core  (from GET /api/config: paypal.sdkUrl)
const sdk = await window.paypal.createInstance({
  clientId,                                   // GET /api/config: paypal.clientId
  components: ['paypal-payments', 'venmo-payments'],
  pageType: 'checkout',
  testBuyerCountry: 'US',                     // sandbox only
});
const methods = await sdk.findEligibleMethods({ currencyCode: 'USD' });
// Show <venmo-button> only if methods.isEligible('venmo'); Pay Later only if config allows 'paylater'.
const session = sdk.createPayPalOneTimePaymentSession({          // or createVenmoOneTimePaymentSession
  onApprove: ({ orderId }) => api('POST /api/bids/:bidId/authorize', { bidId }, { orderId }),
  onCancel: () => api('POST /api/bids/:bidId/approval-failed', { bidId }, { reason: 'cancelled', detail: null }),
  onError: (e) => api('POST /api/bids/:bidId/approval-failed', { bidId }, { reason: 'error', detail: String(e) }),
});
await session.start({ presentationMode: 'auto' }, createBid().then((r) => ({ orderId: r.checkout.orderId })));
```

`createPayLaterOneTimePaymentSession` exists for the Pay Later button; Pay Later with intent AUTHORIZE is still **probe** G5. Venmo is gate G4, recorded as partial on 11-08 (`record G4 partial --order 03979024TL691052W`): PayPal's own order for the Venmo-button hold records `payment_source` `venmo` and intent `AUTHORIZE`, with authorization `7RB884471X718305E` `CREATED`, but no Venmo-funded hold has been captured yet, which G4's pass also asks for (section 7). Buttons are PayPal's own components, unaltered. In fake mode (`checkout.next === 'fake_approve'`) the web shows its own plainly labelled "Simulated PayPal" sheet and calls `POST /api/fake/paypal/orders/:orderId/approve`.

## 4. Order body

Mia's request for the hero errand, as the server sends it. Run `20261107-2047` sent these purchase-unit values; PayPal's copy is `server/test/paypal/fixtures/recorded/20261107-2047-lifecycle/001-orders.get-200.json`. In sandbox mode the invoice id carries the market run id (D-50), and `return_url` and `cancel_url` name the server's own host and port.

```json
{
  "intent": "AUTHORIZE",
  "purchase_units": [{
    "reference_id": "bid_0001",
    "custom_id": "bid_0001",
    "invoice_id": "HMS-mw6ef7ny-bid_0001",
    "description": "HoldMySpot hold: up to $63.70 for 1 x Mochi Bunny plush, cherry blossom drop",
    "soft_descriptor": "HOLDMYSPOT",
    "amount": {
      "currency_code": "USD", "value": "63.70",
      "breakdown": {
        "item_total": { "currency_code": "USD", "value": "51.70" },
        "shipping": { "currency_code": "USD", "value": "12.00" }
      }
    },
    "items": [
      { "name": "Mochi Bunny plush, cherry blossom drop (shop price, up to)", "quantity": "1",
        "unit_amount": { "currency_code": "USD", "value": "36.00" }, "category": "PHYSICAL_GOODS" },
      { "name": "Queue fee (up to)", "quantity": "1",
        "unit_amount": { "currency_code": "USD", "value": "12.00" } },
      { "name": "Processing and payouts, at cost (up to)", "quantity": "1",
        "unit_amount": { "currency_code": "USD", "value": "3.70" } }
    ]
  }],
  "payment_source": {
    "paypal": {
      "experience_context": {
        "brand_name": "HoldMySpot",
        "shipping_preference": "GET_FROM_FILE",
        "user_action": "CONTINUE",
        "return_url": "http://127.0.0.1:8796/api/paypal/return",
        "cancel_url": "http://127.0.0.1:8796/api/paypal/cancel"
      }
    }
  }
}
```

- `payment_source` uses the key of the button the buyer chose (`paypal` or `venmo`; Pay Later rides on `paypal`). A v6 session accepts an order created with a `payment_source` (section 3), so the server always sends one (the client's `paymentSource: 'send'` default; nothing sets `omit`).
- Local errands: `shipping_preference: NO_SHIPPING` and `purchase_units[0].shipping.type: PICKUP_FROM_PERSON` (accepted on 11-07, G9; PayPal notes seller protection does not apply to in-person pickup because the payer can check the item first, which is why local mode captures at the handover).
- The hold screen says "up to": the PayPal page shows the full limit ($63.70 in [PayPal's window](../proto-shots/v3/final/03-paypal-window.png)). The processing line, $3.70 here, is the most the request's one job could pay PayPal at its caps (D-105).

## 5. Payout body

Wei's fee payout in run `20261107-2047`: batch `5MVTE5WFTZD24`, item `FQCNEBP9F6PWG`, $10.80 `SUCCESS`, PayPal's fee $0.25 (PayPal's copy: `server/test/paypal/fixtures/recorded/20261107-2047-lifecycle/007-payouts.get-200.json`). The second payout of the job, $42.75 for the shop price and shipping (batch `GS8Q7QS46SBDS`), has `payout:job_0001:reimb@<run>` as its `sender_batch_id`.

```json
{
  "sender_batch_header": {
    "sender_batch_id": "payout:job_0001:fee@mw6ef7ny",
    "email_subject": "You have a payout from HoldMySpot",
    "email_message": "Queue fee, 1 x Mochi Bunny plush, Paper Moon Toys.",
    "recipient_type": "EMAIL"
  },
  "items": [{
    "recipient_type": "EMAIL",
    "amount": { "value": "10.80", "currency": "USD" },
    "note": "Queue fee, 1 x Mochi Bunny plush, Paper Moon Toys (Wei)",
    "sender_item_id": "po_0001",
    "receiver": "<PAYPAL_PAYOUT_EMAIL>",
    "notification_language": "en-US"
  }]
}
```

In sandbox mode every queuer persona pays out to the one receiver in `PAYPAL_PAYOUT_EMAIL` (a US personal sandbox account; the older name `PAYPAL_TW_PAYOUT_EMAIL` is still read); the persona name is in the note. The sandbox does not support the PHONE recipient type, and Venmo payouts need a US phone number, so Venmo payouts are a production-only option. Unclaimed items return after 30 days or can be cancelled; claimed items cannot be pulled back.

## 6. Status sync: webhooks and polling

Local development has no public URL, so **polling is the default** (`HMS_PAYPAL_SYNC=poll`). Both paths produce the same internal events and run the same handler, deduplicated by PayPal event id or by (object id, status).

| PayPal object | Poll | Webhook events | Our mapping |
|---|---|---|---|
| Authorization | `GET /v2/payments/authorizations/{id}` for holds `held` / `partially_captured`, every 60 s | `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED` | CREATED: held. PARTIALLY_CAPTURED: partially_captured. CAPTURED: captured. VOIDED or EXPIRED: released (expired also sets `renewalRequired` if the bid is open). DENIED: failed. PENDING: held but not matchable. |
| Capture | `GET /v2/payments/captures/{id}` while PENDING | `PAYMENT.CAPTURE.COMPLETED`, `.PENDING`, `.DENIED`, `.REFUNDED`, `.REVERSED` | COMPLETED: ledger succeeded, payouts may start. PENDING: wait. DENIED or FAILED: ledger failed, job `payment_failed`. |
| Payout batch | `GET /v1/payments/payouts/{id}` until every item is final | `PAYMENT.PAYOUTSBATCH.*`, `PAYMENT.PAYOUTS-ITEM.SUCCEEDED`, `.UNCLAIMED`, `.RETURNED`, `.FAILED`, `.BLOCKED`, `.DENIED`, `.HELD`, `.REFUNDED`, `.CANCELED` | SUCCESS: succeeded. UNCLAIMED: unclaimed. PENDING, NEW, ONHOLD: pending. FAILED, BLOCKED, DENIED: failed. RETURNED, REFUNDED, REVERSED: returned. CANCELED: cancelled. |
| Dispute | `GET /v1/customer/disputes?start_time=<last poll - 1 h>` every 5 min | `CUSTOMER.DISPUTE.CREATED`, `.UPDATED`, `.RESOLVED` | Upsert `Dispute`; flag the job `disputed`. |

Polling interval `HMS_PAYPAL_POLL_SECONDS` (20) with backoff on HTTP 429. The webhook route verifies every event with `verify-webhook-signature` (needs `PAYPAL_WEBHOOK_ID`); unverified events are logged by type and dropped.

## 7. Day-1 gates (`node scripts/sandbox-gates.mjs run` in the repo folder)

Each writes one line to `docs/SANDBOX-GATES.md` (ids and statuses only, never credentials). Results of 11-07 are on that page.

Commands (all record sanitized answers as fixtures; D-69):

- `run --auto-approve --payout-to person-1`: creates the orders and approves each one in a headless Chromium as the sandbox buyer (`scripts/lib/sandbox-buyer.mjs`; email from `PAYPAL_BUYER_EMAIL`, password from `sandbox-buyers.json`, read at run time and never printed). It stops at any CAPTCHA, security check or code request and saves a screenshot (`--shots <dir>`). Headless worked on 11-07 (about 13 s for the first order, 5 s for the next ones).
- `disputes --open-as-buyer`: the buyer reports "item not received" on gate order A's $76.01 capture in the Resolution Center, then the script lists, escalates and adjudicates what it can.
- `probe`: PayPal's answers to the edge cases the emulator copies (section 12).
- `lifecycle --payout-to person-1`: one full job through the server's HTTP API on its own sandbox server (port 8798), then GET authorization, order, captures and payout batches from PayPal and compare them with the ledger.
- `lifecycle --local`: the local pickup errand the same way (D-156): Sam's `PICKUP_FROM_PERSON` hold in San Francisco, nothing captured at the receipt, one capture when Wei enters Sam's handover code, one payout; the checks add "no shipping on the order" and "one capture at the handover". Its page section and fixtures (`<run>-lifecycle-local`) are its own.
- `record <gate> <pass|fail|partial|skip> --note "..." --order <id>`: a gate checked by hand (G4, G5), with PayPal's own answer for that order (GET calls only: the order, its authorizations, its captures) added to the evidence and saved as fixtures (`<run>-record-<gate>`).
- `reauthorize` (G10, from day 4; `--probe-second` also asks PayPal whether D2's original can be reauthorized twice).

| # | Probe | Pass when |
|---|---|---|
| G1 | Capture below the held amount with `final_capture=true`, then GET the authorization | Status CAPTURED, nothing left to capture |
| G2 | Two captures, the first `final_capture=false` | Both COMPLETED; a third capture is refused |
| G3 | Void after a partial capture | Remainder released (VOIDED / PARTIALLY_CAPTURED then VOIDED) |
| G4 | Venmo AUTHORIZE with `testBuyerCountry: 'US'` (owner approves in the popup) | Authorization CREATED, funding `venmo`; capture works |
| G5 | Pay Later with intent AUTHORIZE (bonus) | Works: add `paylater` to allowed funding. Fails: Pay Later stays off |
| G6 | Payout by email to the payout receiver sandbox account | SUCCESS, or UNCLAIMED until the owner accepts it on sandbox.paypal.com |
| G7 | Refund, then a buyer-opened dispute settled with `adjudicate` | Refund COMPLETED; dispute RESOLVED |
| G8 | Tracking with carrier OTHER on a capture of an authorized order | 2xx and the tracker shows on the order |
| G9 | Order with `payment_source` key accepted by a v6 session; local `PICKUP_FROM_PERSON` accepted | Approval succeeds |
| G10 | Dated holds D1 and D2 (created 11-07 00:15 PT, auto-approved), reauthorized from 11-10 00:15 PT (11-10 16:15 Taipei) and before the deadline (11-12 12:00 PT), on camera | New authorization id, ledger `renewed` |
| G11 | Token scopes include payouts, disputes and tracking | Scope string contains them (the secrets script already checks payouts) |

## 8. Errors

The sandbox adapter maps PayPal's `name` and first `details[].issue` to our codes and keeps `debug_id` on the ledger entry. Known issues from the 11-07 research, for example:

| PayPal issue | Our code | Action |
|---|---|---|
| INSTRUMENT_DECLINED | PAYPAL_DECLINED | Restart the SDK session; bid stays `awaiting_approval` |
| AUTHORIZATION_EXPIRED | HOLD_EXPIRED | Set `renewalRequired`; ask the requester to approve again |
| AUTHORIZATION_VOIDED, AUTHORIZATION_ALREADY_CAPTURED, PREVIOUSLY_CAPTURED (void after a final capture) | HOLD_CLOSED | Reload the hold; never retry blindly |
| MAX_CAPTURE_AMOUNT_EXCEEDED (above 115% in total; exactly 115% passed on 11-07) | OVER_CAPTURE | Should never happen (our limit is stricter); alert ops |
| USER_BUSINESS_ERROR "Batch with given sender_batch_id already exists" (HTTP 400; also for the same PayPal-Request-Id, 11-07; `details[0].link` names the batch PayPal has) | PAYPAL_ERROR, `isDuplicatePayout` | The payout stays pending, never failed or resent (D-53). The named batch would let the status sync reconcile it without ops (not built) |
| DUPLICATE_TRANSACTION (a captured invoice id under a new request id) | PAYPAL_ERROR | Cannot happen with run-scoped invoice ids (D-50); a repeat of the same request id gets the first capture back with HTTP 200 |
| REAUTHORIZATION_TOO_SOON (inside the 3-day honor period) | PAYPAL_ERROR | The sweeper only renews from day 4 |
| CAPTURE_ID_NOT_FOUND (tracking with a capture of another order) | PAYPAL_ERROR | Tracking uses the job's own receipt capture |
| ITEM_INCORRECT_STATUS (cancel a payout that is not UNCLAIMED; HTTP 400) | PAYPAL_ERROR | Read the payout again |
| ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE (HTTP 400 `INVALID_REQUEST`) | PAYPAL_ERROR | The dispute does not offer that action yet (a fresh claim, about 20 minutes); try again when its links offer it |
| MAX_CAPTURE_COUNT_EXCEEDED | PAYPAL_ERROR | Alert ops (count limit is not published) |
| PERMISSION_NOT_GRANTED, PAYEE_NOT_CONSENTED | PAYPAL_ERROR | Means a third-party payee was used; we never do that |
| HTTP 5xx, timeouts | PAYPAL_UNAVAILABLE | Retry with the same `PayPal-Request-Id` |
| anything else | PAYPAL_ERROR | Keep `debug_id`; ledger entry `failed` |

Money calls use the ledger as their outbox: insert the entry as `pending` with its key, call PayPal, then mark it `succeeded` or `failed`. On restart the server retries `pending` entries with the same key, so a crash never double-charges.

## 9. Agent Toolkit gap

PayPal's Agent Toolkit has create_order, get_order, pay_order, create_refund, get_refund, dispute list, get and accept, and shipment tracking, but no authorize, capture-of-authorization, void, reauthorize or payouts tools. HoldMySpot's hold life cycle therefore runs on our own narrow REST wrappers (`server/src/paypal/sandbox.ts`). The bidding agent never calls PayPal at all: it can only change its bid inside the hold, and the server's settlement rules decide every capture. The README's friction notes record the gap.

## 10. Fake adapter (`HMS_MODE=fake`)

Same port, no network, deterministic ids (`FAKE-ORDER-0001`, `FAKE-AUTH-0001`, `FAKE-CAP-0001`, `FAKE-BATCH-0001`, `FAKE-ITEM-0001`, `FAKE-REFUND-0001`, `FAKE-DISPUTE-0001`). Since D-47 it is the sandbox REST client itself (`server/src/paypal/client.ts`) answered by the in-process emulator (`server/src/paypal/emulator.ts`), so fake mode sends the same request bodies and maps the same responses as the sandbox; `server/src/fakes/paypal.ts` saves the emulator state in SQLite and empties it at a market reset. It copies PayPal's rules so the server's own checks are tested:

- orders must be approved through `POST /api/fake/paypal/orders/:orderId/approve` before authorize;
- the honor period (3 days) and validity (29 days) run on the market clock, so a demo can show a renewal;
- captures are accepted up to 115% of the authorization, exactly like PayPal (proven: $11.50 on a $10.00 hold passed, $11.51 did not), which is how tests prove that our own limit check is what stops them;
- a final capture releases the rest; voids work after partial captures; reauthorize only from day 4 to 29 (`REAUTHORIZATION_TOO_SOON` before), at most 115% and +$75, with a new id;
- a reauthorized payment cannot itself be reauthorized, so renewals always reauthorize the original authorization (D-52);
- a new payout batch answers PENDING; reading it back gives the item status: SUCCESS for persona emails (`<userId>@queuers.example`), UNCLAIMED for unknown ones (the server reads each new batch once and polls, D-51). The batch reads PROCESSING for a minute after its items were paid, then SUCCESS; each paid item costs $0.25. Option `payoutProcessingMs` keeps items PENDING for a while, as the sandbox did (15 to 25 s); fake mode keeps the default 0, so the demo's payouts settle at the first read;
- every capture carries PayPal's fee (3.49% + $0.49) in `seller_receivable_breakdown` and, once its authorization is closed, reads `final_capture: true`; the server records that fee, and the requester's processing line pays it to the cent (D-105);
- a repeated request id returns the first result with HTTP 200, except for payouts: a batch sent again is refused as a duplicate (`isDuplicatePayout`), naming the batch PayPal has; a captured invoice id under a new request id is `DUPLICATE_TRANSACTION`;
- the same tracker twice is accepted; a capture of another order is `CAPTURE_ID_NOT_FOUND`;
- a buyer's dispute opens as the sandbox showed it: a claim under PayPal's review that refuses adjudicate for `disputeReviewMs` (20 minutes), then offers it; an accepted adjudication reads `RESOLVED` `disputeSettleMs` later (3 minutes). `openDispute(captureId, { stage: 'INQUIRY' })` opens the documented inquiry instead (escalate, evidence, accept-claim), not seen in the sandbox yet; the list items carry no invoice numbers;
- links name `https://api.sandbox.paypal.com`, and error bodies carry PayPal's per-API information links;
- failure injection through `HMS_FAKE_FAIL`, `<op>:<effect>[:<count>|*]`, for example `capture:unavailable:3` (longer than the client's two retries, so the server sees the outage), `payout:unclaimed`, `authorize:decline`, `reauthorize:decline`.

In sandbox mode every PayPal-Request-Id, `sender_batch_id` and invoice id also carries the market run id (`<key>@<run>`, `HMS-<run>-<rest>`, D-50), because a demo reset restarts our ids while PayPal remembers what it has seen.

## 11. Sandbox versus production

This box goes into the README.

- **Sandbox (what we built):** one platform merchant app is the merchant of every order and pays queuers through Payouts. PayPal holds the requester's money in the authorization until a capture; each capture lands in HoldMySpot's PayPal balance and leaves by Payouts: the queue fee minutes after the receipt capture, the shop price and shipping of a shipped item after the tracking number and the final capture, a local errand's payout minutes after the handover. Processing and payouts are passed through at cost, so PayPal's fees never come out of HoldMySpot's 10% of the queue fee (D-105, D-107).
- **Production (not built, not shown):** PayPal approval as a marketplace, and possibly as a payment facilitator, under the Acceptable Use Policy; PayPal's multiparty or marketplace onboarding so queuers are PayPal sellers paid directly in the same payment, with a disclosed platform fee, instead of money passing through the platform's balance (the Payouts fee then disappears; the processing line would cover PayPal's fee on that payment); Payouts approval; Venmo payouts with US phone numbers; webhooks on a public URL; duty handled by a licensed carrier or broker. Purchase Protection does not cover payments made with Payouts or in-person pickups, so screens never claim that "PayPal protects every trade".

## 12. What the real sandbox showed (11-07 and 11-08)

Runs `20261107-1614` (gates), `20261107-1644-probe`, `20261107-1700-probe-payout`, `20261107-1642-lifecycle`, `20261107-2047-lifecycle`, the `disputes` runs, and on 11-08 `20261108-1357-lifecycle-local` and `20261108-1358-record-g4`; every answer is saved, sanitized, under `server/test/paypal/fixtures/recorded/` and mapped by `recorded.test.ts`; `sandbox-parity.test.ts` pins the facts below against those files and the emulator.

- Sign-in and approval: the sandbox buyer's approval page follows the IP's country (Chinese from Taipei) unless the link carries `locale.x=en_US`; it uses a split email-then-password form; reCAPTCHA v3 runs invisibly and never asked for anything; headless Chromium was not challenged.
- Orders: 200 + `PAYER_ACTION_REQUIRED` with a `payment_source`; the create answer has no `create_time`; an approved order offers `update` (PATCH) and `authorize`; `PICKUP_FROM_PERSON` with `NO_SHIPPING` was accepted (G9); `GET_FROM_FILE` returned no shipping address for this buyer.
- Holds: authorizations last 29 days (`expiration_time`); a capture `COMPLETED` at once (funding: the buyer's sandbox bank account); a final capture below the hold closes it (`CAPTURED`, G1); two captures then a refused third (`AUTHORIZATION_ALREADY_CAPTURED`, G2); a void after a partial capture gives `VOIDED` (G3); captures can reach exactly 115%.
- Fees: 3.49% + $0.49 per capture; a partial refund returns no fee (`paypal_fee` 0.00); $0.25 per payout item.
- Payouts: PENDING on the first read, then SUCCESS while the batch is PROCESSING, then SUCCESS (G6 and both lifecycle payouts, 15 to 25 s). The G6 batch sent again an hour later, same `sender_batch_id` and same PayPal-Request-Id, was refused as a duplicate (no second payment); the request id does not replay payouts.
- Disputes: the buyer's report (case `PP-R-UEL-10196964`, opened by `disputes --open-as-buyer`) was listed by the API within minutes as a claim under PayPal's review; adjudicate was refused 10 to 13 minutes in, offered and accepted 23 minutes in, and the dispute read `RESOLVED_SELLER_FAVOUR` about 3 minutes later (G7 passed).
- Lifecycle (server over HTTP only, sandbox mode), first run `20261107-1642-lifecycle`, before D-105 passed processing through: hold $60.00, captures $46.00 and $8.75 (final), $5.25 released by the final capture, payouts $10.80 and $42.75 SUCCESS; PayPal's fees on it were $2.10 + $0.80 + 2 x $0.25 = $3.40, which is why D-105 exists. Second run `20261107-2047-lifecycle`, with processing at cost: hold $63.70, captures $48.69 (PayPal's fee $2.19, net $46.50 = $34.00 + $12.00 + 2 x $0.25) and $9.57 (fee $0.82, net $8.75), $5.44 released, payouts $10.80 and $42.75 SUCCESS with $0.25 fees; PayPal's fees, $3.51, equal the processing line to the cent and HoldMySpot kept $1.20 (D-120). In both runs PayPal's authorization, captures and payout items matched the ledger to the cent.
- Local pickup errand (`lifecycle --local`, D-156), run `20261108-1357-lifecycle-local` on 11-08: Sam's `PICKUP_FROM_PERSON` order `15B12811F4599863Y` (GET shows no `shipping` at all: no ship-to, no tracker), authorization `2KG09036B9936292Y` $50.50 ($36.00 + $12.00 + the $2.50 processing reserve), nothing captured at the receipt, then one capture `5KN64357P0403214L` of $48.43 when Wei entered Sam's handover code (invoice suffix `-H`, `final_capture: true`, PayPal's fee $2.18, net $46.25 = $34.00 + $12.00 + $0.25), $2.07 released, one payout (batch `EQVZVFXCLDEDU`, `sender_batch_id` `payout:job_0001:all@<run>`) of $44.80 `SUCCESS` with its $0.25 fee. PayPal's fees, $2.43, equal the processing line and HoldMySpot kept $1.20; all 11 read-back checks matched the ledger to the cent.
- Venmo (G4, partial), read back on 11-08 with GET calls only (`20261108-1358-record-g4`): the hold the web app approved through the Venmo button on 11-07 is order `03979024TL691052W`, intent `AUTHORIZE`, `payment_source` `venmo`, authorization `7RB884471X718305E` $56.00 still `CREATED` (valid until 12-06), no capture. Whether a Venmo-funded hold captures, and at which fee, is not recorded yet.
- Web app (D-121, [`proto-shots/v3/final/`](../proto-shots/v3/final/)): the same errand through the web app on a sandbox server, the hold approved in PayPal's window through the JS SDK v6 PayPal session and the photos read live by Muse Spark: order `0LK56938DW451581H`, authorization `88232929HR885933A` $63.70, captures `54N68839TA957213Y` $48.69 (fee $2.19) and `4U786596DF2537313` $9.57 (fee $0.82), $5.44 released, tracking `HPG-2611-57842795`, payouts $10.80 (batch `88H3RUEBP9L4W`) and $42.75 (batch `32VC3V9YGQ78C`) `SUCCESS` with $0.25 fees. Read back from PayPal after the run and again for the README (GET only), every amount and fee matched the ledger. Its PayPal answers are not saved as fixtures; the screenshots are its record.
