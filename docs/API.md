# HoldMySpot API

Status: proposed, 2026-11-07. The source of truth is `shared/src/contract.ts` (`ApiSpec`, `ENDPOINTS`, `ServerEventData`); this page explains it. Base URL in development: `http://127.0.0.1:8796` (the web and ops dev servers proxy `/api` to it).

## 1. Basics

- **JSON** in and out, UTF-8. Money is integer US cents; times are market-clock epoch milliseconds (`MarketMs`).
- **Persona.** No real sign-in in v1. Requests act as the seeded user named in `X-HMS-User` (for example `mia`, `wei`). SSE uses `?as=` instead. Ops uses `as=ops` on SSE and needs no persona for admin routes.
- **Admin routes** (`/api/ops/*`, `POST /api/jobs/:id/delivered`) are open while the server listens on a loopback address; otherwise they need `X-HMS-Admin-Key`.
- **Modes.** `/api/fake/*` works only in fake mode (`FAKE_ONLY` otherwise); `/api/demo/*` only with `HMS_DEMO=1` (`DEMO_ONLY`).
- **Idempotency.** Endpoints marked idempotent accept `Idempotency-Key`; a repeat with the same key, route and persona returns the first response. A different body under the same key returns `IDEMPOTENCY_CONFLICT`.
- **Phases.** P0 is the hero loop in fake and sandbox modes; P1 the agent, ops and extras; P2 disputes. Unbuilt routes answer `501 NOT_BUILT`.
- **Typed client.** Every app calls the API through the contract types:

```ts
import { apiPath, endpointParts, HEADERS, type ApiKey, type ApiSpec, type ApiErrorBody } from '@holdmyspot/shared';

export async function api<K extends ApiKey>(
  key: K,
  params: ApiSpec[K]['params'],
  body: ApiSpec[K]['body'],
  opts: { as?: string; query?: ApiSpec[K]['query']; idempotencyKey?: string } = {},
): Promise<ApiSpec[K]['response']> {
  const { method } = endpointParts(key);
  const qs = new URLSearchParams((opts.query ?? {}) as Record<string, string>).toString();
  const res = await fetch(apiPath(key, params) + (qs ? `?${qs}` : ''), {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.as ? { [HEADERS.persona]: opts.as } : {}),
      ...(opts.idempotencyKey ? { [HEADERS.idempotency]: opts.idempotencyKey } : {}),
    },
    body: body === null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw (await res.json()) as ApiErrorBody;
  return res.json();
}
```

## 2. Errors

Body: `{ "error": { "code": "OVER_LIMIT", "message": "...", "details": { ... }, "paypalDebugId": "..." } }`.

| HTTP | Codes |
|---|---|
| 400 | `BAD_REQUEST`, `INVALID_AMOUNT`, `OVER_STORE_LIMIT` (also when a person's requests for one item, live or bought, would pass the shop's per-person limit, D-132), `FEE_BELOW_MINIMUM`, `RETAIL_CAP_TOO_LOW`, `DEADLINE_OUT_OF_RANGE`, `MODE_NOT_ALLOWED`, `GPS_TOO_COARSE`, `WRONG_CODE` |
| 401 | `UNAUTHORIZED` (missing or unknown persona, wrong admin key) |
| 402 | `PAYPAL_DECLINED` |
| 403 | `FORBIDDEN`, `RELIABILITY_TOO_LOW`, `DEMO_ONLY`, `FAKE_ONLY`, `SANDBOX_ONLY` |
| 404 | `NOT_FOUND`, `HOLD_NOT_FOUND` |
| 409 | `CONFLICT`, `INVALID_TRANSITION`, `IDEMPOTENCY_CONFLICT`, `HOLD_CLOSED`, `HOLD_EXPIRED`, `RENEWAL_REQUIRED`, `SELF_MATCH`, `SOLD_OUT`, `WINDOW_CLOSED` |
| 422 | `OVER_CAPTURE`, `OVER_LIMIT`, `OUT_OF_RANGE`, `OUTSIDE_GEOFENCE` |
| 429 | `RATE_LIMITED` |
| 500 | `INTERNAL` (anything unexpected) |
| 501 | `NOT_BUILT` |
| 502 | `PAYPAL_ERROR` |
| 503 | `PAYPAL_UNAVAILABLE`, `AI_UNAVAILABLE` |

