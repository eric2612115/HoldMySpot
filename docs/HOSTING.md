# Hosting the judge site on Render

The judge site runs at https://holdmyspot-k4a4.onrender.com (Render, plan `1c-2g`, deployed from this repository's `render.yaml`). One Node process on one port serves the phone app, the ops console under `/ops/`, and `/api/*` (D-163). Every visitor automatically gets a whole market of their own: no sign-up, no shared state.

**There is no external database.** Each market is an in-memory SQLite database inside the process, one per visitor, with its own folder of uploaded photos. That is why nothing needs a backup or a migration and why visitors cannot collide. It also means a restart or a new deploy clears every market; a visitor reloads the page and gets a fresh one. Nothing here is meant to be kept.

## Deploy on Render

1. In Render: **New > Blueprint**, pick this repository, branch `main`. Render reads `render.yaml` and offers one web service, `holdmyspot`.
2. Render asks for the values below. Paste them; leave blank anything you do not want (each one only switches a feature off).
3. **Apply**. The first build takes a few minutes. Open the service's URL: the judge's page should show two phones.
4. Check `https://<your-service>.onrender.com/api/health` answers `"ok":true`, then give that URL to Devpost. Put the sandbox buyer login in Devpost's private notes, never in the repo.

| Variable | Needed for | Where it comes from |
|---|---|---|
| `VITE_AG_STUDIO_LICENSE_KEY` | Licenses AG Studio in the ops console (without it AG's trial mode runs every feature). Read at build time, so a change needs a rebuild. Valid until 12-22; judging ends 12-15. | the contents of `agstudio-license.txt` |
| `MODEL_API_KEY` | A real model read of a visitor's own photo, and the two ops agents and the requester's bidding agent thinking live. Never sent to the browser. | Meta's Muse Spark key |
| `PAYPAL_ENV` | The "Use the real PayPal sandbox" choice | the word `sandbox` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_EMAIL`, `PAYPAL_MERCHANT_ID`, `PAYPAL_BUYER_EMAIL`, `PAYPAL_PAYOUT_EMAIL` | the same | your sandbox app, as in `sandbox.env` |

The site works with none of them: simulated PayPal, recorded AI answers, simulated readings, exactly like the zero-key demo.

## The plan, and why

`render.yaml` sets plan `1c-2g` (1 CPU, 2 GB). Measured with `node --expose-gc server/scripts/hosted-memory.ts 40` (macOS, Node 24.22, [log](evidence/hosted-memory-20261109.txt)):

| | RSS |
|---|---|
| The process with no markets | 133 MB |
| 40 fresh markets | 440 MB (about 7.7 MB each) |
| The same 40 after each ran the whole hero day | 524 MB (about 9.8 MB each) |

A market builds in about 0.6 s (620 ms on average over the 40), and 40 idle markets use 0.3% of one CPU, because a paused market's timers sleep until its next request.

**The cap is 40 markets** (`HMS_HOSTED_MARKET_CAP`), about 530 MB, which leaves room for uploads, compression of the page bundles and Linux differing from macOS. The memory allows more; 40 serves a judging panel, and a new visitor at the cap displaces the market idle the longest.

The plan also gives the build (web and ops together, near 1 GB at its peak) room to run, and an always-on instance answers a judge's first visit at once.

## Settings, all in `server/src/hosted/settings.ts`

| Setting | Default |
|---|---|
| `HMS_HOSTED_IDLE_MINUTES`: a market with no API call for this long is removed (an open event stream does not count) | 60 |
| `HMS_HOSTED_MAX_AGE_MINUTES`: removed this long after it was built, however busy | 240 |
| `HMS_HOSTED_MARKET_CAP`: markets alive at once; the longest idle goes first | 40 |
| `HMS_HOSTED_MIN_IDLE_SECONDS`: a market idle for less than this is never displaced; the new visitor is asked to retry | 120 |
| `HMS_HOSTED_CREATES_PER_IP_HOUR`, `HMS_HOSTED_CREATES_PER_MINUTE`: new markets | 30, 30 |
| `HMS_HOSTED_SANDBOX_PER_DAY`: markets on the real PayPal sandbox (UTC day) | 20 |
| `HMS_HOSTED_AI_READS_PER_MARKET`, `HMS_HOSTED_AI_READS_PER_DAY`: real model reads of visitors' photos | 6, 200 |
| `HMS_HOSTED_AI_TURNS_PER_MARKET`, `HMS_HOSTED_AI_TURNS_PER_DAY`: agent turns, shared by the two ops agents and the bidding agent | 40, 1200 |

Past an AI cap the phone offers simulated readings again, the ops agents use their offline planner and the bidding agent its written rules, and each says why.

## What a judge can run on the page

Every scene plays in the visitor's own market; **Start over** returns to the hero errand.

| Scene | How to reach it | What it shows |
|---|---|---|
| The hero errand | Steps **1 Hold on Mia's phone**, **2 Run the whole errand**, **3 Try to break it** | Held \$63.70, charged \$58.26, released \$5.44, Wei paid \$53.55; a receipt that fails the checks moves \$0. |
| The sample line photo | On Wei's phone: **Mochi Bunny plush**, **Take this task**, **Use the sample line photo**, **Check in with this photo** | The photo already carries the visit's stamp (`M4RT7 · 10:50 · Paper Moon Toys`), so the app sends it as it is and its recorded Muse Spark answer reads it: "Line photo: passed", about 32 people ahead. The same button is on the check-in card at `http://127.0.0.1:5190/?demo=1` in `npm run demo`. |
| Shortcake errand in New York | **More scenes** | Jun's and Dana's phones in New York: Jun holds \$51.54, one capture of \$49.47 at the handover code, \$2.07 released, Dana paid \$46.10. |
| Sold out at Paper Moon Toys | **More scenes** | Mia's and Wei's phones: Wei and Rex check in and both report the Mochi Bunny plush sold out (two independent reports close the book, D-152). All 13 holds on the plush are released and \$0 is captured from anyone; Mia's phone reads Released and Wei's "Sold out: holds released". |
| The live bidding agent | On Mia's phone: **Mochi Bunny plush**, tick **Let AI adjust my fee**, hold | With `MODEL_API_KEY` set, each run asks Muse Spark live and the log's rows read "Decided by AI · muse muse-spark-1.3 (live)"; the server still checks every fee against the hold. Runs count against the agent turns above. |
| PayPal's own ids in AG Studio | After **Let Wei run the errand** on the real sandbox, open the ops console's **Market** page | The AG Studio ledger grid lists that run's PayPal ids: the authorization, both captures and both payouts. |

`web/scripts/hosted-walk.mjs` plays each of these (except the live model and the real sandbox, which need keys) and checks the numbers above.

## Try it locally first

```sh
npm run hosted -- --port-offset 700      # builds if needed; http://127.0.0.1:9496/
BASE_URL=http://127.0.0.1:9496 node web/scripts/hosted-walk.mjs   # the browser walk; screenshots in .run/hosted/
```

With keys in `.secrets/` (or the folder `HMS_SECRETS_DIR` names), the build carries the AG Studio key and the page offers the real sandbox. `HOST_ALIAS=judge.holdmyspot.test` on the walk shows the site under a host name other than localhost, as judges see it.

## The real PayPal sandbox choice

With the PayPal variables set, the judge's page offers "Use the real PayPal sandbox", and the whole errand runs on PayPal's sandbox:

1. **Choose the sandbox.** The page builds a market whose PayPal is the real sandbox client (up to `HMS_HOSTED_SANDBOX_PER_DAY` markets a day, 20 by default).
2. **Approve the hold.** Mia's $63.70 hold opens in PayPal's own window; the judge signs in with the sandbox buyer login from the Devpost testing instructions (the page says so under the button) and approves it. PayPal authorizes the hold and nothing is charged.
3. **Let Wei run the errand.** The server plays Wei's side over the market's own routes, with the same code as `npm run errand` (`server/src/hosted/sandboxErrand.ts`): claim, check-in with his line photo, the receipt, tracking and shipping. PayPal captures the receipt and then the shipping, the final capture releases the rest, and Payouts pays Wei.
4. **Read PayPal's ids.** The page lists each step and every money line with PayPal's id as it lands: the hold's authorization, both captures and both payout batches. The ops console's **Market** page shows the same ids in the AG Studio ledger.

This path ran end to end on PayPal's sandbox on 2026-11-09 (`npm run hosted` with the nine variables): order `5PY04562NA309360X` held \$63.70, captured \$48.69 and \$9.57, released \$5.44 and paid out \$10.80 and \$42.75, every id read back from PayPal ([log](evidence/hosted-sandbox-run-20261109.txt)).

To run it on your machine with your own sandbox keys (saved by `npm run keys` in `.secrets/`, or in the folder `HMS_SECRETS_DIR` names): `npm run hosted -- --port-offset 701`, open `http://127.0.0.1:9497/`, choose the sandbox, approve the hold in PayPal's window and press "Let Wei run the errand".

## For an AI reviewer

```sh
BASE=http://127.0.0.1:8796   # npm run hosted; or the hosted site's URL
TOKEN=$(curl -s -X POST "$BASE/api/demo/session" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -X POST "$BASE/api/demo/start" -H "X-HMS-Market: $TOKEN" -H 'content-type: application/json' -d '{"scriptId":"hero","speed":600}'
until curl -s "$BASE/api/demo/state" -H "X-HMS-Market: $TOKEN" | grep -q '"finished"'; do sleep 1; done
curl -s "$BASE/api/ledger?mine=1" -H "X-HMS-Market: $TOKEN" -H 'X-HMS-User: mia'
```

The two other scenes run the same way: `{"scriptId":"sold-out","speed":600}` (then every hold on the plush reads `released` in `GET /api/ops/records`, with \$0 captured), and `{"scriptId":"local-errand","speed":600}` (then `GET /api/ledger?mine=1` as `jun` shows one capture). `GET /api/hosted/info` gives the totals for the scene's two people.

Every route in [API.md](API.md) then acts on that token's market only. A market with no token answers `401 NO_MARKET`; one that was removed answers `410 MARKET_GONE`. Admin routes need no key: the only way into a market is its own token.
