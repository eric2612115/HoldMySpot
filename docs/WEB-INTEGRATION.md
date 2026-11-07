# Switching web/ from its mock to the contract

Status: 2026-11-07, v2 pass: **done** for the map, the requester's flow and the money panel. `web/` uses the server when `GET /api/health` answers (fake PayPal mode on 127.0.0.1:8796, through the Vite proxy) and its in-browser market otherwise; `?backend=server` insists, `?backend=mock` skips it. The server driver is `web/src/state/serverMarket.ts`, the in-browser market `web/src/state/mockMarket.ts`, and both build their points from `shared/src/seed.ts`. In server mode "Set my max fee" and "Book now" go through the quote, the PayPal order, a plainly labelled "Simulated PayPal" sheet, the fake approval and the authorization; "Take it" posts an offer as the queuer persona with an ETA of the trip the sheet shows plus a minute (D-63); the money panel lists the server's ledger for both personas (the requester's lines and the queuer's payouts, from a second event stream as the queuer); `queuer.moved` walks the queuers' avatars on the 3D map; the bid and ask forms carry DOMAIN.md section 9's sentences and the money chip carries the mode banner on every screen. With a server in sandbox mode the confirm step shows PayPal's own JS SDK v6 buttons instead (PayPal, and Venmo when eligible; section 5, D-70 to D-73); fake mode keeps the Simulated PayPal sheet. The queuer's half is built too (`web/src/ui/queuer`, section 7, D-76 to D-81): on the queuer's phone a task is taken or offered, the arrival window counts down, the line photo, the receipt and the item photo go through the AI check on screen, and tracking or the handover code ends in the payout card. The sections below are the plan the switch followed and stay as the reference. The server side is ready in fake mode: it runs the PayPal sandbox REST client on an in-process emulator and the real AI services without a key, and an end-to-end test drives the whole hero story over HTTP (`server/test/e2e.test.ts`). Read [API.md](API.md) for every endpoint and event, and [ARCHITECTURE.md](ARCHITECTURE.md) section 14 for the field alignment.

## 1. What the prototype does today

| Prototype file | What it did before the switch | What replaced it |
|---|---|---|
| `src/domain/catalog.ts` `buildCatalog()` | Builds `TaskPoint`s with random crowd bids | `GET /api/shops` + `GET /api/books` (section 4) |
| `src/state/boot.ts` | Loads points, ticks every 250 ms, simulates crowd bids, seeds the viewer's own bid | Loads once from the server, then applies SSE events; no simulated bids |
| `src/state/market.ts` `tick()` | Matches books in the browser, settles fees after a fake receipt delay | The server matches, checks receipts and moves money; the browser only shows records |
| `src/services/payments/*` `PaymentsService` | Holds, captures, releases and payouts in memory | Bids, approval and the ledger (section 5); the browser never captures or pays out |
| `src/services/clock.ts` | Its own clock with `?speed=` | The server's `ClockState` (section 3) |
| `src/ui/PayPalButton.tsx` | Placeholder button | Fake mode: a plainly labelled "Simulated PayPal" sheet; sandbox: PayPal's own v6 buttons |

Keep the mock: it is the offline fallback for UI work and for the film's B-roll. Switch with one flag (section 2), the way the ops console does (`ops/src/data/backend.ts`: `mock`, `server`, or `auto` = the server when `GET /api/health` answers with the same `contractVersion`).

## 2. Wiring (do these first)

1. **Shared package.** In `web/package.json` add `"@holdmyspot/shared": "file:../shared"`, then `npm install` in `web/` (npm links the folder; no build step). The shared source already type-checks under `web/tsconfig.app.json` (bundler resolution, `allowImportingTsExtensions`, `verbatimModuleSyntax`).
2. **Vite.** In `web/vite.config.ts` add, as in `ops/vite.config.ts`:
   ```ts
   const shared = fileURLToPath(new URL('../shared', import.meta.url));
   server: { host: '127.0.0.1', port: 5190, strictPort: true,
             proxy: { '/api': { target: env.HMS_API_PROXY || 'http://127.0.0.1:8796', changeOrigin: false } },
             fs: { allow: [root, shared] } },
   preview: { ..., proxy: <same> },
   ```
   Same origin through the proxy means no CORS and EventSource works unchanged (the server also allows `http://127.0.0.1:5190` if `VITE_HMS_API` points at it directly).
