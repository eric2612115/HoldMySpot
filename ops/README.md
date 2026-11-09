# HoldMySpot ops console

The operator console for HoldMySpot: a **queuer board** (Bryntum Scheduler) with a synced map and the **rescheduler**, an agent that proposes moves on the schedule, and a **market dashboard** (AG Studio) with custom widgets, AG Grid ledgers and the **market desk**, an agent on AG Studio's Agent Framework that works with Studio's own agents. Both agents think on the server's AI port when it has a live model and say so on screen; without a key they run on the rules and an offline planner, and say that too. The console reads the contract in `../shared` and follows the live server when it answers, else an in-browser replay of the hero day in San Francisco's Japantown.

## Run

From the repo root, `npm run setup` and `npm run demo` (Node 24) install and start this console together with the server and the web app; see the [root README](../README.md#run-it). To run the console alone:

```sh
npm install
npm run dev          # http://127.0.0.1:5197 (preview: 5198)
```

The console alone needs Node 22.18 or newer. `/api` is proxied to the server on `127.0.0.1:8796`; when it does not answer, the console uses the mock (`src/data/mock`). No key is needed; the optional AG keys are under [Licences](#licences).

URL switches (all optional):

| Switch | Effect |
|---|---|
| `#/board`, `#/market` | Queuer board (default) or market dashboard |
| `?backend=mock` / `server` | Force the mock or the server (default `auto`) |
| `?at=11:21` | Market time on the hero day, San Francisco (default 11:21) |
| `?approve=all` (or `jo`, `noor`) | Start with the rescheduler's proposals approved (the rules' pick) |
| `?agents=model` / `offline` | Where the agents think. Default: the server's AI port on the live server when it runs a live model, offline on the replay; `model` lets the replay use the server's model too (D-103) |
| `?words=market` | Screen words bid, ask, spread instead of request, offer, gap (D-37) |

The play button runs the market clock 60 times faster; the moment buttons jump to the day's key moments.

## Check

```sh
npm test             # node:test: the hero money (hold $63.70, captures $48.69 and $9.57 with processing at cost,
                     # $5.44 released, payouts $10.80 and $42.75), Rex's $0, the rescheduler's options and dry runs
                     # (reassign, shift the window, release), the desk's facts (holds, captures, fill rates, step-downs,
                     # disputes), the widest gap at 12:05
npm run typecheck
npm run build
npm run shots        # with the dev server running: PNGs at 1440x900 into ../proto-shots/v2/final (ops-*)
npm run shots:live   # with `npm run demo` in ../server and the dev server running: starts the hero script on the
                     # server, pauses it at five moments and takes the board and the dashboard into ../proto-shots/v2/live
                     # (kept out of git); the run ends at 14:01, where the server's market holds still
npm run licence:check  # with the dev server running: which AG key each product got, what AG makes of it
                       # (never the key), any licence banner or watermark; see Licences
```

`OPS_HMR=off npm run dev` serves without hot updates, so a page open for screenshots is never reloaded by an edit. The server half of the agents is tested in `../server/test/opsAgents.test.ts` (a stand-in model, no network).

**Live server.** When `GET /api/health` answers with the same contract version (or with `?backend=server`), the console reads `GET /api/ops/records` every 1.5 seconds and draws it with the same functions as the replay (`src/data/serverWorld.ts`), using the server's own book snapshots; the rescheduler runs on those records too. The clock shows the server's market time ("live server"), and the play button pauses and resumes a demo run (`POST /api/demo/pause|resume`). Approvals and drags go to `POST /api/ops/moves`, where the server checks each move again (D-102).

**With a model.** Start the server with a key and a live AI mode, for example `npm run demo -- --ai live` from the repo root (Muse Spark through `HMS_AI_KEY_FILES=<file>#MODEL_API_KEY`, Anthropic, or the OpenAI-compatible provider: whatever the server's AI config picks). The top bar then reads "Agents: <model>"; each agent turn is `POST /api/ops/agents/turn` and the key never reaches the browser.

## What is on screen

**Queuer board** (`src/board`). One row per San Francisco queuer. Bars: on the way (arrival window), in line, the fee clock drawn as a staircase with the price at each step, and one job per requester with its money state (Held, Captured, failed with the reason). A market-clock line runs over the time axis; shop openings sit in their own lane above it (shops that open at the same minute share one label). The map (MapLibre, OpenFreeMap tiles, English labels) follows the selected queuer and shop, with the walk and the geofence.

- **Drag a job** to another queuer to move it, on the replay and on the live server: the drop is checked with the shared matching rules (same book, room left, compatible, that queuer's fee now at or under the request's max fee), a refused drop says why, and the job runs at that fee.
- **The rescheduler** (`src/agents/rescheduler.ts`, D-101) finds a queuer who cannot reach the shop before the window closes (the demo walk) or whose ETA passed without a check-in, and jobs on a PayPal hold that can no longer pay (Noor's Venmo hold past its honor period). For each problem the rules build every move they allow: **reassign** to another queuer's offer, **shift the window** of the late queuer, **release** him so the rules re-offer the job, or **free** a queuer's units from the hold that cannot pay. Each is dry-run on a copy of the market and drawn as ghost bars; hover an option on the card to draw its dry run instead. A model on the server's AI port picks one option per problem and writes the reason ("Agent pick"); without one, the rules' pick shows ("Rules pick", "Rules only" on the strip). **Approve** applies the option you have selected: on the replay at once, on the live server through `POST /api/ops/moves`. If nobody approves, the rules act on their own later (the claim lapses at the window end; the capture fails after purchase).

**Needs a person** (`src/people`, `#/people`, D-160). One AG Grid (Community modules only, so no licence or watermark without keys) with one row per case the AI and the rules could not settle: a receipt to review, a refund, a dispute. See [docs/NEEDS-A-PERSON.md](../docs/NEEDS-A-PERSON.md).

**Market dashboard** (`src/market`). AG Studio over the eight contract datasets plus a shops table every dataset joins to, so a click on a shop or a page filter on `shops.shop` narrows the whole page. The first screen holds the PayPal money tiles, the gap board, the desk's answer slot, the **PayPal ledger** (an AG Grid grid: time, kind and status pills, amount, PayPal id) and the **holds by city and shop** (a pivot table grouped by city and shop with subtotals and a pinned total); charts and a **payouts** grid with a pinned total follow. Custom widgets: the gap board, the depth ladder, and the spotlight the desk builds. Theme: the app palette in Studio's and the grids' theme params, Fredoka titles, mint canvas; field names replace Studio's "(sum)" labels.

- **The market desk** (`src/market/agent`, D-100, D-130) is our own agent in Studio's Agent Framework, in a harness we build with `createAiHarness`. With a model it is a `directLlmRunner` whose LLM adapter is our server (`serverAdapter.ts`): Studio runs the loop and every tool on the page, the server's AI port answers each turn. It takes free questions about holds, captures, payouts, fill rates, step-downs and disputes; reads the market with our `read_market` tool (every number comes from the snapshot the page draws); changes the page with Studio's `add_widget`, `remove_widget`, `position_widget` and `view_page`, and with tools of ours that run Studio's own: `add_gap_spotlight` (remove, add and configure the spotlight in the free slot), `add_breakdown` (a table or bar chart of captures, releases, payouts, holds or queue fees by shop, city, queuer or requester, from exact fields, widget filters and aggregations, returning the figures it shows), `check_widget` (reads any widget's mapping and filters back and computes what it shows from the same rows, with warnings for a count drawn in dollars or an average over requests) and `filter_shop` (Studio's page filter tools); and hands work to three of Studio's built-in agents with `delegate_to`: **Widget** (configures a chart or table), **Page** (layout and filters) and **Data** (queries any table), all on the same adapter, each told the market day and capped at 8, 6 and 6 turns, with 30 s per turn on the server. Studio's AI panel shows each step in plain words with the tool's name at the end of the row; Studio's `@field[...]` references in a delegate's summary are shown as plain names.
- **Without a model** the desk is a `clientToolRunner` on the offline planner (`planner.ts`): fixed topics by keywords (the same ones, plus the gap and depth widgets, "only <shop>" and "Top earner"), the same tools, and the panel title, the strip above Studio and the top bar say "offline". A question that spans topics gets the first topic's answer and names the others to ask next.

## Licences

- **Bryntum**: `@bryntum/scheduler-community` and `@bryntum/scheduler-react-community` 8.0 (MIT), from the public npm registry. No key.
- **AG Studio, AG Grid and AG Charts** install from npm and run with no key in AG's trial mode, which unlocks every feature, the AI panel and the market desk agent included. In trial mode AG Studio logs a licence notice in the browser console and, on a host other than `localhost` or `127.0.0.1`, shows a trial watermark. A licence key removes both.
- **Which key goes where** (D-82, D-83):

  | Key | Licenses | The key itself in | Or a file holding it, named by | Default file |
  |---|---|---|---|---|
  | **AG Studio, Pro with AI** (`[03C]`): the one key this console needs | AG Studio, which draws every grid and chart here (the ledger, the holds pivot, the payouts grid, the charts, any table in the AI panel) | `VITE_AG_STUDIO_LICENSE_KEY` | `HMS_AG_STUDIO_LICENSE_FILE` | `agstudio-license.txt` in the secrets folder |
  | AG Grid and AG Charts Enterprise: optional | a grid or chart drawn outside AG Studio | `VITE_AG_LICENSE_KEY` | `HMS_AG_LICENSE_FILE` | `aggrid-license.txt` in the secrets folder |

  The console registers AG Studio's AI module, so its key is Pro with AI. Each key goes to its own product: the AG Studio key to AG Studio, the AG Grid key to standalone AG Grid and AG Charts. A key placed in the other row still reaches its product (the tag `[03A]`, `[03B]` or `[03C]` marks an AG Studio key). A trial key from AG works the same as a bought one.
- **Where keys are read.** The secrets folder is the repo's git-ignored `.secrets/` (written by `npm run keys`), or the folder `HMS_SECRETS_DIR` names; no folder outside the repo is read otherwise (D-131). Set the keys in the git-ignored `ops/.env.local` (see `.env.example`) or in the shell, or point a file variable at a key file outside the repo (`HMS_AG_STUDIO_LICENSE_FILE=/path/to/agstudio-license.txt npm run demo`: no copy in the repo); a key file holds the key alone. `vite.config.ts` reads the keys when `npm run dev` or `npm run build` starts (restart after a change), never prints them and logs only the source, for example `[ops] AG Studio licence: from HMS_AG_STUDIO_LICENSE_FILE (value not shown)`; `npm run demo -- --dry-run` and the launcher's banner name the source too. The launcher's `--no-ag-licence` (`HMS_AG_TRIAL=1`) ignores every key, to show trial mode on a machine that has one. A build carries the keys in the git-ignored `dist/`, like any browser licence key.
- **Check**: with the dev server running, `npm run licence:check` prints which key each product got, what AG Studio's and AG Grid's licence managers report (never the key), the grids and charts drawn and a verdict (`-- --strict` exits 1 unless fully licensed). To see the console as a deployed host shows it, start the dev server with `OPS_ALLOWED_HOSTS=ops.holdmyspot.test` and run the check with `HOST_ALIAS=ops.holdmyspot.test` (Chromium maps the name to 127.0.0.1; no hosts file change).
- **Map tiles**: OpenFreeMap with OpenStreetMap data (attribution shown on the map).

## Contract notes

- Dataset rows: built once by `opsDatasets` in `shared/src/opsviews.ts`, for this console (replay and live) and for the server's `GET /api/ops/datasets/:name`: money in US dollars in fields ending in `Usd`, times as epoch ms in `at` and fields ending in `At`, `shopId` on every table that has a shop.
- The console's ledger rows add `paypalObject`, `paypalId` and `events` (1 per row) to the shared ledger dataset, from each entry's PayPal ids (`src/data/mock/views.ts`).
- `POST /api/ops/moves` applies the rescheduler's moves and drags on the server (reassign, extend, release, release_job), each checked again with the market rules; `POST /api/ops/agents/turn` is one agent turn on the server's AI port, live models only (D-100 to D-103, docs/API.md).
- On the live server the rescheduler shows a problem when the records have one (its server path is tested in `server/test/opsAgents.test.ts`); the hero replay at 11:21 shows both kinds.
- Queuer positions on the map come from the same walk model in both modes, computed from the records.
