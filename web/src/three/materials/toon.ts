import * as THREE from 'three';

/**
 * Shared toon look: three soft bands of light, plus "inverted hull" outlines
 * drawn in a darker shade of each part's own colour (never pure black), so
 * edges read as soft ink lines.
 */

let gradient: THREE.DataTexture | null = null;

export function toonGradient(): THREE.DataTexture {
  if (gradient) return gradient;
  const steps = new Uint8Array([150, 205, 255]);
  gradient = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  gradient.minFilter = THREE.NearestFilter;
  gradient.magFilter = THREE.NearestFilter;
  gradient.generateMipmaps = false;
  gradient.needsUpdate = true;
  return gradient;
}

export function toon(color: THREE.ColorRepresentation, opts: Partial<THREE.MeshToonMaterialParameters> = {}): THREE.MeshToonMaterial {
  return new THREE.MeshToonMaterial({ color, gradientMap: toonGradient(), ...opts });
}

const INK = new THREE.Color('#2A2140');
const rgbA = { r: 0, g: 0, b: 0 };
const rgbB = { r: 0, g: 0, b: 0 };

/**
 * A soft ink shade for a colour's outline: the colour mixed (in sRGB) with a
 * deep plum, so pale skin gets a muted mauve line rather than a hot orange one.
 */
export function inkFor(color: THREE.Color, target = new THREE.Color()): THREE.Color {
  color.getRGB(rgbA, THREE.SRGBColorSpace);
  INK.getRGB(rgbB, THREE.SRGBColorSpace);
  const k = 0.58;
  return target.setRGB(rgbA.r + (rgbB.r - rgbA.r) * k, rgbA.g + (rgbB.g - rgbA.g) * k, rgbA.b + (rgbB.b - rgbA.b) * k, THREE.SRGBColorSpace);
}

/** One uniform object shared by every outline in a scene, so its width can be tuned live. */
export interface OutlineSettings {
  width: { value: number };
}

export function createOutlineSettings(width: number): OutlineSettings {
  return { width: { value: width } };
}

export function outlineMaterial(color: THREE.Color, settings: OutlineSettings): THREE.MeshBasicMaterial {
  const mat = new THREE.MeshBasicMaterial({ color: inkFor(color), side: THREE.BackSide });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = settings.width;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float outlineWidth;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(normal) * outlineWidth;');
  };
  mat.customProgramCacheKey = () => 'soft-outline';
  return mat;
}

/**
 * Adds an outline shell to a mesh (sharing its geometry). Returns the shell
 * so callers can recolour it when the base colour changes.
 */
export function addOutline(mesh: THREE.Mesh, settings: OutlineSettings): THREE.Mesh {
  const base = mesh.material as THREE.MeshToonMaterial;
  const shell = new THREE.Mesh(mesh.geometry, outlineMaterial(base.color, settings));
  shell.name = `${mesh.name}-outline`;
  shell.renderOrder = mesh.renderOrder - 1;
  shell.raycast = () => {};
  mesh.add(shell);
  return shell;
}

/** Soft round shadow texture, drawn once and shared. */
let blob: THREE.CanvasTexture | null = null;
export function blobShadowTexture(): THREE.CanvasTexture {
  if (blob) return blob;
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(48, 40, 90, 0.55)');
  g.addColorStop(0.55, 'rgba(48, 40, 90, 0.28)');
  g.addColorStop(1, 'rgba(48, 40, 90, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  blob = new THREE.CanvasTexture(canvas);
  blob.colorSpace = THREE.SRGBColorSpace;
  return blob;
}

export function blobShadow(radius: number, opacity = 1): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(radius * 2, radius * 2),
    new THREE.MeshBasicMaterial({ map: blobShadowTexture(), transparent: true, depthWrite: false, opacity }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -10;
  mesh.name = 'blob-shadow';
  return mesh;
}
