import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { toonGradient } from '../materials/toon';

/**
 * Street props from two CC0 packs by Kay Lousberg (KayKit City Builder Bits
 * and Restaurant Bits). Only the models used are copied into
 * public/models, each folder with its LICENSE.txt.
 */
export type PropName =
  | 'streetlight'
  | 'bench'
  | 'bush'
  | 'firehydrant'
  | 'box_A'
  | 'box_B'
  | 'menu'
  | 'table_round_A_small_decorated'
  | 'chair_A'
  | 'crate_buns';

const RESTAURANT = new Set<PropName>(['menu', 'table_round_A_small_decorated', 'chair_A', 'crate_buns']);

/** Height in metres each prop is scaled to on the map, matched to the chibi characters. */
export const PROP_HEIGHT: Record<PropName, number> = {
  streetlight: 15,
  bench: 3.2,
  bush: 4.5,
  firehydrant: 3.4,
  box_A: 2.6,
  box_B: 2.4,
  menu: 6,
  table_round_A_small_decorated: 6.5,
  chair_A: 6,
  crate_buns: 3.6,
};

const loader = new GLTFLoader();
const cache = new Map<PropName, Promise<THREE.Object3D>>();

function url(name: PropName): string {
  const folder = RESTAURANT.has(name) ? 'kaykit-restaurant' : 'kaykit-city';
  return `${import.meta.env.BASE_URL}models/${folder}/${name}.gltf`;
}

function load(name: PropName): Promise<THREE.Object3D> {
  let p = cache.get(name);
  if (!p) {
    p = loader.loadAsync(url(name)).then((gltf) => {
      const root = gltf.scene;
      // Match the toon look of everything else.
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const src = mesh.material as THREE.MeshStandardMaterial;
        mesh.material = new THREE.MeshToonMaterial({ map: src.map ?? null, color: src.color ?? new THREE.Color('#ffffff'), gradientMap: toonGradient() });
        src.dispose();
      });
      const box = new THREE.Box3().setFromObject(root);
      const h = Math.max(0.0001, box.max.y - box.min.y);
      const wrap = new THREE.Group();
      root.position.y -= box.min.y;
      wrap.add(root);
      wrap.userData.unitHeight = h;
      return wrap;
    });
    cache.set(name, p);
  }
  return p;
}

/** A placed copy of a prop, scaled to its map height. Shares geometry and materials. */
export async function createProp(name: PropName): Promise<THREE.Object3D> {
  const base = await load(name);
  const copy = base.clone(true);
  copy.scale.setScalar(PROP_HEIGHT[name] / (base.userData.unitHeight as number));
  copy.name = `prop-${name}`;
  return copy;
}
