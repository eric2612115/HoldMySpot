import * as THREE from 'three';

/** Small canvas-drawn textures, created once and shared. */

const cache = new Map<string, THREE.CanvasTexture>();

function canvasTexture(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void) {
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  cache.set(key, tex);
  return tex;
}

/** White radial glow, opaque in the middle and clear at the edge. Tint it with material colour. */
export function radialGlow(): THREE.CanvasTexture {
  return canvasTexture('radial-glow', 128, 128, (ctx, w) => {
    const g = ctx.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.7, 'rgba(255,255,255,0.14)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, w);
  });
}

/** Vertical fade for light columns: strong at the bottom, gone at the top. */
export function verticalFade(): THREE.CanvasTexture {
  return canvasTexture('vertical-fade', 4, 128, (ctx, w, h) => {
    const g = ctx.createLinearGradient(0, h, 0, 0);
    g.addColorStop(0, 'rgba(255,255,255,0.95)');
    g.addColorStop(0.45, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  });
}

/** Four-point sparkle. */
export function sparkle(): THREE.CanvasTexture {
  return canvasTexture('sparkle', 64, 64, (ctx, w) => {
    const c = w / 2;
    ctx.translate(c, c);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, c);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const r = i % 2 === 0 ? c * 0.95 : c * 0.2;
      const a = (i / 8) * Math.PI * 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  });
}

/** A small shop tag for plush toys: the shop's initial on a soft card. */
export function plushTag(): THREE.CanvasTexture {
  return canvasTexture('plush-tag', 128, 160, (ctx, w, h) => {
    ctx.fillStyle = '#FFFDF7';
    ctx.beginPath();
    ctx.roundRect(8, 8, w - 16, h - 16, 18);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#F4A7C0';
    ctx.stroke();
    ctx.fillStyle = '#F4A7C0';
    ctx.beginPath();
    ctx.arc(w / 2, 30, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#7A3F57';
    ctx.font = '700 64px "Fredoka Variable", "Fredoka", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('♥', w / 2, h / 2 + 18);
  });
}
