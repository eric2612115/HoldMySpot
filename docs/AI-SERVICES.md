# AI services

Status: proposed, 2026-11-07. The provider boundary is `AiProvider` in `shared/src/ports.ts`; results reach the apps as `Proof`, `FeeEstimate`, `ShippingEstimate` and `AgentAction` in `shared/src/contract.ts`, each stamped with `AiStamp` (provider, model, mode, latency).

## 1. Principles

1. **Models read and explain; code decides money.** A vision model extracts receipt fields and counts people in a line; deterministic rules decide pass or fail and compute every amount. No model output is ever a capture amount by itself.
2. **Every AI result says where it came from**: provider, model and mode (`live`, `record`, `replay` or `fake`) are on the record and on screen in small print.
3. **Fail safe.** A provider error, timeout or refusal never passes a proof; it becomes `needs_review` for the ops console.
4. **Deterministic demos.** Takes are filmed with `HMS_AI_MODE=replay`: committed fixtures give the same output every run, and the screen shows "replay". Live calls are shown separately and honestly labelled.
5. **No overclaims.** We check that a receipt is from the pinned shop, at the right time, for the right item, and not recycled. We do not claim to authenticate goods.

## 2. Providers and keys

| Provider id | Model (default) | Key (env var name) | Transport |
|---|---|---|---|
| `anthropic` | `claude-opus-5-5` (`HMS_ANTHROPIC_MODEL`) | `ANTHROPIC_API_KEY` | Official SDK `@anthropic-ai/sdk` |
| `muse` | `muse-spark-1.3` (`HMS_MUSE_MODEL`) | `MODEL_API_KEY` | `POST https://api.meta.ai/v1/chat/completions` (`HMS_MUSE_URL`), Bearer key |
| `openai` | `gpt-6.1-sol` (`HMS_AI_MODEL`) | `OPENAI_API_KEY` | Any OpenAI-compatible Chat Completions endpoint: `POST <HMS_AI_BASE_URL>/chat/completions` (default `https://api.openai.com/v1`), Bearer key. `MODEL_API_KEY` is sent only to Meta's own host, so it serves this provider only when `HMS_AI_BASE_URL` points there. Not yet called with a real OpenAI key. |
| `fake` | `rules-v1` | none | In process |

