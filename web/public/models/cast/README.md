# The cast

The people of HoldMySpot, as the map and the characters page show them: the soft plush cast of HoldMySpot,
made for this project (MIT, like the rest of the repo). The app reads them through
`web/src/three/characters/castModels.ts` and `cozy.ts`.

- `<id>.glb`: one skinned mesh per person (about 10,000 to 16,700 triangles, 16-bit positions and meshopt compression,
  no textures). Every vertex belongs to one joint (hips, spine, neck, head, shoulders, elbows, wrists, legs, knees,
  ankles, tail, ears, ponytails), so the app moves the joints the poses name. The root node's extras hold the person's
  colours, the head centre the face is projected from, and how their one prop is held.
- `faces/<id>-stage.webp` and `faces/<id>-map.webp`: the painted face in three cells (neutral, blink, happy), covering
  the front half of the head by angle; the map's set is smaller and has no lashes.
- `portraits.webp`: one 128 px head-and-shoulders portrait per person, eight to a row in the order of `CAST_MODELS`,
  for the round face badges in the flat UI.

The ids are the demo people's (`mia`, `wei`, `lin`, `rex`, `priya`, `jun`, `sam`, `noor`, `leo`, `rin`, `ava`, `jo`,
`dana`, `theo`, `mo`), `you` for the player and `crowd-*` for everyone else. `castModels.test.ts` checks that every
file is here and that the models' colours match the looks in `presets.ts`.