## 3. Endpoints

Auth: `pub` public, `per` persona, `adm` admin, `pp` PayPal, `fake` fake mode, `demo` demo mode. `*` = accepts `Idempotency-Key`.

### System, catalog, market

| Endpoint | P | Auth | Request | Response |
|---|---|---|---|---|
| `GET /api/health` | P0 | pub | | `HealthResponse` |
| `GET /api/config` | P0 | pub | | `AppConfig` (mode and reason, PayPal client id and SDK URL, allowed buttons, AI stamp, clock, rules) |
| `GET /api/clock` | P0 | pub | | `ClockState` |
| `GET /api/events` | P0 | per | `?as=&since=` | SSE stream of `EventEnvelope` (section 5) |
| `GET /api/cities` | P0 | pub | | `{ cities }` |
| `GET /api/shops` | P0 | pub | `?cityId=` | `{ shops }` with items |
| `GET /api/shops/:shopId` | P0 | pub | | `{ shop, books }` |
| `GET /api/users` | P0 | pub | `?role=` | `{ users }` (home positions removed) |
| `GET /api/me` | P0 | per | | `{ user }` |
| `GET /api/books` | P0 | pub | `?cityId=` | `{ books, asOf }`: what lights up the map |
| `GET /api/books/:shopId/:itemId` | P0 | pub | | `{ book, asks, recentMatches }` |
| `POST /api/files` * | P0 | per | raw image bytes, `Content-Type` image/jpeg, png or webp, `?purpose=`; fake mode only: `&fixture=` names a simulated reading for the in-process fake AI (`genuine`, `over_cap`, `wrong_seller`, `time_before_checkin`, `totals_off`, `fake_receipt`, `no_code`, `unreadable`, `generated`; line photos: `line_ok`, `no_code`, `no_line`, `unreadable`); the proof's `ai.simulated` then names it. With no model, no recording and no `fixture`, a photo goes to review instead of passing (D-128) | `{ file: FileRef }` (sha256, and dHash when the AI services provide one) |
| `GET /api/files/:fileId` | P0 | per | | image bytes (job participants and ops only) |

### Bids (requesters)

