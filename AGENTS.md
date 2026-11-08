# AGENTS.md

Notes for AI coding agents working in this repo or checking it for a reviewer. People start with [README.md](README.md).

HoldMySpot has four npm packages without a workspace: `shared/` (contract and pure rules, TypeScript source), `server/` (Node 24, Fastify, `node:sqlite`), `web/` (the phone app) and `ops/` (the operator console). The root `package.json` only holds scripts, written with Node built-ins, so they run before anything is installed.

## Check the repo (no keys, no prompts)

Run from the repo root, in this order:

```sh
node --version                       # v24 or newer (.nvmrc)
npm run setup                        # npm ci in shared, server, web, ops; exit 0
npm run -s doctor -- --json          # pure JSON; exit 0 and "ok": true when the zero-key demo can start
npm test                             # exit 0, ends "All green: 6 steps in N s." (no keys; no PayPal or model call); several minutes, allow 10 or more
npm test -- --quick                  # the same without the generated server days and the attack, for a short check
npm run ai:eval                      # exit 0, in seconds; replays the recorded model answers: verdict accuracy 21/21
npm run attack                       # exit 0, in a minute or two; its own zero-key server, one table, ends "Every attempt moved exactly what the shared money rules say."
npm run demo -- --smoke              # starts server, web and ops, checks each, stops; exit 0
npm run numbers -- --check           # exit 0: README's numbers agree with docs/evidence/ and the fixtures
```

Every claim README and the Devpost text make is in [claims.md](claims.md) with its proof, its log and VERIFIED or UNVERIFIED; [prior-art.md](prior-art.md) compares the nearest work. README states nothing UNVERIFIED.

Run `doctor` while the demo is stopped: it counts the demo's own ports as busy (exit 1, `"demoRunning": true`, and advice that repeats your port flags). Where keys come from: PayPal and AG keys from this repo's `.secrets/`, the folder `HMS_SECRETS_DIR` names, or variables you set; AI keys also from the dotenv files `HMS_AI_KEY_FILES` lists (in the environment or the git-ignored `server/.env.local`). `npm test`, `npm run ai:eval` (without `--live`) and `npm run attack` ignore every key, and the demo without `--ai live` calls no model. Then drive the scripted day over the API:

```sh
mkdir -p .run && npm run demo > .run/demo.out 2>&1 &
until curl -sf http://127.0.0.1:8796/api/health; do sleep 1; done
# {"ok":true,"mode":"fake","contractVersion":"1.0.0","uptimeMs":...}
curl -s -X POST http://127.0.0.1:8796/api/demo/start -H 'content-type: application/json' -d '{"scriptId":"hero","speed":600}'
until curl -s http://127.0.0.1:8796/api/demo/state | grep -q '"finished"'; do sleep 1; done   # about 10 s
for who in mia wei; do curl -s -H "X-HMS-User: $who" 'http://127.0.0.1:8796/api/ledger?mine=1' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).entries.map(e=>e.kind+' '+e.amount.cents+' '+e.status).join(', ')))"; done
# released 544 succeeded, captured 957 succeeded, captured 4869 succeeded, held 6370 succeeded
# paid_out 4275 succeeded, paid_out 1080 succeeded
# (captures include processing and payouts at cost: PayPal's fees, $3.51 in all, docs/DECISIONS.md D-105)
(cd ops && OUT_DIR=../.run/ops-shots npm run shots && npm run licence:check)   # sponsor screens; needs Playwright's Chromium
# other ports: (cd ops && export BASE_URL=http://127.0.0.1:<ops port> && OUT_DIR=../.run/ops-shots npm run shots && npm run licence:check)
# three "saved .../.run/ops-shots/ops-0N-....png" lines (the Bryntum board, the AG Studio dashboard after the agent's
# answer, the board after approvals), then: Drawn by AG Studio: 3 grid(s), 3 chart(s); market desk agent answered
npm run demo -- --stop               # stops only what the launcher started
```

