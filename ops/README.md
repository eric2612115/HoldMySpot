# HoldMySpot ops console

The operator console for HoldMySpot: a **queuer board** (Bryntum Scheduler) with a synced map and a rescheduling agent, and a **market dashboard** (AG Studio) with custom widgets and its own agent. It reads the contract in `../shared` and follows the live server when it answers, else an in-browser replay of the hero day in San Francisco's Japantown.

## Run

```sh
npm install
npm run dev          # http://127.0.0.1:5197 (preview: 5198)
```

Node 22.18 or newer. `/api` is proxied to the server on `127.0.0.1:8796`; when it does not answer, the console uses the mock (`src/data/mock`).

URL switches (all optional):

| Switch | Effect |
|---|---|
| `#/board`, `#/market` | Queuer board (default) or market dashboard |
| `?backend=mock` / `server` | Force the mock or the server (default `auto`) |
| `?at=11:21` | Market time on the hero day, San Francisco (default 11:21) |
| `?approve=all` (or `jo`, `noor`) | Start with the rescheduler's proposals approved |
| `?words=market` | Screen words bid, ask, spread instead of request, offer, gap (D-37) |

The play button runs the market clock 60 times faster; the moment buttons jump to scenes worth filming.

## Check

```sh
npm test             # node:test: the hero money (hold $60.00, captures $46.00 and $8.75, $5.25 released,
                     # payouts $10.80 and $42.75), Rex's $0, the rescheduler's dry runs, the widest gap at 12:05
npm run typecheck
npm run build
npm run shots        # with the dev server running: PNGs at 1440x900 into ../proto-shots/v2/final (ops-*)
npm run shots:live   # with `npm run demo` in ../server and the dev server running: starts the hero script on the
                     # server, pauses it at five moments and takes the board and the dashboard into ../proto-shots/v2/live
                     # (kept out of git); the run ends at 14:01, where the server's market holds still
```

**Live server.** When `GET /api/health` answers with the same contract version (or with `?backend=server`), the console reads `GET /api/ops/records` every 1.5 seconds and draws it with the same functions as the replay (`src/data/serverWorld.ts`), using the server's own book snapshots. The clock shows the server's market time ("live server"), and the play button pauses and resumes a demo run (`POST /api/demo/pause|resume`).

## What is on screen

**Queuer board** (`src/board`). One row per San Francisco queuer. Bars: on the way (arrival window), in line, the fee clock drawn as a staircase with the price at each step, and one job per requester with its money state (Held, Captured, failed with the reason). A market-clock line runs over the time axis; shop openings sit in their own lane above it (shops that open at the same minute share one label). Drag a job to another queuer to move it: the drop is checked with the shared matching rules (same book, room left, compatible, offer price at or under the request's max fee) and the job runs at that offer's current fee. The map (MapLibre, OpenFreeMap tiles, English labels) follows the selected queuer and shop, with the walk and the geofence. The **rescheduler** watches for a queuer who cannot reach the shop before the window closes and for a hold that can no longer pay (Noor's Venmo hold past its honor period); each proposal shows ghost bars from a dry run of the same rules and waits for an operator's approval. If nobody approves, the rules act on their own later (the claim lapses at the window end; the capture fails after purchase).

**Market dashboard** (`src/market`). AG Studio over the eight contract datasets plus a shops table every dataset joins to, so a click on a shop cross-filters the page. Custom widgets: the gap board (top request, lowest offer and the gap per shop), the depth ladder, and the spotlight the agent builds. Theme: the app palette, Fredoka titles, mint canvas. The **market desk** is a custom agent in Studio's Agent Framework (`clientToolRunner`): it calls our `read_market` tool, then Studio's own `remove_widget`, `add_widget` and `configure_widget` tools to build its answer on the canvas, and replies in plain sentences. In fake mode its turns come from a deterministic planner (no model key); Studio still runs every tool call and shows each step.

## Licences

- Bryntum: `@bryntum/scheduler-community` 8.0 (MIT): no key, no trial badge. Time ranges and other Business features are drawn by the console itself.
- AG licence: `vite.config.ts` reads the key at dev-server or build time from `VITE_AG_LICENSE_KEY` in the git-ignored `ops/.env.local`, else from the owner's key file (`HMS_AG_LICENSE_FILE`, default `~/.config/paypal-hackathon/aggrid-license.txt`, mode 600). It never prints the key ("AG licence: loaded from the key file (value not shown)"); `src/licenses.ts` hands it to AG Grid and AG Charts Enterprise and to AG Studio's provider. The owner's key is an Enterprise Bundle trial (AG Grid and AG Charts, until 2026-12-06): checked on a non-localhost name (11-07), it removes the AG Grid and AG Charts watermarks and console banners, but AG Studio still shows its own watermark ("Invalid License", fading after a few seconds) and a console banner, because the key does not cover AG Studio. Every watermark is hidden on localhost and 127.0.0.1 anyway.
- AG Studio 3.1 itself needs an AG Studio key (Core, Pro or Pro with AI) to drop its watermark on a deployed host.
- Map tiles: OpenFreeMap with OpenStreetMap data (attribution shown on the map).

## Contract notes

- Dataset rows: built once by `opsDatasets` in `shared/src/opsviews.ts`, for this console (replay and live) and for the server's `GET /api/ops/datasets/:name`: money in US dollars in fields ending in `Usd`, times as epoch ms in `at` and fields ending in `At`, `shopId` on every table that has a shop.
- The contract has no route for ops to move a job or to apply a rescheduling proposal. With the live server the board shows the server's plan, the rescheduler panel stays empty, and dragging is refused with a message. A route such as `POST /api/ops/jobs/:jobId/reassign { askId }` would make both work against the server.
- Queuer positions on the map come from the same synthetic walk model in both modes (from the records); the server's `queuer.moved` events are not read yet.
