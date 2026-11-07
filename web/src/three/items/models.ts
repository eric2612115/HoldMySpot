import * as THREE from 'three';
import type { ItemLook } from '../../domain/types';
import { addOutline, toon, type OutlineSettings } from '../materials/toon';
import { plushTag } from '../materials/textures';

/**
 * Original, generic item models built from primitives. Each fits in about
 * one unit and is centred on the origin so it can spin in place.
 */

type Opts = { pos?: [number, number, number]; rot?: [number, number, number]; scale?: [number, number, number]; outline?: boolean };

function add(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, outline: OutlineSettings, o: Opts = {}) {
  const mesh = new THREE.Mesh(geo, mat);
  if (o.pos) mesh.position.set(...o.pos);
  if (o.rot) mesh.rotation.set(...o.rot);
  if (o.scale) mesh.scale.set(...o.scale);
  parent.add(mesh);
  if (o.outline !== false) addOutline(mesh, outline);
  return mesh;
}

function decal(parent: THREE.Object3D, tex: THREE.Texture, w: number, h: number, pos: [number, number, number], rot: [number, number, number] = [0, 0, 0]) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }),
  );
  mesh.position.set(...pos);
  mesh.rotation.set(...rot);
  parent.add(mesh);
  return mesh;
}

function cake(outline: OutlineSettings): THREE.Group {
  const g = new THREE.Group();
  const white = toon('#FFFFFF');
  const cream = toon('#FFF6EC');
  const pink = toon('#FF9EBB');
  const berry = toon('#FF4D6D');
  const leaf = toon('#5CC46B');
  add(g, new THREE.CylinderGeometry(0.66, 0.6, 0.07, 40), white, outline, { pos: [0, -0.36, 0] });
  add(g, new THREE.CylinderGeometry(0.5, 0.5, 0.48, 40), cream, outline, { pos: [0, -0.08, 0] });
  // A pink jam layer peeking out around the middle.
  add(g, new THREE.TorusGeometry(0.5, 0.035, 8, 40), pink, outline, { pos: [0, -0.1, 0], rot: [Math.PI / 2, 0, 0], outline: false });
  // Pink glaze on top with drips.
  add(g, new THREE.CylinderGeometry(0.52, 0.52, 0.08, 40), pink, outline, { pos: [0, 0.18, 0] });
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + 0.2;
    const len = 0.05 + ((i * 37) % 5) * 0.025;
    add(g, new THREE.CapsuleGeometry(0.045, len, 4, 8), pink, outline, {
      pos: [Math.cos(a) * 0.5, 0.12 - len / 2, Math.sin(a) * 0.5],
      outline: false,
    });
  }
  // Cream dollops and strawberries around the rim.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    add(g, new THREE.SphereGeometry(0.085, 14, 10), white, outline, { pos: [Math.cos(a) * 0.36, 0.27, Math.sin(a) * 0.36], scale: [1, 0.8, 1] });
    const b = a + Math.PI / 6;
    const s = add(g, new THREE.SphereGeometry(0.09, 14, 10), berry, outline, { pos: [Math.cos(b) * 0.34, 0.31, Math.sin(b) * 0.34], scale: [1, 1.25, 1] });
    add(s, new THREE.ConeGeometry(0.06, 0.06, 6), leaf, outline, { pos: [0, 0.09, 0], rot: [Math.PI, 0, 0], outline: false });
  }
  const top = add(g, new THREE.SphereGeometry(0.12, 16, 12), berry, outline, { pos: [0, 0.36, 0], scale: [1, 1.3, 1] });
  add(top, new THREE.ConeGeometry(0.08, 0.07, 6), leaf, outline, { pos: [0, 0.11, 0], rot: [Math.PI, 0, 0], outline: false });
  return g;
}

/**
 * A soft plush toy: a round body and head, a face that looks at you, and ears
 * by kind (bunny, cat, otter, pup). Built to read as "a plush" from far away.
 */
