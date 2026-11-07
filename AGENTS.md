# AGENTS.md

Notes for AI coding agents working in this repo or checking it for a reviewer. People start with [README.md](README.md).

HoldMySpot has four npm packages without a workspace: `shared/` (contract and pure rules, TypeScript source), `server/` (Node 24, Fastify, `node:sqlite`), `web/` (the phone app) and `ops/` (the operator console). The root `package.json` only holds scripts, written with Node built-ins, so they run before anything is installed.

## Check the repo (no keys, no prompts)

Run from the repo root, in this order:

```sh
node --version                       # v24 or newer (.nvmrc)
npm run setup                        # npm ci in shared, server, web, ops; exit 0
npm run -s doctor -- --json          # pure JSON; exit 0 and "ok": true when the zero-key demo can start
npm test                             # exit 0, ends "All green: 6 steps in N s." (no network, no keys)
npm run ai:eval                      # exit 0, about a minute; replays the recorded model answers: verdict accuracy 21/21
npm run demo -- --smoke              # starts server, web and ops, checks each, stops; exit 0
```

Run `doctor` while the demo is stopped: it counts the demo's own ports as busy. Then drive the scripted day over the API:

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
# three "saved .../.run/ops-shots/ops-0N-....png" lines (the Bryntum board, the AG Studio dashboard after the agent's
# answer, the board after approvals), then: Drawn by AG Studio: 3 grid(s), 3 chart(s); market desk agent answered
npm run demo -- --stop               # stops only what the launcher started
```

- Ports: server 8796, web 5190 (`/?demo=1`), ops 5197. `--port-offset N` or `--server-port`, `--web-port`, `--ops-port`; pass the same flags to `--stop` and `doctor`, and set `BASE_URL=http://127.0.0.1:<ops port>` for the two sponsor checks.
- The sponsor checks open the ops console's in-browser replay (`?backend=mock`) in headless Chromium (`npx playwright@1.56.1 install chromium`), so the server's state does not matter. Without an AG key `licence:check` ends "Verdict: not fully licensed"; it still exits 0 when the agent answered.
- `npm run ai:eval` without a key ends its summary with "Answers: 21 replayed from recorded muse/muse-spark-1.3 answers. No model was called in this run."; each photo's line ends with the stamp of the answer it replayed, `muse/muse-spark-1.3/replay`. The photos are synthetic.
- `POST /api/demo/reset` with `{"scriptId":"hero"}` returns to 10:30. `GET /api/config` shows the PayPal mode, the AI provider and the clock. Every endpoint: [docs/API.md](docs/API.md).
- Logs: `.run/logs/`. Process records: `.run/dev-<port>.json`. `npm run demo -- --dry-run` shows the settings without starting anything.
- Optional, with keys: `npm run keys -- --from-env` (variables in `npm run keys -- --help`), then `npm run dev:sandbox` or `npm run demo -- --ai live`. `HMS_MODE=sandbox` without its settings refuses to start and names what is missing (D-108). Approving a PayPal hold needs a person, or the scripted `npm run gates -- lifecycle` described in the README.
- What is not built or not proven yet: README, [Known limits](README.md#known-limits).

## Rules for changes

- **English only** in every file in the repo.
- **No secrets in the repo, logs or output.** Keys live in `.secrets/` (written by `npm run keys`, git-ignored, files mode 600) or in git-ignored `.env.local` files. Print names and "set or missing", never values.
- **Code decides money.** Amounts are integer cents. Every capture carries its processing at cost (`grossUpCapture`, D-105), and HoldMySpot keeps only 10% of the queue fee. The money, matching, fee-clock and photo rules live in `shared/src/` and are imported by the server and both apps. A model never sets an amount; a provider error sends a proof to review, never to a pass.
- **PayPal goes through one port** (`PayPalPort` in `shared/src/ports.ts`). The sandbox adapter refuses any host other than `api-m.sandbox.paypal.com`. Fake mode is the same REST client on `server/src/paypal/emulator.ts`, which must keep matching the recorded sandbox answers (`server/test/paypal/sandbox-parity.test.ts`).
- **Keep the committed evidence.** The `npm run gates` commands rewrite `docs/SANDBOX-GATES.md`, and the ones that call PayPal also save its answers under `server/test/paypal/fixtures/recorded/`; add `--out .run/gates.md --no-record` unless you mean to replace them. `npm run gates -- run --fake` needs no keys and writes to a temporary file.
- **Recorded AI answers** in `server/fixtures/ai/` match the rendered photos in `server/fixtures/proofs/` by hash. Changing a photo or a prompt needs a new recording (`npm run ai:eval -- --record`, which calls the model 21 times).
- **The contract** (`shared/src/contract.ts`) changes only together with a new row in `docs/DECISIONS.md`.
- **Stop only what you started**: `npm run demo -- --stop` with the same port flags, or the process ids you own. Never stop processes by name.
- **Keep `npm test` green**; `npm test -- --build` adds the web and ops production builds.
- Only `proto-shots/v2/final/` is tracked among the screenshot folders.

## Where to look

- Rules and money: [docs/DOMAIN.md](docs/DOMAIN.md), `shared/src/money.ts`, `shared/src/matching.ts`, `shared/src/stepdown.ts`, `shared/src/proofs.ts`
- PayPal: [docs/PAYPAL-MAPPING.md](docs/PAYPAL-MAPPING.md), `server/src/paypal/`, `server/src/app/money.ts`, `web/src/services/payments/`
- AI: [docs/AI-SERVICES.md](docs/AI-SERVICES.md), `server/src/ai/`
- System, environment variables and ports: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Ops console (AG Studio, Bryntum): [ops/README.md](ops/README.md)
- Decisions: [docs/DECISIONS.md](docs/DECISIONS.md)