3. **Switch.** `VITE_BACKEND=mock|server|auto` (default `auto`), overridable with `?backend=`. `VITE_HMS_API` defaults to empty (same origin).
4. **Persona.** No real sign-in in v1. Every request carries `X-HMS-User: <userId>`; SSE uses `?as=<userId>`. Take it from `?as=` and `?queuer=` (defaults: on the San Francisco map Mia as the requester, who has plush shipped to New York, and Wei as the queuer; on `?city=nyc` Jun and Dana). Personas: requesters `mia`, `jun`, `priya` (New York), `sam`, `noor`, `leo` (San Francisco); queuers `wei`, `lin`, `rin`, `ava`, `jo`, `rex` (San Francisco), `dana`, `theo`, `mo` (New York). A local errand (cake, ramen) only takes requesters from the shop's own city, so `?as=sam` asks for a Japantown cake.
5. **Typed client.** Use the `api()` helper in [API.md](API.md) section 1 (`apiPath`, `endpointParts`, `HEADERS` from `@holdmyspot/shared`). On a non-2xx answer it throws the `ApiErrorBody`.

## 3. Clock

Replace `createMarketClock(params.speed)` with the server's clock:

```ts
// GET /api/clock (also in GET /api/config, the SSE hello event and every clock.updated event)
let c: ClockState;
const now = () => (c.paused ? c.marketNow : c.marketNow + (Date.now() - c.realNow) * c.speed);
```

`?speed=` no longer applies in server mode: demo speed is the server's (`npm run demo` runs at 60; `POST /api/demo/clock` changes it). Fee-clock prices are computed in the browser from `AskQuote.clock` with `askFeeAt(quote, now())`; the server sends no tick per step, only `book.updated` when a step fills something.

## 4. Map points from books

The map keeps its `TaskPoint` view model; build it from the contract instead of `buildCatalog()`:

```ts
const { shops } = await api('GET /api/shops', {}, null, { query: { cityId } });   // Shop with items
const { books } = await api('GET /api/books', {}, null, { query: { cityId } });   // BookSnapshot per item
```

| `TaskPoint` field | From |
|---|---|
| `id` | `Item.id` (also the book key) |
| `kind`, `itemName`, `itemShort`, `tags`, `retailCents` | `Item.kind`, `name`, `shortName`, `tags`, `retailCents` |
| `shop.name`, `shop.street` | `Shop.name`, `Shop.street` |
| `placement` (metres from the player) | `Shop.lngLat` (absolute; drop the metre offsets) |
| `hue` | `Shop.accent` |
| `queue` | `BookSnapshot.queue` (same field names) |
| `bids` (one entry per crowd bid, all-in cents) | `BookSnapshot.bids`: `count`, `qty`, `bestFeeCents`, `levels` (fee per unit). Single bids are private now; labels show count, top fee and depth |
| `offers` (best first) | The `AskQuote`s in `book.asks.quotes` at `now()`, cheapest first: `queuerName`, `remainingCapacity` (supply), `feeCents` plus `clock` (schedule). A clock with `startsAt: null` has not started: show the fixed opening fee and "the fee clock starts when the queuer checks in" (`claimStatus` tells on the way or in line) |
| `closesAt` (rolling rounds) | No rounds: each bid has its own `deadlineAt`; show the shop's hours (`Shop.hours`) instead |
| `bumps` (label bounce) | Bump on every `book.updated` and `match.created` for that item |

**Catalog ids match.** The server and the in-browser market both build their points from `shared/src/seed.ts`; only the hidden `?city=taipei` street view keeps a few web-only shops, with in-browser data.

Cities: `sf` (the default, Japantown) and `nyc`, both with shops. `City.center` and `zoom` come from `GET /api/cities`; bearing and pitch stay in `web/src/config/cities.ts`.

## 5. The requester's flow (replaces `setMax`, `buyNow`, `cancelMax`)

There is one kind of bid: a max fee per unit. A max fee at or above the current best offer fills at once (the old "buy now"); below it, it rests (the old "set my max").