function plush(look: 'bunny' | 'cat' | 'otter' | 'pup', outline: OutlineSettings): THREE.Group {
  const palette = {
    bunny: { fur: '#FFF8F2', inner: '#FFB8CC', accent: '#FF8FB8' },
    cat: { fur: '#FFFFFF', inner: '#FFB3C1', accent: '#E5484D' },
    otter: { fur: '#C99A73', inner: '#F2D7BE', accent: '#6FC3E8' },
    pup: { fur: '#F4E3C8', inner: '#B88763', accent: '#A78BFA' },
  }[look];
  const g = new THREE.Group();
  const fur = toon(palette.fur);
  const inner = toon(palette.inner);
  const accent = toon(palette.accent);
  const ink = toon('#3A2B33');
  const blush = toon('#FF9DB4');
  const gold = toon('#F7C948');
  // Body and feet.
  add(g, new THREE.SphereGeometry(0.34, 28, 20), fur, outline, { pos: [0, -0.22, 0], scale: [1.05, 0.92, 0.95] });
  for (const side of [1, -1]) add(g, new THREE.SphereGeometry(0.12, 16, 12), fur, outline, { pos: [side * 0.17, -0.47, 0.12], scale: [1, 0.7, 1.15] });
  // Arms.
  for (const side of [1, -1]) add(g, new THREE.SphereGeometry(0.1, 14, 10), fur, outline, { pos: [side * 0.3, -0.18, 0.12], scale: [0.8, 1.1, 0.8] });
  // Head.
  const head = new THREE.Group();
  head.position.set(0, 0.24, 0);
  g.add(head);
  add(head, new THREE.SphereGeometry(0.33, 30, 22), fur, outline, { scale: [1.1, 0.95, 1] });
  // Ears.
  if (look === 'bunny') {
    for (const side of [1, -1]) {
      const ear = new THREE.Group();
      ear.position.set(side * 0.14, 0.28, -0.02);
      ear.rotation.z = -side * 0.18;
      head.add(ear);
      add(ear, new THREE.CapsuleGeometry(0.075, 0.36, 6, 14), fur, outline, { pos: [0, 0.2, 0] });
      add(ear, new THREE.CapsuleGeometry(0.04, 0.26, 4, 10), inner, outline, { pos: [0, 0.2, 0.05], outline: false });
    }
    // A blossom on one ear.
    const flower = new THREE.Group();
    flower.position.set(0.24, 0.5, 0.05);
    head.add(flower);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      add(flower, new THREE.SphereGeometry(0.045, 10, 8), accent, outline, { pos: [Math.cos(a) * 0.05, Math.sin(a) * 0.05, 0], outline: false });
    }
    add(flower, new THREE.SphereGeometry(0.03, 10, 8), gold, outline, { pos: [0, 0, 0.02], outline: false });
  } else if (look === 'cat') {
    for (const side of [1, -1]) {
      add(head, new THREE.ConeGeometry(0.11, 0.2, 4), fur, outline, { pos: [side * 0.19, 0.3, 0], rot: [0, Math.PI / 4, -side * 0.35] });
      add(head, new THREE.ConeGeometry(0.06, 0.12, 4), inner, outline, { pos: [side * 0.19, 0.29, 0.05], rot: [0, Math.PI / 4, -side * 0.35], outline: false });
    }
    // A raised paw and a red collar with a bell: a lucky cat.
    add(g, new THREE.SphereGeometry(0.1, 14, 10), fur, outline, { pos: [0.32, 0.12, 0.08], scale: [0.85, 1.1, 0.85] });
    add(g, new THREE.TorusGeometry(0.25, 0.035, 8, 28), accent, outline, { pos: [0, 0.0, 0], rot: [Math.PI / 2, 0, 0], outline: false });
    add(g, new THREE.SphereGeometry(0.06, 12, 10), gold, outline, { pos: [0, -0.04, 0.26] });
  } else if (look === 'otter') {
    for (const side of [1, -1]) add(head, new THREE.SphereGeometry(0.07, 12, 10), fur, outline, { pos: [side * 0.27, 0.18, 0], scale: [1, 1, 0.6] });
    add(head, new THREE.SphereGeometry(0.15, 18, 12), inner, outline, { pos: [0, -0.08, 0.22], scale: [1.3, 0.8, 0.7], outline: false });
    add(g, new THREE.TorusGeometry(0.23, 0.035, 8, 28), accent, outline, { pos: [0, 0.0, 0], rot: [Math.PI / 2, 0, 0], outline: false });
  } else {
    for (const side of [1, -1]) add(head, new THREE.CapsuleGeometry(0.07, 0.2, 6, 12), inner, outline, { pos: [side * 0.33, 0.02, 0], rot: [0, 0, side * 0.35] });
    add(head, new THREE.SphereGeometry(0.13, 16, 12), toon('#FFF8F2'), outline, { pos: [0, -0.1, 0.24], scale: [1.2, 0.8, 0.7], outline: false });
    add(g, new THREE.TorusGeometry(0.23, 0.035, 8, 28), accent, outline, { pos: [0, 0.0, 0], rot: [Math.PI / 2, 0, 0], outline: false });
  }
  // Face, looking out.
  for (const side of [1, -1]) {
    add(head, new THREE.SphereGeometry(0.045, 12, 10), ink, outline, { pos: [side * 0.12, 0.02, 0.29], scale: [1, 1.25, 0.6], outline: false });
    add(head, new THREE.SphereGeometry(0.05, 12, 10), blush, outline, { pos: [side * 0.2, -0.08, 0.25], scale: [1.2, 0.7, 0.4], outline: false });
  }
  add(head, new THREE.SphereGeometry(0.03, 10, 8), look === 'otter' || look === 'pup' ? ink : blush, outline, { pos: [0, -0.04, 0.32], scale: [1.3, 0.9, 0.7], outline: false });
  // The shop's tag on the hip.
  decal(g, plushTag(), 0.16, 0.2, [-0.24, -0.3, 0.27], [0, -0.3, 0.2]);
  g.position.y = 0.06;
  return g;
}