- Ports: server 8796, web 5190 (`/?demo=1`), ops 5197. `--port-offset N` or `--server-port`, `--web-port`, `--ops-port`; pass the same flags to `--stop`, `doctor`, `errand` and `paypal:check`, and export `BASE_URL=http://127.0.0.1:<ops port>` for the two sponsor checks (exported, so both commands get it).
- Driving the phone app with Playwright: wait for `load` plus a map label such as `[aria-label^="Mochi Bunny plush:"]`, never `networkidle` (the event stream and the map tiles never settle). On macOS launch Chromium with `--use-angle=metal --enable-gpu --ignore-gpu-blocklist`, as the repo's scripts do; in software rendering one 390x844 screenshot can take tens of seconds.
- Your own photos in the zero-key demo: the queuer's check-in and proof cards ask how the rules-only reader reads them (`?fixture=` on the upload; the result says "Simulated reading, no AI"); an API upload with no `fixture`, no recording and no model goes to ops review (D-128).
- The sponsor checks open the ops console's in-browser replay (`?backend=mock`) in headless Chromium (`npx playwright@1.56.1 install chromium`), so the server's state does not matter. Without an AG key `licence:check` ends "Verdict: not fully licensed"; it still exits 0 when the agent answered.
- `npm run ai:eval` without a key ends its summary with "Answers: 21 replayed from recorded muse/muse-spark-1.3 answers. No model was called in this run."; each photo's line ends with the stamp of the answer it replayed, `muse/muse-spark-1.3/replay`. The photos are synthetic.
- `npm run attack` (`scripts/attack.mjs`, D-137 to D-139, D-147 to D-149, D-151, D-152) starts a server on a free port with an empty secrets folder, sends six fake receipts from `server/fixtures/proofs` (each on a fresh demo market, Rex checking in with his rendered line photo), tries the money tricks over the HTTP API on two more markets (a local errand whose handover code it guesses for two hours, then Mia's errand, where one queuer's sell-out report alone must not close the book), runs one more market (the known limit, a fee clock run from home, and Mia's receipt reprinted at her cap from `server/fixtures/proofs/_reprint-at-cap`, which the listed-price check sends to a person), then makes three calls straight at the PayPal emulator. It prints one table (attempt, the layer the answer came from, money moved) and exits 1 when an attempt moves anything but what the shared money rules say, or an attempt that must be refused is not. `--reuse` attacks a running `npm run demo` instead (same port flags; it resets that market before each part and refuses a sandbox or live-AI server), `--only receipts,money,paypal` runs some parts, `--json <file>` writes the report, `--ci` drops colour and progress. `server/test/attack.test.ts` runs it inside `npm test` and fails when README's sample table (between the `attack-table` markers) differs from a fresh run.
- `POST /api/demo/reset` with `{"scriptId":"hero"}` returns to 10:30. `GET /api/config` shows the PayPal mode, the AI provider and the clock. Every endpoint: [docs/API.md](docs/API.md).
- Logs: `.run/logs/`. Process records: `.run/dev-<port>.json`. `npm run demo -- --dry-run` shows the settings without starting anything.
- Optional, with keys: `npm run keys -- --from-env` (variables in `npm run keys -- --help`; an OpenAI-compatible endpoint also needs `HMS_AI_PROVIDER=openai`, `HMS_AI_BASE_URL` and `HMS_AI_MODEL`), then `npm run dev:sandbox` or `npm run demo -- --ai live`. `HMS_MODE=sandbox` without its settings refuses to start and names what is missing (D-108). Approving a PayPal hold needs a person, in PayPal's window (or its overlay when pop-ups are blocked). After that, `npm run errand` plays the queuer's side over the API with no stored password and `npm run paypal:check -- --bid <id>` reads the result back from PayPal with GET calls only (D-129); `npm run gates -- lifecycle --by-hand` runs the whole errand with you approving PayPal's link, and `-- lifecycle --local` the local pickup errand (one capture at the handover code, D-156).
- What is not built or not proven yet: README, [Known limits](README.md#known-limits).

## Rules for changes

- **English only** in every file in the repo.
- **No secrets in the repo, logs or output.** Keys live in `.secrets/` (written by `npm run keys`, git-ignored, files mode 600), in the folder `HMS_SECRETS_DIR` names, or in git-ignored `.env.local` files; no script or app reads a folder outside the repo by default (D-131). Print names and "set or missing", never values. `npm run demo -- --no-ag-licence` forces AG's trial mode on a machine that has an AG key.
- **Code decides money.** Amounts are integer cents. Every capture carries its processing at cost (`grossUpCapture`, D-105), and HoldMySpot keeps only 10% of the queue fee. The money, matching, fee-clock and photo rules live in `shared/src/` and are imported by the server and both apps. The model reads prices; code checks them (the lines add up, the receipt QR's total matches the print, the price is at or under the cap and the item's listed price) and computes every amount from them. A provider error sends a proof to review, never to a pass.
- **PayPal goes through one port** (`PayPalPort` in `shared/src/ports.ts`). The sandbox adapter refuses any host other than `api-m.sandbox.paypal.com`. Fake mode is the same REST client on `server/src/paypal/emulator.ts`, which must keep matching the recorded sandbox answers (`server/test/paypal/sandbox-parity.test.ts`).
- **Keep the committed evidence.** The `npm run gates` commands rewrite `docs/SANDBOX-GATES.md`, and the ones that call PayPal also save its answers under `server/test/paypal/fixtures/recorded/`; add `--out .run/gates.md --no-record` unless you mean to replace them. `npm run gates -- run --fake` needs no keys and writes to a temporary file.
- **Recorded AI answers** in `server/fixtures/ai/` match the rendered photos in `server/fixtures/proofs/` by hash. Changing a photo or a prompt needs a new recording (`npm run ai:eval -- --record`, which calls the model 21 times).
- **The contract** (`shared/src/contract.ts`) changes only together with a new row in `docs/DECISIONS.md`.
- **Stop only what you started**: `npm run demo -- --stop` with the same port flags, or the process ids you own. Never stop processes by name.
- **Keep `npm test` green**; `npm test -- --build` adds the web and ops production builds, and `npm test -- --quick` (for a short check while you work) leaves out the generated server days and the attack, which the full run and CI keep.
- **README's numbers come from logs, not typing** (D-143). `npm run numbers` rewrites the generated blocks between `<!-- numbers:NAME:start -->` markers and checks the numbers README states in its own words; after adding tests or changing a scripted outcome, run `npm run numbers -- --record` (no keys), which re-runs `npm test`, `ai:eval`, `attack` and the smoke check and saves their reports in `docs/evidence/`, each with the commit and the git tree of each code folder it ran on (claims.md's logs table). Record from a committed tree on an idle machine when the logs are evidence: a run on uncommitted files says so in its log. A claim you add to README needs a row in `claims.md` with its proof; if nothing proves it yet, it stays out of README.
- Only `proto-shots/v2/final/` (the zero-key build) and `proto-shots/v3/final/` (one hero errand on the real PayPal sandbox through the web app, made by `web/scripts/sandbox-walk.mjs`, D-121) are tracked among the screenshot folders.

## Where to look

- Rules and money: [docs/DOMAIN.md](docs/DOMAIN.md), `shared/src/money.ts`, `shared/src/matching.ts`, `shared/src/stepdown.ts`, `shared/src/proofs.ts`
- PayPal: [docs/PAYPAL-MAPPING.md](docs/PAYPAL-MAPPING.md), `server/src/paypal/`, `server/src/app/money.ts`, `web/src/services/payments/`
- AI: [docs/AI-SERVICES.md](docs/AI-SERVICES.md), `server/src/ai/`
- System, environment variables and ports: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Ops console (AG Studio, Bryntum): [ops/README.md](ops/README.md)
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