```ts
// 1. Quote: the suggested caps and the disclosures the form must show (DOMAIN.md section 9).
const quote = await api('POST /api/bids/quote', {}, { shopId, itemId, qty, destination }, { as });
// quote.suggested = { retailCapCents, maxFeeCents, shippingBudgetCents }, quote.limitCents (processing reserve included),
// quote.processingReserveCents, quote.disclosures[]

// 2. Create: the server creates the PayPal order (intent AUTHORIZE) for the whole limit.
const created = await api('POST /api/bids', {}, {
  shopId, itemId, qty,
  retailCapCents: quote.suggested.retailCapCents,
  maxFeeCents,                                   // the slider; at or above the best offer fills now
  shippingBudgetCents: quote.suggested.shippingBudgetCents,
  destination,                                   // { mode: 'ship', country: 'US', region, city, postalCode } or { mode: 'local', cityId }
  deadlineAt: now() + 2 * 24 * 60 * 60_000,      // within 10 days
  funding: 'paypal',                             // or 'venmo'; GET /api/config lists the allowed buttons
  agent: null,
}, { as, idempotencyKey: crypto.randomUUID() });

// 3. Approval.
if (created.checkout.next === 'fake_approve') {
  // Fake mode: show a "Simulated PayPal" sheet (never PayPal's artwork), then:
  await api('POST /api/fake/paypal/orders/:orderId/approve', { orderId: created.checkout.orderId }, { funding: 'paypal', outcome: 'approve' });
} else {
  // Sandbox: PayPal's own v6 button with created.checkout.orderId (PAYPAL-MAPPING.md section 3; below).
}

// 4. Authorize: the hold exists; matching runs at once.
const result = await api('POST /api/bids/:bidId/authorize', { bidId: created.bid.id }, { orderId: created.checkout.orderId }, { as });
// result.hold.status === 'held'; result.matches has fills when the max fee met an offer
```

**Sandbox (built, 11-07).** `web/src/services/payments/paypalV6.ts` loads `paypal.sdkUrl` once and calls `paypal.createInstance({ clientId, components, pageType: 'checkout', locale: 'en-US', testBuyerCountry })` with what `GET /api/config` gives (no client token needed), then `findEligibleMethods({ currencyCode: 'USD' })`; the confirm step ("Book now" and "Set my max fee") shows `<paypal-button>`, and `<venmo-button>` only when `isEligible('venmo')`. The click calls `session.start({ presentationMode: 'auto' }, orderPromise)` at once, where the order promise is steps 1 and 2 (the quote is asked for when the sheet opens); `onApprove` runs step 4, `onCancel` and `onError` end the bid with `approval-failed` (`web/src/services/payments/approval.ts`, D-70 to D-73). Checked against the sandbox on 11-07 at 390x844 (authorization ids): a max-fee hold `7PR91697PN385074S` ($48.00, PayPal), Book now `93S72499LJ423434D` ($62.00, matched with Wei at $14) and Venmo `7RB884471X718305E` ($56.00, funding `venmo`, gate G4); the closed window, Stop and a declined authorization each end with a plain message and no spinner.

On a cancelled or failed approval call `POST /api/bids/:bidId/approval-failed { reason, detail }`. If authorize answers `PAYPAL_DECLINED` with `details.issue` `INSTRUMENT_DECLINED`, the bid stays `awaiting_approval`: start the approval again with the same order id, then authorize again. To cancel the unmatched rest: `POST /api/bids/:bidId/cancel { reason }` (the hold is voided when nothing was captured). Money after that is the server's: receipt capture, tracking and final capture, release, payouts. The requester only reads it.

Order states the cards show, from the records:

| Old `OrderStatus` | Derive from |
|---|---|
| `approving` | `bid.status === 'awaiting_approval'` |
| `resting` | `bid.status` `open` or `partially_matched` |
| `booked` | a `job` exists for the bid and is not `verified`, `shipped`, `delivered`, `failed` or `refunded` |
| `settling` | `job.status === 'proof_submitted'`, or a `pending` ledger entry for the bid |
| `filled` | `job.status` `verified`, `shipped` or `delivered` |
| `released` | `bid.status` `cancelled` or `expired` (`hold.status === 'released'`) |
| `missed` | `bid.closeReason === 'sold_out'` (bid `expired`, hold released). A queuer's no-show is not a miss: the job fails with `no_show` and the request goes back to `open` for the next offer |
| `error` | `bid.status === 'failed'` or an `ApiErrorBody` |