/** A takeout bowl of ramen: noodles, egg, chashu, nori and scallions, chopsticks across the rim. */
function ramen(outline: OutlineSettings): THREE.Group {
  const g = new THREE.Group();
  const bowlOut = toon('#2B2A33');
  const bowlIn = toon('#C9433B');
  const rim = toon('#F4EDE4');
  const broth = toon('#F2C77D');
  const noodle = toon('#FFE08A');
  const white = toon('#FFFFFF');
  const yolk = toon('#F6A623');
  const pork = toon('#C97B5A');
  const nori = toon('#2D4A2B');
  const leek = toon('#6FBF4A');
  const stick = toon('#D9A66B');
  // Bowl: a lathe profile, dark outside and red inside, with a light rim.
  const profile = [
    new THREE.Vector2(0.0, -0.42),
    new THREE.Vector2(0.22, -0.42),
    new THREE.Vector2(0.26, -0.36),
    new THREE.Vector2(0.44, -0.18),
    new THREE.Vector2(0.56, 0.06),
    new THREE.Vector2(0.6, 0.14),
  ];
  add(g, new THREE.LatheGeometry(profile, 40), bowlOut, outline, {});
  const innerProfile = profile.map((v) => new THREE.Vector2(v.x * 0.94, v.y + 0.02));
  const inside = new THREE.Mesh(new THREE.LatheGeometry(innerProfile, 40), bowlIn);
  (inside.material as THREE.Material).side = THREE.BackSide;
  g.add(inside);
  add(g, new THREE.TorusGeometry(0.585, 0.03, 8, 48), rim, outline, { pos: [0, 0.14, 0], rot: [Math.PI / 2, 0, 0], outline: false });
  // Broth and noodles.
  add(g, new THREE.CylinderGeometry(0.54, 0.54, 0.03, 40), broth, outline, { pos: [0, 0.08, 0], outline: false });
  for (let i = 0; i < 5; i++) {
    add(g, new THREE.TorusGeometry(0.12 + i * 0.07, 0.022, 6, 28, Math.PI * (0.8 + (i % 2) * 0.4)), noodle, outline, {
      pos: [0, 0.1, 0],
      rot: [Math.PI / 2, 0, i * 1.3],
      outline: false,
    });
  }
  // Toppings.
  for (const side of [1, -1]) {
    const egg = add(g, new THREE.SphereGeometry(0.1, 16, 10, 0, Math.PI * 2, 0, Math.PI / 2), white, outline, { pos: [side * 0.12 - 0.18, 0.1, 0.22], scale: [1, 0.6, 1.25] });
    add(egg, new THREE.CircleGeometry(0.055, 16), yolk, outline, { pos: [0, 0.005, 0], rot: [-Math.PI / 2, 0, 0], outline: false });
  }
  for (let i = 0; i < 2; i++) add(g, new THREE.CylinderGeometry(0.13, 0.13, 0.04, 24), pork, outline, { pos: [0.16 + i * 0.07, 0.12 + i * 0.02, -0.1 + i * 0.04], rot: [0.25, 0, -0.2] });
  add(g, new THREE.BoxGeometry(0.2, 0.26, 0.01), nori, outline, { pos: [-0.2, 0.2, -0.32], rot: [-0.25, 0.35, 0] });
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9;
    add(g, new THREE.CylinderGeometry(0.018, 0.018, 0.02, 8), leek, outline, { pos: [Math.cos(a) * 0.3, 0.11, Math.sin(a) * 0.3], outline: false });
  }
  // Chopsticks across the rim.
  for (const dz of [-0.04, 0.04]) add(g, new THREE.CylinderGeometry(0.016, 0.012, 1.3, 8), stick, outline, { pos: [0.05, 0.2, dz], rot: [0, 0.2, Math.PI / 2 - 0.08] });
  g.scale.setScalar(0.92);
  return g;
}

export function createItemModel(look: ItemLook, outline: OutlineSettings): THREE.Group {
  switch (look) {
    case 'cake':
      return cake(outline);
    case 'ramen':
      return ramen(outline);
    default:
      return plush(look, outline);
  }
}