| Endpoint | P | Auth | Request | Response | Rules |
|---|---|---|---|---|---|
| `POST /api/bids/quote` | P0 | per | `QuoteRequest` | `BidQuote` | AI-SERVICES 4.3 and 4.4; suggested retail cap = shop price + 5%, rounded up to a dollar; 409 `SOLD_OUT` once the item sold out (D-116) |
| `POST /api/bids` * | P0 | per | `CreateBidRequest` | `CreateBidResponse` | Requester in the US; item exists; mode allowed (local only in the requester's own city); qty within the per-person limit, counting the person's other live or bought requests for the item (D-132; the demo script's staged requests and the seeded crowd excepted); retail cap at least the shop price; max fee at least the item minimum; deadline within 10 days; button allowed; the item not sold out (409 `SOLD_OUT`, D-116). Creates the PayPal order |
| `POST /api/bids/:bidId/authorize` * | P0 | per | `{ orderId }` | `BidResult` | Authorizes; bid `open` only when PayPal answers `CREATED` for the hold's exact amount, then matching runs; `matches` may already contain fills. `PENDING`: 503 `PAYPAL_UNAVAILABLE`, the bid stays `awaiting_approval` and the sweep reads the authorization again; `DENIED` or another amount: 402 `PAYPAL_DECLINED`, bid `failed` (another amount is voided) (D-150). After a sell-out nothing is authorized: bid `failed` (close reason `sold_out`), 409 `SOLD_OUT`, nothing held (D-116) |
| `POST /api/bids/:bidId/approval-failed` * | P0 | per | `{ reason, detail }` | `{ bid, hold }` | Bid `failed` |
| `GET /api/bids` | P0 | per | `?mine=1&status=&shopId=` | `{ bids }` | Own bids only |
| `GET /api/bids/:bidId` | P0 | per | | `BidDetail` | Owner and ops |
| `PATCH /api/bids/:bidId` * | P1 | per | `AmendBidRequest` | `{ bid, matches }` | New `bidLimitCents` (qty x (retailCap + maxFee) + shippingBudget + the processing reserve, D-105) must stay within `limitCents` (`OVER_LIMIT`); qty not below matched qty; a new max fee resets time priority |
| `POST /api/bids/:bidId/cancel` * | P0 | per | `{ reason }` | `{ bid, hold }` | Cancels the unmatched remainder; voids when nothing was captured and no job is active, else `closing` |
| `POST /api/bids/:bidId/claim` * | P0 | per (queuer) | `ClaimBidRequest` | `ClaimBidResponse` | Same queuer rules as asks; fee = the bid's max fee; qty within the bid's remainder |
| `GET /api/bids/:bidId/agent-actions` | P1 | per | | `{ actions }` | |
| `POST /api/bids/:bidId/agent` * | P1 | per | `{ enabled }` | `{ bid }` | Pause or resume |

### Asks, claims, jobs (queuers)

| Endpoint | P | Auth | Request | Response | Rules |
|---|---|---|---|---|---|
| `POST /api/asks` * | P0 | per | `CreateAskRequest` | `AskResult` | Queuer role; reliability at least 60; within 30 minutes' travel (`OUT_OF_RANGE`); ETA between the earliest honest ETA and now + travel + 30 min; capacity within the per-person limit; fee and clock floor at least the item minimum; valid clock; one open ask per queuer per shop. Creates the claim |
| `GET /api/asks` | P0 | per | `?mine=1&shopId=&status=` | `{ asks }` | |
| `POST /api/asks/:askId/withdraw` * | P0 | per | | `WithdrawAskResponse` | Matched jobs stay; withdrawing after a match counts against reliability |
| `GET /api/claims/:claimId` | P0 | per | | `ClaimDetail` | Codes only for the queuer |
| `POST /api/claims/:claimId/check-in` * | P0 | per | `CheckInRequest` | `CheckInResponse` | Before `windowEndsAt` (`WINDOW_CLOSED`); geofence (`OUTSIDE_GEOFENCE`, `GPS_TOO_COARSE`); a `line_photo` file of this persona. The photo check runs async |
| `POST /api/claims/:claimId/done` * | P1 | per | | `ClaimDetail` | Ends the visit; remaining capacity closes |
| `GET /api/jobs` | P0 | per | `?mine=1&role=&status=` | `{ jobs }` | |
| `GET /api/jobs/:jobId` | P0 | per | | `JobDetail` | Participants and ops |
| `POST /api/jobs/:jobId/bought` * | P0 | per | | `{ job }` | Queuer; job `queueing` |
| `POST /api/jobs/:jobId/sold-out` * | P1 | per | `{ photoFileId }` | `{ job, book }` | Queuer, checked in. The reporter's own unbought jobs fail and his offers close; the book becomes `sold_out` only at the second distinct reporter (D-152) |
| `POST /api/jobs/:jobId/proof` * | P0 | per | `{ receiptFileId, itemFileId }` | `{ job, proof }` | Queuer; job `queueing` or `bought`; verification async (`proof.updated`, then `job.updated`, `ledger.appended`) |
| `POST /api/jobs/:jobId/shipment` * | P0 | per | `AddShipmentRequest` | `JobMoneyResult` | Queuer; ship mode; job `verified`; adds tracking, then the shipping capture and the reimbursement payout |
| `POST /api/jobs/:jobId/handover` * | P0 | per | `{ code }` | `JobMoneyResult` | Queuer types the requester's code (`WRONG_CODE`; after 5 misses in an hour `RATE_LIMITED`, D-56); local mode; job `verified`; one capture and the payout (`PAYPAL_DECLINED` fails the job) |
| `POST /api/jobs/:jobId/delivered` * | P1 | adm | | `{ job }` | Carrier stand-in for shipped jobs |

`POST /api/jobs/:jobId/refund-request` * (P2, the requester): `{ reason }`, answers `{ job }`. It asks a person for money back and moves nothing (D-160).

### Money, AI, PayPal

| Endpoint | P | Auth | Request | Response |
|---|---|---|---|---|
| `GET /api/holds/:holdId` | P0 | per | | `{ hold }` |
| `GET /api/ledger` | P0 | per | `?mine=1&bidId=&jobId=` | `{ entries }` newest first |
| `GET /api/payouts` | P0 | per | `?mine=1` | `{ payouts }` newest first |
| `POST /api/paypal/webhook` | P1 | pp | PayPal event | `{ ok: true }` after signature verification |
| `POST /api/estimates/fee` | P1 | per | `FeeEstimateRequest` | `FeeEstimate` |
| `POST /api/estimates/shipping` | P1 | per | `ShippingEstimateRequest` | `ShippingEstimate` |
| `POST /api/fake/paypal/orders/:orderId/approve` * | P0 | fake | `{ funding, outcome }` | `{ orderId, status }` |

### Ops (admin)

| Endpoint | P | Request | Response |
|---|---|---|---|
| `GET /api/ops/board` | P1 | `?from=&to=&cityId=` (ISO or epoch ms) | `BoardData` for the Bryntum Scheduler: queuer rows, claim windows, queueing and job bars, fee clocks, hold honor periods |
| `GET /api/ops/datasets/:name` | P1 | `fills`, `bids`, `asks`, `jobs`, `holds`, `ledger`, `payouts`, `books` | `OpsDataset` flat rows for AG Studio, built by `opsDatasets` in `shared/src/opsviews.ts` (the console builds the same rows): dollars in `*Usd` fields, times in `at` and `*At`, `shopId` on every table, `slot` as San Francisco "HH:MM" |
| `GET /api/ops/records` | P1 | | `OpsRecords`: every market record in one read (personas with home positions, crowd names, bids, holds, asks, claims, matches, jobs, proofs, ledger, payouts, agent actions). The ops console draws its board, map and dashboard from it (D-49) |
| `POST /api/ops/proofs/:proofId/review` * | P1 | `{ decision, note }` | `{ proof, job }` |
| `POST /api/ops/jobs/:jobId/refund` * | P1 | `{ amountCents, reason }`; refused while a dispute is open on the job (`CONFLICT`, D-160) | `JobMoneyResult` |
| `POST /api/ops/jobs/:jobId/refund-request/close` * | P2 | `{ note }`: a person closes a refund request without refunding | `{ job }` |
| `POST /api/ops/holds/:holdId/reauthorize` * | P1 | | `{ hold, ledger }` (day 4 to 29 only) |
| `POST /api/ops/sweep` | P1 | | `SweepResult` |
| `GET /api/ops/disputes` | P2 | | `{ disputes }` |
| `POST /api/ops/disputes/:disputeId/draft` | P2 | none: words the note again (AI words code-supplied facts, or the template, D-161) | `{ dispute }` |
| `POST /api/ops/disputes/:disputeId/evidence` * | P2 | `{ note, includeTracking }`; the server attaches the proof photos and receipt fields; sent once | `{ dispute }` |
| `POST /api/ops/disputes/:disputeId/accept` * | P2 | `{ note }` | `{ dispute }` |
| `POST /api/ops/disputes/:disputeId/adjudicate` * | P2 | `{ outcome }` (sandbox only) | `{ dispute }` |
| `POST /api/ops/agents/turn` | P1 | `{ agent, instructions, messages, tools, toolChoice }`: the conversation so far and the tools the console runs | `{ say, calls, ai }`: one turn of the ops console's agents (the market desk, the AG Studio agents it delegates to, the rescheduler) from the server's AI port. Live model only, never recorded or replayed; without one `503 AI_UNAVAILABLE` and the console uses its offline planner and rules (D-100, D-103) |
| `POST /api/ops/moves` * | P1 | `{ moves, reason, proposalId, ai }`, each move `reassign { jobId, toAskId }`, `extend { claimId, minutes }`, `release { claimId }` or `release_job { jobId }` | `{ applied, skipped, actions }`: each move checked again with the market rules, in its own transaction; a refused move or one naming an unknown record is skipped with its reason; a move that touches a request is logged as an agent action on it, every applied move in the server log; `409` when none applies (D-102, D-117) |

### Demo (`HMS_DEMO=1`)

`GET /api/demo/scripts`, `GET /api/demo/state`, `POST /api/demo/reset { seed, scriptId }`, `POST /api/demo/start { scriptId, speed }`, `POST /api/demo/pause`, `POST /api/demo/resume`, `POST /api/demo/step`, `POST /api/demo/clock { speed?, paused?, jumpTo? }`. All P1, all return `DemoState` except the clock route (`ClockState`). When a script finishes, the market clock pauses on its last moment; `resume` leaves a finished script there, and `clock { paused: false }` runs the market on.

### Built so far (2026-11-07)

Every endpoint above is registered. Not built yet (it answers `501 NOT_BUILT`): `POST /api/paypal/webhook` (P1; status sync polls instead). `GET /api/ops/disputes` reads what the status sync found on PayPal (D-160). `HMS_SERVE_STATIC` is not built.

Integrated in fake mode (2026-11-07, D-47 to D-52): the PayPal port is the sandbox REST client on the in-process emulator, the AI port is the AI services without a key, and `server/test/e2e.test.ts` runs the hero story over these routes only. Fake-mode failure injection: `HMS_FAKE_FAIL=<op>:<effect>[:<count>|*]`. How the web app switches from its mock: [WEB-INTEGRATION.md](WEB-INTEGRATION.md).

## 4. Hero flow as calls

| Who | Call | Result |
|---|---|---|
| web (Mia) | `POST /api/bids/quote` | one Mochi Bunny plush shipped to New York: suggested retail cap $36, fee $12, shipping budget $12, processing reserve $3.70; limit $63.70 |
| web (Mia) | `POST /api/bids` | `{ bid: awaiting_approval, checkout: { orderId, next } }` |
| browser | PayPal v6 session `start` with that order id (or the fake approve route) | buyer approves |
| web (Mia) | `POST /api/bids/:bidId/authorize` | hold `held` $63.70; ledger `held`; `book.updated` |
| web (Wei) | `POST /api/asks` with a clock | ask `open`, claim `awaiting_arrival` |
| web (Wei) | `POST /api/files?purpose=line_photo`, then `POST /api/claims/:id/check-in` | claim `arrived`, then `checked_in` on `proof.updated`; clock starts |
| server | clock step at 11:05 | `match.created` (1 at $12), `job.updated` (claimed then queueing), `bid.updated` (matched) |
| web (Wei) | `POST /api/jobs/:id/bought`, two uploads, `POST /api/jobs/:id/proof` | proof `verifying`, then `passed`; job `verified`; ledger `captured` $48.69 ($34.00 + $12.00 + $2.69 processing at cost, PayPal's fee on it in `paypal.feeCents`); payout $10.80 |
| web (Wei) | `POST /api/jobs/:id/shipment` | ledger `captured` $9.57 ($8.75 + $0.82 processing) and `released` $5.44; job `shipped`; payout $42.75 |

## 5. Server-sent events

`GET /api/events?as=<userId>&since=<seq>`. Each message:

```
id: 1042
event: ledger.appended
data: {"seq":1042,"type":"ledger.appended","at":1762911840000,"data":{ ...LedgerEntry }}
```

The first message is `hello` (`HelloEvent` with `bootId`, the current `seq` and the clock). Pings are SSE comments every 15 seconds. Reconnects send `Last-Event-ID`; if those events are gone the server sends `resync` and the client refetches. A new `bootId` (restart or demo reset) also means refetch.

| Event | Payload | Who receives it |
|---|---|---|
| `hello` | `HelloEvent` | the connecting client |
| `resync` | `{ reason }` | the connecting client |
| `clock.updated` | `ClockState` | everyone |
| `book.updated` | `BookSnapshot` | everyone |
| `ask.updated` | `AskTask` | everyone |
| `claim.updated` | `Claim` | everyone, with `checkInCode` and `arrival` removed except for the queuer and ops |
| `match.created` | `Match` | everyone |
| `queuer.moved` | `QueuerMovedEvent` (synthetic) | everyone (demo mode only) |
| `bid.updated` | `BidTask` | the requester, ops |
| `hold.updated` | `Hold` | the requester, ops |
| `agent.action` | `AgentAction` (with `refusedFeeCents` when a raise above the hold was refused, D-158) | the requester, ops |
| `job.updated` | `Job` | the requester (with `handoverCode`), the queuer (with `proofCode`), ops |
| `proof.updated` | `Proof` | the job's requester and queuer, ops |
| `ledger.appended` | `LedgerEntry` | the entry's `userId`, ops |
| `payout.updated` | `Payout` | the queuer (without `receiverEmail`), ops |
| `dispute.updated` | `Dispute` | ops |
| `demo.state` | `DemoState` | everyone |
| `demo.cue` | `DemoCue` | everyone |

Each payload is the full current record, so a client keeps the latest one per id. Market prices of clocked asks are computed in the client from `AskQuote.clock` with `askFeeAt`; the server does not send a tick per price step (it sends `book.updated` when a step causes a fill).