## 6. Money panel and activity

Replace `payments.activity()` and `payments.subscribe()` with `GET /api/ledger?mine=1` (newest first) plus `ledger.appended` events (keep the latest record per `id`; a pending entry turns `succeeded` or `failed` later). `LedgerEntry` is a superset of `Activity`: same `kind`, `amount`, `text`, `at`, plus `status`, `mode`, `bidId`, `jobId` and PayPal ids. Two kinds are new: `renewed` (a hold reauthorized on day 4) and `refunded`. Show `entry.text` as is; it is written for people. `MoneyPanel`'s line "This prototype simulates the payments" becomes the banner from `GET /api/config`: fake mode "Simulated PayPal", sandbox "PayPal sandbox: no real money".

Queuers read `GET /api/payouts?mine=1` and `payout.updated` (the receiver email is never sent to them). The web app shows the queuer persona's payouts from `GET /api/ledger?mine=1` as the queuer and that persona's own `ledger.appended` events (each ledger line goes only to its owner), merged with the requester's lines, newest first, each tagged with whose it is.

## 7. The queuer's flow (new screens)

| Step | Call | Notes |
|---|---|---|
| Offer | `POST /api/asks` `{ shopId, itemId, capacity, modes, feeCents, clock, etaAt, from: { lngLat, accuracyM } }` | Only within 30 minutes' travel of the shop; ETA no earlier than the honest travel time. Returns the `claim` with the private `checkInCode` |
| Take one request | `POST /api/bids/:bidId/claim` `{ qty, etaAt, modes, from }` | At the bid's max fee |
| Check in | `POST /api/files?purpose=line_photo` (raw image bytes, `Content-Type: image/png`, `image/jpeg` or `image/webp`), then `POST /api/claims/:claimId/check-in` `{ lngLat, accuracyM, photoFileId }` | Inside the geofence before the window ends. The photo must show the claim's code; the AI check runs async (`proof.updated`, then `claim.updated` with `checked_in`). The fee clock starts here |
| Bought | `POST /api/jobs/:jobId/bought` | |
| Proof | Upload `receipt` and `item_photo` (the item photo shows the job's `proofCode`), then `POST /api/jobs/:jobId/proof` `{ receiptFileId, itemFileId }` | Verified async: `proof.updated`, `job.updated`, `ledger.appended`, `payout.updated` |
| Ship | Upload a `label`, then `POST /api/jobs/:jobId/shipment` `{ carrierName, trackingNumber, shippingCostCents, dutyPaidCents, labelFileId }` | Tracking goes to PayPal, then the final capture, the release and the reimbursement payout |
| Local handover | `POST /api/jobs/:jobId/handover` `{ code }` | The requester reads out `job.handoverCode` |
| Sold out | Upload a `sold_out_photo`, then `POST /api/jobs/:jobId/sold-out` `{ photoFileId }` | Every job not yet bought fails and its hold is voided |

**Built (11-07).** `web/src/ui/queuer`, mounted by `pages/MapPage.tsx`. A switch under the top bar swaps the requester's and the queuer's phone (`?phone=queuer`), and "Switch people" picks other personas from `GET /api/users`. On the queuer's phone a task card shows the fee, the trip, the line and $/hour, with "Take this task" (an ask at the top request's fee, D-77) and "Offer my own fee" (fee, step-down preview, ETA, capacity). The errand sheet then walks six steps: the arrival window (countdown, trip, the one-time code, "Walk there" in demo mode, check-in inside the geofence with a camera or uploaded photo), the line-photo check, the line (queue timer, fee clock, "Bought" or "Sold out", which shows the holds released), the receipt and item photos with the AI check card, tracking (ship) or the handover code (local), and "Paid $X by PayPal Payouts" with the time and the realized $/hour (D-80). The requester's phone shows the handover code. Calls: `POST /api/asks`, `POST /api/asks/:askId/withdraw`, `GET /api/asks?mine=1`, `GET /api/claims/:claimId`, `POST /api/claims/:claimId/check-in`, `POST /api/claims/:claimId/done`, `POST /api/files`, `GET /api/jobs` and `GET /api/jobs/:jobId`, `POST /api/jobs/:jobId/bought`, `sold-out`, `proof`, `shipment` and `handover`, `GET /api/payouts?mine=1`, `GET /api/users`; events from the two persona streams (D-81). `node scripts/queuer-walk.mjs` (in `web/`) walks a genuine job, the fake receipt, a local handover and a sell-out at 390x844 and saves `proto-shots/v3/working/queuer-*.png` (a git-ignored working folder, so those screenshots stay local; only `proto-shots/v2/final/` is tracked).