**Where keys are read.** Only these names, only from: the process environment, `ai.env` in the secrets folder (`$HMS_SECRETS_DIR`, default the repo's `.secrets/` written by `npm run keys`; no folder outside the repo unless `HMS_SECRETS_DIR` names it, D-131), and any extra dotenv files listed in `HMS_AI_KEY_FILES` (comma-separated; from those files the loader reads `ANTHROPIC_API_KEY`, `MODEL_API_KEY` and `OPENAI_API_KEY` and ignores every other line; `path#NAME` narrows a file to one name). Values are never logged, printed, returned by the API or written to fixtures. At boot the server logs one line built from `AiKeyReport`, for example: `AI: anthropic key absent, muse key present (ai.env); using muse muse-spark-1.3, mode live`.

**Default:** `HMS_AI_PROVIDER=auto` picks `anthropic` when its key is present, else `muse`, else `openai` (with its own `OPENAI_API_KEY`), else `fake`. `HMS_AI_MODE` defaults to `replay` in fake mode (so fake mode makes no network calls; without a fixture it falls back to `fake`) and to `live` in sandbox mode; it is forced to `fake` when the provider is `fake`. Setting `HMS_AI_MODE=live` in fake mode is allowed on purpose (live AI with simulated PayPal) and is the only way fake mode touches the network.

**A key kept in another dotenv file:** set `HMS_AI_KEY_FILES=<file>#MODEL_API_KEY` in the git-ignored `server/.env.local`. The `#MODEL_API_KEY` suffix makes the loader read that one name from the file and nothing else, at run time, and the key is never printed or logged (startup says only "muse key present"). `auto` then resolves to `muse`. `server/.env.local` is read by `server/src/localenv.ts` and may set `HMS_*` names only; the shell environment wins over it. Without the file the server falls back to the rules-only fake, as before.

## 3. Modes and fixtures

| `HMS_AI_MODE` | Behaviour |
|---|---|
| `live` | Call the provider. |
| `record` | Call the provider and save the result to `server/fixtures/ai/<task>/<fixtureKey>.json`. |
| `replay` | Return the saved fixture; if none exists, fall back to `fake` and say so in the stamp. |
| `fake` | Rules only: the fake provider returns the `truth.json` sidecar of a demo image, or empty fields (which leads to `needs_review`). |

**Simulated scenarios and staged photos (D-41, D-48).** Fake mode lets an upload name a scenario (`POST /api/files?fixture=...`) for photos nobody can read offline. The AI services first read the photo itself when that needs no network (`replay` or `fake`) and it is a known demo photo (truth sidecar or saved answer); only a photo they cannot read goes to the server's scenario fake (`server/src/fakes/ai.ts`). In `live` and `record` a photo with a scenario never reaches the model. Without a key and without a scenario, an unknown photo goes to ops review instead of passing (D-128); the queuer's phone in the zero-key demo always sends the scenario the queuer picked ("Read my photo as"), and the fake stamps that verdict with `ai.simulated`, so the check card says "Simulated reading, no AI" and never "QR read". The demo director uploads the rendered photos in `server/fixtures/proofs` with their codes pinned on the claims and jobs, so the hero's line photos and receipts go through the whole pipeline (hashes, QR from pixels, duplicate check, shared rules).

`fixtureKey` = SHA-256 of task, prompt version, schema name and the SHA-256 of each image, so a fixture recorded with one provider replays under any provider. Fixtures hold the structured output plus provider, model and time; never keys, never raw prompts with personal data. Fixtures and demo images are committed (judges can replay them); photos of real places from the owner's filming stay outside the repo.

**The recorded answers (D-66).** `server/fixtures/ai` holds Muse Spark's readings of all 21 rendered photos, recorded on 2026-11-07 with `npm run ai:eval -- --record` (owner-approved key, read only as `MODEL_API_KEY`). The demo server in fake mode replays them, so the hero's check-ins and receipts are decided by the rules on a real model reading, offline, stamped `muse` / `muse-spark-1.3` / `replay`. A photo with no recorded answer falls back to the rules-only reader and says `fake`. The test suites read with the rules only (they point `HMS_AI_FIXTURES_DIR` at an empty folder); `server/test/replay.test.ts` plays the hero on the recording and checks the same money. Re-rendering a photo or changing a prompt needs a new recording.

## 4. Services

### 4.1 Check-in photo (load-bearing for the arrival window)

- **When:** `POST /api/claims/:claimId/check-in` after the geofence passes. Runs asynchronously; `proof.updated` reports the result.
- **Input:** the line photo, the claim's `checkInCode`, the shop's printed name.
- **Model reads:** is a queue of people visible, roughly how many are ahead, the code shown on paper or a phone screen, storefront text.
- **Rules:** `geofence` (hard, already done), `code_visible` (hard), `line_visible` (soft), `duplicate_photo` (hard).
- **Effect:** passed moves the claim to `checked_in`, starts the fee clock and moves jobs to `queueing`; the people count feeds the fee estimator. Failed: the queuer may retry until the window ends.

### 4.2 Purchase proof (load-bearing for every capture)

- **When:** `POST /api/jobs/:jobId/proof` with the receipt photo and the item photo (which shows the job's `proofCode` on a sticky note next to the item).
- **Deterministic pre-steps:** SHA-256 and a 64-bit difference hash (dHash) of each photo at upload; decode the receipt QR with `jsQR` on pixels from `sharp`. Our fictional toy shops print a store receipt QR in one fixed text layout, `RCPT1|S:<store ID>|N:<receipt number>|D:<date>|T:<total minor units>|C:<currency>|I:<line>...` (server/src/ai/qr.ts); the checks rely on the store ID, receipt number, date and total. Bakeries and ramen shops print no QR and are checked by their printed name.
- **Model reads** (`purchase_proof` schema): printed shop name, seller ID, invoice number, printed date and time, currency, lines (name, qty, unit, total), total, the code on the sticky note, how many units are visible, and any visible anomalies.
- **Rules** (`ProofCheck`):

| Check | Weight | Pass when |
|---|---|---|
| `code_visible` | hard | Code read from the item photo equals the job's `proofCode` (ambiguous characters normalised) |
| `shop_match` | hard | QR store ID equals the shop's store ID (shops that print a QR); printed name matches the shop's printed name (the others) |
| `qr_matches_print` | hard | QR receipt number, date and total equal the printed ones (shops that print a QR) |
| `time_window` | hard | Printed time is after the claim's check-in minus 5 minutes, before the upload, and within shop hours |
| `totals_add_up` | hard | Sum of lines equals the total (one minor unit tolerance) |
| `duplicate_photo` | hard | No earlier upload from another job within Hamming distance 6 |
| `qty_within_limit` | hard | Units on the receipt for this item equal the job's qty, within the per-person limit |
| `item_match` | soft | Lines match the item's `receiptAliases`; no unrelated lines |
| `within_retail_cap` | soft | Retail in USD at the job's locked rate is above $0 and within the job's retail cap (a $0 reading goes to a person, whose pass charges the shop price, D-135) |
| `listed_price` | soft | Within the cap, the item's lines are at or under the item's listed shop price times the quantity, compared in the receipt's currency; above it, a person checks it (D-151). Not raised when the price is already above the cap |
| `generator_metadata` | soft | No image-generator metadata (C2PA or EXIF software) |

  Any hard failure: `failed`. Any soft failure: `needs_review` (ops decides). Otherwise `passed`.
- **Amounts:** retail = sum of matching lines in US cents (a receipt in another currency would be converted with `localToUsdCents` at the job's locked rate; no seeded shop needs it); capture = `receiptCapture(caps, retail, mode)`: retail after the cap, the matched fee and processing at cost (D-105). Code computes all of it; the model only reads the lines.
- **Effect:** passed moves the job to `verified` and triggers the capture (ship) or unlocks the handover (local). Failed: job `failed` with `proof_rejected`, nothing captured, quantity re-offered.

### 4.3 Fee and ETA estimator

- **When:** bid quote, ask form, and the map's queue info.
- **Formula (code):** expected wait = the latest checked-in line photo's people ahead times the shop's seconds per person, else the item's `expectedWaitMinutes`. Suggested fee per unit = max(`minFeeCents`, wait minutes x 24 cents, rounded to 50 cents). Suggested clock: open = suggested + $3, step $1, interval 5 minutes, floor = max(`minFeeCents`, suggested - $4). Paper Moon Toys at 50 minutes: suggested $12, clock $15 down to $8.
- **Model:** counts people in the latest line photo (from 4.1) and writes the one-line `basis` sentences. Fake mode writes the basis from the formula.

### 4.4 Shipping estimator

- **When:** bid quote for ship mode.
- **Formula (code, `shared/src/estimates.ts`):** parcel = qty x `weightGrams` + 200 g packing. Shipping = demo rate table for the fictional "Harbor Parcel Ground, tracked" within the US: $5.50 + $0.50 per started 100 g, 2 to 5 days. Parcels stay in the US, so the duty rate table is all zeros (it stays for a parcel that would cross a border). Budget = shipping x 1.3, rounded up to whole dollars. One Mochi Bunny plush to New York: 650 g, $9.00 shipping, $12 budget (the hero's label costs $8.75).
- **Notes always shown:** "Estimate. You are charged the shipping the queuer declares, up to your budget." "Ships within the US, so no import duty applies."
- **Model:** writes the explanation; for catalog items every number comes from the catalog and tables. (Estimating packed size from a photo is a later extension, not v1.)

### 4.5 Bidding agent (Best Use of Agentic Commerce)

- **Mandate:** a bid with `agent: { goal }`, for example "2 Lucky Cat plush by Thursday noon San Francisco time, as cheap as possible". The PayPal hold is the mandate: the requester approves once, for the limit.
- **Ceiling:** the most the agent may set as max fee: the highest fee whose worst case, qty x (retail cap + fee) + shipping budget + the processing reserve (`bidLimitCents`, D-105), still fits in the hold (`maxFeeWithinLimitCents`). The server enforces it on `PATCH /api/bids/:bidId`; PayPal holds only the limit.
- **Tools** (ours, run inside the server with these checks): `get_book` (best ask fee now, next clock step and price, asks' ETAs, depth, my position), `get_fee_estimate`, `set_max_fee { maxFeeCents, reason }`, `reduce_qty { qty, reason }`, `cancel_bid { reason }`, `keep { reason }`. The agent cannot capture, pay out, see PayPal ids or create holds.
- **Runs:** at creation, every 15 market minutes, when a compatible ask appears or a clock step brings an ask near its max (debounced 1 minute), and 60 and 15 minutes before the deadline. At most 4 tool steps per run, 30-second timeout; on any failure it keeps the current max and logs a note.
- **Policy (prompt):** fill before the deadline at the lowest fee; wait when a checked-in clock will step to the current max soon; raise gradually as the deadline nears and nothing is in reach; cancel only when sold out or the goal cannot be met. Every action is logged as an `AgentAction` with one plain sentence, shown on the bid screen and the ops board.
- **Fake policy:** target = start + (ceiling - start) x f^1.5, where f is the elapsed share of the window from creation to 30 minutes before the deadline, rounded to 50 cents; keep when the best compatible ask (or its next step within 10 minutes) is at or below the current max; cancel when the book is sold out.

### 4.5a Dispute note (ops console, D-159)

`disputeNote` in `server/src/ai/notes.ts`. Code gathers the facts (`shared/src/disputeNote.ts`: the receipt it read, tracking, the ledger) and attaches the photos; the model only words a short note, and a person reviews it before Send. It decides nothing about money or the outcome. No model, a provider error, or a number the facts do not hold: the template writes it, and `templateReason` on the draft says why. Stamped with provider, model and mode.

### 4.6 Reassign note (ops board)

When a job fails and its quantity is re-offered, one sentence for the board, for example "Rex's receipt failed 4 checks; the plush went back to the book and Lin's offer ($10, ETA 11:30) took it." Fake mode uses a template.

## 5. Output schemas (JSON Schema, strict)

`purchase_proof`:

```json
{
  "type": "object", "additionalProperties": false,
  "required": ["printedName", "sellerTaxId", "invoiceNumber", "issuedAtLocal", "currency", "lines", "totalMinor", "itemPhoto", "anomalies"],
  "properties": {
    "printedName": { "type": ["string", "null"] },
    "sellerTaxId": { "type": ["string", "null"] },
    "invoiceNumber": { "type": ["string", "null"] },
    "issuedAtLocal": { "type": ["string", "null"], "description": "YYYY-MM-DD HH:MM as printed" },
    "currency": { "type": ["string", "null"], "enum": ["TWD", "USD", null] },
    "lines": { "type": "array", "items": { "type": "object", "additionalProperties": false,
      "required": ["name", "qty", "unitMinor", "totalMinor"],
      "properties": { "name": { "type": "string" }, "qty": { "type": "integer" }, "unitMinor": { "type": "integer" }, "totalMinor": { "type": "integer" } } } },
    "totalMinor": { "type": ["integer", "null"] },
    "itemPhoto": { "type": "object", "additionalProperties": false, "required": ["codeSeen", "unitsVisible"],
      "properties": { "codeSeen": { "type": ["string", "null"] }, "unitsVisible": { "type": ["integer", "null"] } } },
    "anomalies": { "type": "array", "items": { "type": "string" } }
  }
}
```

`check_in_photo`: `{ lineVisible: boolean, peopleAhead: integer | null, codeSeen: string | null, storefrontText: string | null }`, same strictness. Prompts tell the model to copy only what is printed and to return null when unsure.

## 6. Provider notes

**Anthropic** (from the claude-api reference, 2026-11-07):

- Use the official `@anthropic-ai/sdk`; never an OpenAI-compatible shim.
- Model `claude-opus-5-5`. Thinking cannot be disabled on this model (send adaptive or omit it); set `output_config.effort` explicitly (its default is `medium`): `medium` for receipts, `low` for line photos and notes.
- JSON output through structured outputs (`output_config.format` with the JSON schema), not forced tool choice (forced `tool_choice` returns 400 on this model).
- Images as base64 `image` content blocks.
- Check `stop_reason` before reading content; a `refusal` becomes `needs_review`. Enable the server-side fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`) and say so in the README.
- No `temperature`, `top_p` or `top_k` (rejected).
- Bidding agent: tool use with `strict: true` tool schemas and `tool_choice: auto`; the SDK's tool runner or a manual loop capped at 4 steps.

**Muse Spark** (Meta's Chat Completions endpoint, a preset of the OpenAI-compatible client in `server/src/ai/openai.ts`): Chat Completions body with `model`, `messages` (images as `image_url` data URLs), `response_format: { type: "json_schema", json_schema: { name, schema } }` and `reasoning_effort`. Tool calling through `tools` is not proven in our code (**probe**); if it is not supported, the agent runs in decision mode: one JSON call per run returns `{ action, maxFeeCents, qty, reason }` and the server applies it through the same checks.

**OpenAI-compatible (`openai`)** (`server/src/ai/openai.ts`): the same body against `HMS_AI_BASE_URL` with `HMS_AI_MODEL` and `OPENAI_API_KEY`. Our own validator checks every answer against the schema (the request does not set `strict`). A model that answers HTTP 400 to `reasoning_effort` is asked once more without it, and that client stops sending it. Instructions go as a `developer` message to api.openai.com and as a `system` message to any other host. No tool calling: the bidding agent runs in decision mode. The key goes only in the Authorization header and never into an error message.

## 7. Evaluation

Fixtures in `server/fixtures/proofs/` (our own rendered fictional receipts and item photos, each with a `truth.json`). Receipts name no card brand: the payment line reads `Card **** 4821` (D-67).

| Fixture | Expected |
|---|---|
| `paper-moon-mia-genuine`, `paper-moon-priya-genuine` | passed, retail $34.00 (captures $48.69 and $46.62; $46.00 and $44.00 before processing at cost, D-105) |
| `little-lantern-2plush-genuine` | passed, 2 x $26.00 |
| `sugar-cloud-cake-genuine`, `petal-crumb-shortcake-usd` | passed (no QR, printed name match) |
| `paper-moon-rex-fake` | failed: shop_match, time_window, totals_add_up, duplicate_photo |
| `paper-moon-qr-wrong-store` | failed: shop_match |
| `paper-moon-qr-print-mismatch` | failed: qr_matches_print |
| `paper-moon-time-before-checkin` | failed: time_window |
| `paper-moon-totals-off` | failed: totals_add_up |
| `paper-moon-recycled-photo` | failed: duplicate_photo |
| `paper-moon-wrong-code` | failed: code_visible |
| `little-lantern-qty-short` | failed: qty_within_limit |
| `paper-moon-over-cap` | needs_review: within_retail_cap |
| `paper-moon-generator-metadata` | needs_review: generator_metadata |
| `steam-lantern-extra-line` | needs_review: item_match |
| `checkin-paper-moon-wei`, `checkin-paper-moon-rex` | passed (line visible, code read) |
| `checkin-no-code` | failed: code_visible |
| `checkin-no-line` | needs_review: line_visible |
| `checkin-recycled` | failed: duplicate_photo |

Results on 2026-11-07 (v2 pass), all 21 cases: the rules-only fake (no model) gets 21/21 verdicts and 164/164 fields, but only because it finds each rendered fixture by its SHA-256 and returns the fixture's own `truth.json` reading (it reads nothing from any other photo), so it is the baseline that shows the rules, not a reader.

Muse Spark (`muse-spark-1.3`, owner approved), live, on the receipts re-rendered without card brands; this run is also the recording the demo replays:

| Measure | Result |
|---|---|
| Verdicts (passed, failed, needs review) | 21/21 |
| Exact set of failed checks | 21/21 |
| Money (retail and capture) | 8/8 |
| Fields read correctly | 161/164 (98.2%) |
| Bad proofs caught | 10/10 |
| Genuine proofs wrongly failed | 0/7 |
| Latency per photo | median 8.1 s, max 12.0 s |

The three misses: the people-ahead count on two line photos was more than 20% low (28 for 38, 30 for 46; an estimate only, never a pass condition), and one store ID digit was misread (41580017 for 41500017) on a receipt whose QR already identifies the shop. An earlier live run on the previous renders (same day) got 21/21 verdicts and 160/164 fields.

`npm test` in `server/` runs them with the rules only, plus the hero and (in `server/test/ablation.test.ts`) all 21 photos on the recorded answers (no network). `npm run ai:eval` replays them and its summary says where the answers came from, counted from each case's stamp: without a key, "Answers: 21 replayed from recorded muse/muse-spark-1.3 answers. No model was called in this run." (a photo without a recording would be counted as read by the rules-only reader). `npm run ai:eval -- --live` runs them live against the configured provider (`--provider auto|anthropic|muse|openai|fake`) and prints the pass rate, and `--record` also saves the answers; both spend model credits, so they run only when the owner says so. The money column checks the full capture: the fixture's shop price plus fee, grossed up for processing at cost (D-105).

Which layer stops which bad proof: [ABLATION.md](ABLATION.md) decides the same 21 photos three ways (Rules + AI, Rules only with the truth sidecar as the reading, AI only with no rule) on the same recorded answers. `npm run ablation` writes it and `docs/evidence/ablation.json`; a test fails when either is out of date (D-140 to D-142).
