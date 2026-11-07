# HoldMySpot web app

The phone app of HoldMySpot: the 3D map of requests, the requester's sheets with the PayPal hold, the queuer's phone (check-in, photos, payout) and the money panel. Setup, PayPal, AI and the demo are in the [root README](../README.md); run everything from the repo root with `npm run setup` and `npm run demo`.

To run this app alone, start the server first (`npm run demo` in `../server`), then:

```sh
npm install
npm run dev          # http://127.0.0.1:5190 ; /api goes to 127.0.0.1:8796 (HMS_API_PROXY changes it)
npm test             # vitest: the order book, earnings and reach, the payments mock, the PayPal SDK adapter, the queuer's steps
npm run build        # type check and production build into dist/
```

Without a server it falls back to an in-browser market (`?backend=mock`). URL switches: `?demo=1` (no location prompt), `?phone=queuer`, `?as=<requester>`, `?queuer=<queuer>`, `?city=nyc`, `?view=overview`, `?backend=server|mock`.

- `src/domain/`: plain TypeScript (book, earnings per hour, catalog, money in cents) on top of `@holdmyspot/shared`.
- `src/state/`: the market store; `serverMarket.ts` (REST and server-sent events) and `mockMarket.ts` (in the browser).
- `src/services/payments/`: the PayPal JS SDK v6 adapter (`paypalV6.ts`, `approval.ts`) and the in-browser mock.
- `src/map/` and `src/three/`: MapLibre with OpenFreeMap tiles, and the three.js scene drawn in the map's own WebGL context.
- `src/ui/`: the sheets and panels; `src/ui/queuer/` is the queuer's phone.

How the app talks to the server: [docs/WEB-INTEGRATION.md](../docs/WEB-INTEGRATION.md).