Fake mode only: `POST /api/files?...&fixture=<scenario>` names a simulated reading for photos that are not rendered fixtures (`line_ok`, `genuine`, `fake_receipt`, ...). Real camera photos without a key go to the rules-only reader, which can only read the rendered fixtures in `server/fixtures/proofs`; anything else needs a scenario in fake mode or an AI key.

## 8. Realtime

```ts
const es = new EventSource(`/api/events?as=${as}`);   // the browser resends Last-Event-ID on reconnect
es.addEventListener('hello', (e) => { /* HelloEvent: bootId, seq, clock. A new bootId means: refetch everything */ });
es.addEventListener('resync', () => { /* refetch books, bids, ledger */ });
for (const type of ['book.updated', 'ask.updated', 'claim.updated', 'match.created', 'bid.updated', 'hold.updated',
                    'job.updated', 'proof.updated', 'ledger.appended', 'payout.updated', 'clock.updated',
                    'queuer.moved', 'demo.cue']) {
  es.addEventListener(type, (e) => apply(type, JSON.parse((e as MessageEvent).data).data));
}
```

Each payload is the full current record: keep the latest per id. `queuer.moved` (demo walks, synthetic) moves the avatars; `demo.cue` carries the film captions. A demo reset (`POST /api/demo/start`) ends every stream with `resync`; reconnecting gives the new `bootId`.

## 9. Errors to show

`ApiErrorBody.error.code` (table in API.md section 2). The prototype's four `PaymentError` codes keep their meaning (`INVALID_AMOUNT`, `HOLD_NOT_FOUND`, `HOLD_CLOSED`, `OVER_CAPTURE`). The ones a requester or queuer will meet: `OVER_LIMIT`, `FEE_BELOW_MINIMUM`, `OVER_STORE_LIMIT`, `PAYPAL_DECLINED`, `RENEWAL_REQUIRED`, `OUT_OF_RANGE`, `OUTSIDE_GEOFENCE`, `GPS_TOO_COARSE`, `WINDOW_CLOSED`, `RELIABILITY_TOO_LOW`, `WRONG_CODE`, `SOLD_OUT`. Show `error.message` (plain English) and keep `paypalDebugId` for ops.

## 10. Order of work and acceptance

1. Section 2 wiring and the `server` backend flag; `GET /api/config` drives the mode banner.
2. Map points from books (section 4), with SSE for `book.updated`, `match.created`, `clock.updated`.
3. Requester flow (section 5) with the "Simulated PayPal" sheet; money panel from the ledger (section 6).
4. Queuer screens (section 7).
5. Sandbox: PayPal's v6 buttons (PAYPAL-MAPPING.md section 3) after the owner has run `scripts/setup-sandbox-secrets.mjs`.

Acceptance, in fake mode with `npm run demo` in `server/` and `npm run dev` in `web/`:

- With `?backend=server&as=mia`, after the hero run the money panel shows the ledger lines of `server/test/hero.test.ts`: Mia's held $63.70, captured $48.69, captured $9.57, released $5.44 (processing at cost on both captures), and Wei's paid out $10.80 and $42.75 (the default queuer persona).
- `POST /api/demo/start {"scriptId":"hero","speed":60}` plays the hero on the map: Wei's avatar walks over, his fee steps down from $15 at 10:50 (the Paper Moon Toys sheet shows the step-down card), Mia's plush fills at $12 at 11:05, Rex's receipt fails ("$0 moved"), and the closing caption reads "Held $63.70. Charged $58.26. Fake receipt: $0."
- Opening the same moment in the ops console (`ops/`, `npm run shots:live` takes the board and dashboard along the run) shows the same numbers, because both read the same server.
- A Playwright smoke run like `ops/scripts/shots-live.mjs` passes with no page errors.
