# Hosting the judge site on Render

One Node process on one port serves the phone app, the ops console under `/ops/`, and `/api/*` (D-163). Every visitor automatically gets a whole market of their own: no sign-up, no shared state.

**There is no external database.** Each market is an in-memory SQLite database inside the process, one per visitor, with its own folder of uploaded photos. That is why nothing needs a backup or a migration and why visitors cannot collide. It also means a restart or a new deploy clears every market; a visitor reloads the page and gets a fresh one. Nothing here is meant to be kept.

## What the owner does

1. In Render: **New > Blueprint**, pick this repository, branch `main`. Render reads `render.yaml` and offers one web service, `holdmyspot`.
2. Render asks for the values below. Paste them; leave blank anything you do not want (each one only switches a feature off).
3. **Apply**. The first build takes a few minutes. Open the service's URL: the judge's page should show two phones.
4. Check `https://<your-service>.onrender.com/api/health` answers `"ok":true`, then give that URL to Devpost. Put the sandbox buyer login in Devpost's private notes, never in the repo.

| Variable | Needed for | Where it comes from |
|---|---|---|
| `VITE_AG_STUDIO_LICENSE_KEY` | The ops console with no AG Studio watermark. Read at build time, so a change needs a rebuild. Expires 12-22; judging ends 12-15. | the contents of `agstudio-license.txt` |
| `MODEL_API_KEY` | A real model read of a visitor's own photo, and the two ops agents thinking live. Never sent to the browser. | Meta's Muse Spark key |
| `PAYPAL_ENV` | The "Use the real PayPal sandbox" choice | the word `sandbox` |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_MERCHANT_EMAIL`, `PAYPAL_MERCHANT_ID`, `PAYPAL_BUYER_EMAIL`, `PAYPAL_PAYOUT_EMAIL` | the same | your sandbox app, as in `sandbox.env` |

The site works with none of them: simulated PayPal, recorded AI answers, simulated readings, exactly like the zero-key demo.

## The plan, and why

`render.yaml` sets plan `1c-2g` (1 CPU, 2 GB). Measured on this code with `node --expose-gc server/scripts/hosted-memory.ts 40` (macOS, Node 24.22):

| | RSS |
|---|---|
| The process with no markets | 130 MB |
| 40 fresh markets | 471 MB (about 8.5 MB each) |
| The same 40 after each ran the whole hero day | 512 MB (about 9.6 MB each) |

A market builds in about 0.5 s, and 40 idle markets use 0.3% of one CPU, because a paused market's timers sleep until its next request.

**The cap is 40 markets** (`HMS_HOSTED_MARKET_CAP`), about 530 MB, which leaves room for uploads, compression of the page bundles and Linux differing from macOS. The memory would allow more; a demo for a judging panel does not need more, and a new visitor at the cap only displaces the market idle the longest.

The smaller `0.5c-512mb` plan would hold about 25 markets with no headroom, and the build (web and ops together) peaked near 1 GB here, so it may not build there. The free plan sleeps when idle, so a judge's first visit would wait for it to wake.

Render's prices were not visible to this writer; check them against the credits.

## Limits, all in `server/src/hosted/settings.ts`

| Setting | Default |
|---|---|
| `HMS_HOSTED_IDLE_MINUTES`: a market with no API call for this long is removed (an open event stream does not count) | 60 |
| `HMS_HOSTED_MAX_AGE_MINUTES`: removed this long after it was built, however busy | 240 |
| `HMS_HOSTED_MARKET_CAP`: markets alive at once; the longest idle goes first | 40 |
| `HMS_HOSTED_MIN_IDLE_SECONDS`: a market idle for less than this is never displaced; the new visitor is asked to retry | 120 |
| `HMS_HOSTED_CREATES_PER_IP_HOUR`, `HMS_HOSTED_CREATES_PER_MINUTE`: new markets | 30, 30 |
| `HMS_HOSTED_SANDBOX_PER_DAY`: markets on the real PayPal sandbox (UTC day) | 20 |
| `HMS_HOSTED_AI_READS_PER_MARKET`, `HMS_HOSTED_AI_READS_PER_DAY`: real model reads of visitors' photos | 6, 200 |
| `HMS_HOSTED_AI_TURNS_PER_MARKET`, `HMS_HOSTED_AI_TURNS_PER_DAY`: ops agent turns | 40, 1200 |

Past an AI cap the phone offers simulated readings again and the ops agents use their offline planner, and each says why.

## Try it locally first

```sh
npm run hosted -- --port-offset 700      # builds if needed; http://127.0.0.1:9496/
BASE_URL=http://127.0.0.1:9496 node web/scripts/hosted-walk.mjs   # the browser walk; screenshots in .run/hosted/
```

Add `HMS_SECRETS_DIR=~/.config/paypal-hackathon` to build with the AG Studio key and offer the real sandbox. `HOST_ALIAS=judge.holdmyspot.test` on the walk shows the site under a name that is not localhost, where a licence watermark would be drawn.

## The real PayPal sandbox choice

With the PayPal variables set, the judge's page offers "Use the real PayPal sandbox". The judge approves the hold in PayPal's window with a sandbox buyer login you give privately in Devpost, then presses "Let Wei run the errand", and the page lists PayPal's ids. Capped at 20 markets a day.

Not yet proven end to end: its market, a real order and PayPal's window were checked, and Wei's errand has run on the emulator, but no full run has gone through PayPal's real sandbox on this path. Before giving the URL to judges, do it once yourself: start it with `HMS_SECRETS_DIR=~/.config/paypal-hackathon npm run hosted -- --port-offset 701`, approve the hold in PayPal's window, press the button, and confirm the ids appear.

## For an AI reviewer

```sh
TOKEN=$(curl -s -X POST "$BASE/api/demo/session" | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s -X POST "$BASE/api/demo/start" -H "X-HMS-Market: $TOKEN" -H 'content-type: application/json' -d '{"scriptId":"hero","speed":600}'
until curl -s "$BASE/api/demo/state" -H "X-HMS-Market: $TOKEN" | grep -q '"finished"'; do sleep 1; done
curl -s "$BASE/api/ledger?mine=1" -H "X-HMS-Market: $TOKEN" -H 'X-HMS-User: mia'
```

Every route in [API.md](API.md) then acts on that token's market only. A market with no token answers `401 NO_MARKET`; one that was removed answers `410 MARKET_GONE`. Admin routes need no key: the only way into a market is its own token.
