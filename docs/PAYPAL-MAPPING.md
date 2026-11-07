# PayPal mapping

Status: proposed, 2026-11-07. Every PayPal call goes through the `PayPalPort` interface in `shared/src/ports.ts`. The server has two implementations: `server/src/paypal/fake.ts` (no network, same rules) and `server/src/paypal/sandbox.ts` (our own REST wrappers). Money rules are in [DOMAIN.md](DOMAIN.md) section 7; owner setup steps are in [SANDBOX-GATES.md](SANDBOX-GATES.md).

Items marked **probe** are not yet proven in our sandbox; they are day-1 gates (section 7).

## 1. Accounts and roles

| Role | Sandbox account | Where it comes from |
|---|---|---|
| Platform merchant (payee of every hold, sender of every payout) | Existing sandbox app, US business account `<sandbox business account>` | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_EMAIL`, `PAYPAL_MERCHANT_ID` in `~/.config/paypal-hackathon/sandbox.env` |
| Requester (buyer) | US personal account `<sandbox personal account>` (or a dedicated judge buyer) | `PAYPAL_BUYER_EMAIL`; the password is typed only on PayPal's own pages |
| Queuer payout receiver | Any US personal sandbox account other than the buyer (no Taiwan account is needed, owner 11-07) | `PAYPAL_TW_PAYOUT_EMAIL` (the name is historical, D-17) |

The platform app is shared with the owner's other entries. Every object we create carries an `HMS-` prefixed `invoice_id` and our id in `custom_id`; the poller, the webhook handler and the dispute list ignore anything without that prefix.

## 2. Step by step

Base URL `https://api-m.sandbox.paypal.com`. Every POST sends `PayPal-Request-Id: <idempotency key>` (keys in DOMAIN.md section 7) and `Prefer: return=representation`. Amounts are strings from `toPayPalValue(cents)`.

| # | Our step (trigger) | PayPal call | Notes |
|---|---|---|---|
| 0 | Any call | `POST /v1/oauth2/token` (client credentials) | Token cached in memory until 60 s before `expires_in`; never logged. |
| 1 | Bid form loads | Browser: JS SDK v6 core | `GET /api/config` gives `clientId`, `sdkUrl` and `testBuyerCountry`. See section 3. |
| 2 | `POST /api/bids` | `POST /v2/checkout/orders`, intent `AUTHORIZE` | Amount = bid limit. Section 4. |
| 3 | Buyer approves; `POST /api/bids/:id/authorize` | `POST /v2/checkout/orders/{id}/authorize` | Read `purchase_units[0].payments.authorizations[0]`: id, status `CREATED`, `expiration_time`; funding from the `payment_source` key; ship-to address. `INSTRUMENT_DECLINED`: restart the SDK session so the buyer can pick another method. |
| 4 | Sweeper, day 4 to 29, untouched hold of an open bid | `POST /v2/payments/authorizations/{id}/reauthorize` with the same amount | Returns a NEW authorization id; new 3-day honor period; validity still from the original. Never more than the original (PayPal would allow up to 115%, at most +$75, in the US). **probe**: Venmo-funded holds. |
| 5 | Proof verified (ship mode) | `POST /v2/payments/authorizations/{id}/capture` with `final_capture: false`, `invoice_id: HMS-<jobId>-R` | Retail at cost (capped) plus matched fee. Payout of the fee only after status `COMPLETED`. |
| 6 | `POST /api/jobs/:id/shipment` | `POST /v2/checkout/orders/{orderId}/track` with `capture_id` of step 5, `carrier: "OTHER"`, `carrier_name_other` | Fictional carrier name. `notify_payer: true`. |
| 7 | Right after step 6 | Capture again, `final_capture` from `isFinalCapture`, `invoice_id: HMS-<jobId>-S` | Shipping and prepaid duty at cost (capped). A final capture releases the rest. |
| 8 | `POST /api/jobs/:id/handover` (local mode) | One capture, `invoice_id: HMS-<jobId>-H` | Retail plus fee, final if it is the last possible capture. |
| 9 | Bid ends with nothing left to capture | `POST /v2/payments/authorizations/{id}/void` | Also after partial captures (**probe**). |
| 10 | After a COMPLETED capture | `POST /v1/payments/payouts` | One item per batch; `sender_batch_id` = our key; `recipient_type: EMAIL`. Section 5. |
| 11 | Poller | `GET /v1/payments/payouts/{batch_id}` | Item `transaction_status` to our payout status. |
| 12 | `POST /api/ops/jobs/:id/refund`, or not shipped in 5 days | `POST /v2/payments/captures/{id}/refund` | Partial or full. `invoice_id: HMS-<jobId>-F<n>`. |
| 13 | Buyer opens a dispute (sandbox site) | Poll `GET /v1/customer/disputes?start_time=...`, then `GET /v1/customer/disputes/{id}` | Keep only disputes whose transactions carry our invoice ids. |
| 14 | Ops sends evidence | `POST /v1/customer/disputes/{id}/provide-evidence` (multipart) | Receipt photo, item photo, AI and rule checks as text, tracking. |
| 15 | Ops accepts | `POST /v1/customer/disputes/{id}/accept-claim` | |
| 16 | Ops settles (sandbox only) | `POST /v1/customer/disputes/{id}/adjudicate` with `BUYER_FAVOR` or `SELLER_FAVOR` | `require-evidence` is also sandbox-only. |
| 17 | `POST /api/paypal/webhook` | `POST /v1/notifications/verify-webhook-signature` | Needs `PAYPAL_WEBHOOK_ID` and a public URL. Section 6. |
| 18 | Unclaimed payout to cancel | `POST /v1/payments/payouts-item/{id}/cancel` | Only while `UNCLAIMED`. |

