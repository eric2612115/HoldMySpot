# HoldMySpot web

The web client for HoldMySpot: a walking order book on the queue fee for the
lines people talk about (a viral bakery's limited cake, a one-per-customer plush
drop, a famous ramen line). Requests light up a soft 3D city map, each request is
a PayPal hold at a real place, and a queuer nearby offers to stand in line for a
fee that steps down after they check in.

It talks to the HoldMySpot server when it answers (fake PayPal mode on
127.0.0.1:8796, through the Vite proxy) and falls back to an in-browser market
otherwise. See [docs/WEB-INTEGRATION.md](../docs/WEB-INTEGRATION.md).

## Run it

```bash
npm install
npm run dev        # http://127.0.0.1:5190
```

| URL | What you get |
| --- | --- |
| `/` | The map, San Francisco (Japantown) |
| `/?city=nyc` | The map in New York (SoHo and the Lower East Side) |
| `/?view=overview` | Opens on the top-down overview |
| `/?backend=server` or `/?backend=mock` | Insist on the server, or skip it (default: the server when it answers) |
| `/?as=sam`, `/?queuer=lin` | The requester and queuer personas in server mode (defaults Mia and Wei) |
| `/?demo=1` | Never ask for the browser's location; "Back to me" uses the fixed demo spot |
| `/?backend=mock&speed=60` | The in-browser market's clock runs 60 times faster (the server keeps its own clock, so `?speed` only applies without it) |
| `/characters` | The four characters, idle and walk, orbit controls, player colours |

On the map: tap or click the ground to walk along the streets, tap a glowing item
(or its label) to open its sheet, scroll or pinch to zoom, WASD or the arrow keys
to walk. "Walk there" in a sheet, or a tap right next to a shop, walks you to the
back of that shop's line.

The **Map** button switches from the tilted 3D street view to a top-down overview
of the whole city: one dot per task, sized by its requests and glowing with its
top fee, clustered when far out, with filters (item type, fee, travel time) and a
list sorted by what a queuer would earn per hour (what they keep of the fee after
HoldMySpot's 10%, divided by travel plus queue time; sort by distance or fee too).
Every dot and row shows the fee on offer and the requests, the distance and travel
minutes, the estimated time in line and the $/hour. Travel is one honest estimate:
a walk up to 20 minutes, else transit (10 minutes to a stop and waiting, then 300 m
a minute), so a farther shop never shows fewer minutes; "Take it" posts an offer
whose arrival window covers that trip. Tasks more than 30 minutes away, or whose
requests end before you could arrive, are greyed and cannot be taken. A dot that
would sit under you or a button steps aside with a thin line to the shop. Tapping a dot or a row flies down
into 3D at that shop. **Back to me** (the target button) flies to your position
from either view: the browser's location when you allow it and you are in the
city, else the fixed demo spot.

```bash
npm test           # unit tests: the order book, earnings per hour and reach, the payments mock
npm run build      # type-check and production build into dist/
npm run shots      # screenshots into ../proto-shots/v2/final (needs the dev server; the hero shots need `npm run demo` in server/)
```

`npm run shots` uses `playwright-core` with a Playwright Chromium already on the
machine (revision 1194). Set `OUT_DIR` to write somewhere else, `CHROMIUM_PATH` to
use another Chromium, and `GL=swiftshader` where there is no GPU.

## How the market behaves

- A request is a max queue fee per unit plus the shop price up to a cap (and a
  shipping budget when a plush ships to another US city). It rests in the book of
  its shop item, backed by a PayPal hold for the most it could cost.
- A queuer's offer is bound to the shop: a fee, optionally on a clock (open, step,
  interval, floor) that only starts when the queuer checks in. The clock lives on
  the queuer's fee; nothing that is already bought is ever sold again.
- "Book now" takes the current fee. "Set my max fee" rests as a limit order held
  by PayPal and fills when the clock steps to it. In server mode both go through a
  plainly labelled "Simulated PayPal" sheet; both forms show what PayPal holds
  ("never more than this") and HoldMySpot's 10% of the queue fee. The money panel
  lists the server's ledger for both personas: the requester's holds, captures and
  releases, and the queuer's payouts. The money chip carries the mode banner
  ("Simulated PayPal") on every screen.
- Cakes and ramen are local errands (perishable); a plush drop is one per
  customer and can ship within the US at cost.

## How it is put together

- `src/domain`: plain TypeScript with no UI. `book.ts` matches with the shared
  engine (`@holdmyspot/shared`: `matchBook`, the fee clock), `earning.ts` computes
  reach (travel, arrival window) and $/hour, `catalog.ts` builds the in-browser
  market from `shared/src/seed.ts`, `money.ts` keeps integer US cents.
- `src/state`: the market store, `mockMarket.ts` (in-browser) and `serverMarket.ts`
  (REST plus server-sent events), the player's position and colours.
- `src/services`: the typed API client, the market clock, and the in-browser
  payments mock behind the same interface the server implements.
- `src/map`: MapLibre setup, our pastel restyle of the OpenFreeMap "liberty" style
  (English or Latin street names only, no place labels), a street graph built from
  the vector tiles for walking, and `MapScene`, a MapLibre custom layer that renders
  three.js in the map's own WebGL context, with the overview and fly-to camera moves.
- `src/ui/Overview.tsx`: the overview's dots, clusters, chips, filters and list.
  `src/ui/TaskLabels.tsx`: the floating labels of the 3D view.
- `src/three`: procedural chibi characters, item models, beacons, effects, and the
  `/characters` stage.
- `src/ui` and `src/pages`: React components. Game UI uses Fredoka and round
  shapes; money UI uses Figtree, exact cents and square-ish state chips.

All shops, people, brands and items are fictional.

## Credits

- Map data © OpenStreetMap contributors; tiles by OpenFreeMap, schema by
  OpenMapTiles. The attribution is always visible on the map.
- Street props: KayKit City Builder Bits and Restaurant Bits by Kay Lousberg, CC0.
  Each folder in `public/models` keeps its `LICENSE.txt`.
- Fonts: Fredoka and Figtree (SIL Open Font License), installed from npm.
- Characters and items are original, built from primitives in code.

## Debugging

In dev mode only, `window.__map`, `window.__scene`, `window.__market` (the store),
`window.__clock` (the market clock) and `window.__position` are available in the
browser console.