## 3. Browser: JS SDK v6

What is known on this machine: an 11-07 probe (a separate probe script) loaded the v6 core script with the platform app's client ID through `createInstance({ clientId, components, pageType, testBuyerCountry })`, and its screenshot shows a rendered Pay Later message. The session API names below match PayPal's v6 web SDK notes. Which buttons `findEligibleMethods` reports for this app (Venmo in particular) is not recorded yet (**probe**).

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

`createPayLaterOneTimePaymentSession` exists for the Pay Later button. An AUTHORIZE order approved through these sessions is part of probe G4 and G9. Buttons are PayPal's own components, unaltered. In fake mode (`checkout.next === 'fake_approve'`) the web shows its own plainly labelled "Simulated PayPal" sheet and calls `POST /api/fake/paypal/orders/:orderId/approve`.

## 4. Order body

```json
{
  "intent": "AUTHORIZE",
  "purchase_units": [{
    "reference_id": "bid_0001",
    "custom_id": "bid_0001",
    "invoice_id": "HMS-bid_0001",
    "description": "HoldMySpot hold: up to $115.00 for 2 x Lucky Cat plush, launch-day drop",
    "soft_descriptor": "HOLDMYSPOT",
    "amount": {
      "currency_code": "USD", "value": "115.00",
      "breakdown": {
        "item_total": { "currency_code": "USD", "value": "80.00" },
        "shipping": { "currency_code": "USD", "value": "35.00" }
      }
    },
    "items": [
      { "name": "Lucky Cat plush, launch-day drop (shop price, up to)", "quantity": "2",
        "unit_amount": { "currency_code": "USD", "value": "28.00" }, "category": "PHYSICAL_GOODS" },
      { "name": "Queue fee (up to)", "quantity": "2",
        "unit_amount": { "currency_code": "USD", "value": "12.00" } }
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

- `payment_source` uses the key of the button the buyer chose (`paypal` or `venmo`; Pay Later rides on `paypal`). **probe**: that a v6 session accepts an order created with a `payment_source`; if not, omit `payment_source` and rely on the SDK session.
- Local errands: `shipping_preference: NO_SHIPPING` and `purchase_units[0].shipping.type: PICKUP_FROM_PERSON` (**probe**; PayPal notes seller protection does not apply to in-person pickup because the payer can check the item first, which is why local mode captures at the handover).
- The hold screen says "up to": the PayPal page shows the full limit.

## 5. Payout body

```json
{
  "sender_batch_header": {
    "sender_batch_id": "payout:job_0001:fee",
    "email_subject": "You have a payout from HoldMySpot",
    "email_message": "Queue fee for 2 plush at Little Lantern Toys."
  },
  "items": [{
    "recipient_type": "EMAIL",
    "receiver": "<PAYPAL_TW_PAYOUT_EMAIL>",
    "amount": { "value": "21.60", "currency": "USD" },
    "note": "Queue fee, 2 x Lucky Cat plush, Little Lantern Toys",
    "sender_item_id": "po_0001",
    "notification_language": "en-US"
  }]
}
```

In sandbox mode every queuer persona pays out to the one receiver in `PAYPAL_TW_PAYOUT_EMAIL` (a US personal sandbox account; the name is historical); the persona name is in the note. The sandbox does not support the PHONE recipient type, and Venmo payouts need a US phone number, so Venmo payouts are a production-only option. Unclaimed items return after 30 days or can be cancelled; claimed items cannot be pulled back.

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

Each writes one line to `docs/SANDBOX-GATES.md` (ids and statuses only, never credentials).

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
| G10 | Dated holds created on 11-08 (owner approves 2 or 3), reauthorized on 11-11 or 11-12 on camera | New authorization id, ledger `renewed` |
| G11 | Token scopes include payouts, disputes and tracking | Scope string contains them (the secrets script already checks payouts) |

## 8. Errors

The sandbox adapter maps PayPal's `name` and first `details[].issue` to our codes and keeps `debug_id` on the ledger entry. Known issues from the 11-07 research, for example:

| PayPal issue | Our code | Action |
|---|---|---|
| INSTRUMENT_DECLINED | PAYPAL_DECLINED | Restart the SDK session; bid stays `awaiting_approval` |
| AUTHORIZATION_EXPIRED | HOLD_EXPIRED | Set `renewalRequired`; ask the requester to approve again |
| AUTHORIZATION_VOIDED, already captured | HOLD_CLOSED | Reload the hold; never retry blindly |
| MAX_CAPTURE_AMOUNT_EXCEEDED | OVER_CAPTURE | Should never happen (our limit is stricter); alert ops |
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
- captures are accepted up to 115% of the authorization, exactly like PayPal, which is how tests prove that our own limit check is what stops them;
- a final capture releases the rest; voids work after partial captures; reauthorize only from day 4 to 29, at most 115% and +$75, with a new id;
- a reauthorized payment cannot itself be reauthorized, so renewals always reauthorize the original authorization (D-52);
- a new payout batch answers PENDING; reading it back gives the item status: SUCCESS for persona emails (`<userId>@queuers.example`), UNCLAIMED for unknown ones (the server reads each new batch once and polls, D-51);
- a repeated request id returns the first result;
- failure injection through `HMS_FAKE_FAIL`, `<op>:<effect>[:<count>|*]`, for example `capture:unavailable:3` (longer than the client's two retries, so the server sees the outage), `payout:unclaimed`, `authorize:decline`, `reauthorize:decline`.

In sandbox mode every PayPal-Request-Id, `sender_batch_id` and invoice id also carries the market run id (`<key>@<run>`, `HMS-<run>-<rest>`, D-50), because a demo reset restarts our ids while PayPal remembers what it has seen.

## 11. Sandbox versus production

This box goes into the README.

- **Sandbox (what we built):** one platform merchant app holds every authorization and pays queuers through Payouts. The money is held by PayPal; HoldMySpot never keeps balances, wallets or credits.
- **Production (not built, not shown):** PayPal approval as a marketplace, and possibly as a payment facilitator, under the Acceptable Use Policy; Multiparty onboarding so queuers are PayPal sellers paid directly with a disclosed platform fee; Payouts approval; Venmo payouts with US phone numbers; webhooks on a public URL; duty handled by a licensed carrier or broker. Purchase Protection does not cover payments made with Payouts or in-person pickups, so screens never claim that "PayPal protects every trade".
