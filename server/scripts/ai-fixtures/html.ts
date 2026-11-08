import { photoStampText } from '@holdmyspot/shared';
import QRCode from 'qrcode';
import { buildReceiptQr } from '../../src/ai/qr.ts';
import type { ItemPhotoSpec, LinePhotoSpec, PhotoLook, ReceiptSpec, Tweak } from './cases.ts';

/**
 * HTML scenes for the synthetic proof photos. Everything is drawn with CSS
 * and inline SVG (no images, no network) and photographed by Chromium in
 * scripts/render-receipts.ts. Shops, products and people are fictional.
 */

export const SIZES = {
  receipt: { width: 760, height: 1100 },
  item: { width: 1000, height: 750 },
  line: { width: 1000, height: 750 },
} as const;

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function surface(bg: PhotoLook['background']): string {
  switch (bg) {
    case 'wood':
      return `background:
        repeating-linear-gradient(92deg, rgba(60,30,10,.16) 0 2px, transparent 2px 23px),
        repeating-linear-gradient(88deg, rgba(255,230,190,.07) 0 6px, transparent 6px 41px),
        linear-gradient(90deg, #7a4a24, #946034 30%, #845428 55%, #9b6939 80%, #7d4d27);`;
    case 'slate':
      return `background:
        radial-gradient(circle at 30% 20%, rgba(255,255,255,.06), transparent 40%),
        repeating-linear-gradient(35deg, rgba(255,255,255,.025) 0 3px, transparent 3px 9px),
        linear-gradient(160deg, #3b424d, #2c323b 60%, #353c46);`;
    case 'linen':
      return `background:
        repeating-linear-gradient(0deg, rgba(120,100,70,.07) 0 1px, transparent 1px 4px),
        repeating-linear-gradient(90deg, rgba(120,100,70,.07) 0 1px, transparent 1px 4px),
        linear-gradient(180deg, #e9e1d1, #ddd3c0);`;
    case 'marble':
      return `background:
        linear-gradient(115deg, transparent 38%, rgba(140,140,150,.18) 39%, transparent 41%),
        linear-gradient(70deg, transparent 62%, rgba(120,120,130,.14) 63%, transparent 66%),
        linear-gradient(150deg, transparent 20%, rgba(150,150,160,.12) 21%, transparent 23%),
        linear-gradient(180deg, #f3f1ec, #e6e3dc);`;
    case 'steel':
      return `background:
        repeating-linear-gradient(0deg, rgba(255,255,255,.05) 0 1px, transparent 1px 3px),
        linear-gradient(135deg, #8f98a1, #c3cad0 45%, #9aa3ab 70%, #b4bbc1);`;
  }
}

function lightOverlay(l: PhotoLook): string {
  const at = l.lightFrom === 'left' ? '15% 30%' : l.lightFrom === 'right' ? '85% 30%' : '50% 0%';
  return `<div style="position:absolute;inset:0;pointer-events:none;background:radial-gradient(ellipse at ${at}, rgba(255,250,235,.28), transparent 55%), radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,.28) 100%);"></div>`;
}

function page(width: number, height: number, body: string, filter: string, extraCss = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:#222}
    .scene{position:relative;width:${width}px;height:${height}px;overflow:hidden;filter:${filter}}
    ${extraCss}
  </style></head><body>${body}</body></html>`;
}

function tweakWrap(inner: string, t: Tweak | null): { html: string; filter: string } {
  if (!t) return { html: inner, filter: '' };
  return {
    html: `<div style="position:absolute;inset:0;transform:translate(${t.dx}px,${t.dy}px) scale(${t.scale});transform-origin:center">${inner}</div>`,
    filter: `brightness(${t.brightness})`,
  };
}

// ---------------------------------------------------------------------------
// Receipt
// ---------------------------------------------------------------------------

const money = (minor: number) => `$${(minor / 100).toFixed(2)}`;

function usTime(local: string): string {
  const [d, t] = local.split(' ');
  const [y, mo, da] = (d ?? '').split('-');
  const [h, mi, s] = (t ?? '').split(':').map(Number);
  const hour = h ?? 0;
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${mo}/${da}/${y}  ${h12}:${String(mi).padStart(2, '0')}:${String(s).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
}

export async function receiptHtml(r: ReceiptSpec, tweak: Tweak | null = null): Promise<string> {
  const { width, height } = SIZES.receipt;
  const l = r.look;
  const lines = r.lines
    .map((li) => {
      const total = li.total ?? li.qty * li.unit;
      return `<div class="li">${esc(li.name)}</div>
        <div class="row li2"><span>${li.qty} @ ${money(li.unit)}</span><span>${money(total)}</span></div>`;
    })
    .join('');
  const header = `
      <div class="c b big">${esc(r.printedName)}</div>
      <div class="c">${esc(r.address)}</div>
      ${r.sellerTaxId ? `<div class="c">Store ${esc(r.sellerTaxId)}</div>` : ''}
      <div class="c">${r.qr ? 'Receipt' : 'Order'} ${esc(r.invoiceNumber)}</div>
      <div class="c">${esc(usTime(r.issuedLocal))}</div>
      <div class="sep"></div>`;
  let footer = '';
  if (r.qr) {
    const text = buildReceiptQr({
      invoiceNumber: r.qr.invoiceNumber,
      issuedDate: r.qr.issuedDate,
      totalAmount: r.qr.total,
      sellerTaxId: r.qr.sellerTaxId,
      items: r.lines.map((li) => ({ name: li.name, qty: li.qty, unitPrice: li.unit })),
    });
    const svg = await QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 176, color: { dark: '#111111', light: '#fbfaf6' } });
    footer = `<div class="qrrow"><div class="qr">${svg}</div><div class="qrnote">Scan for your<br>digital receipt</div></div>`;
  }
  const paper = `
    <div class="paper">
      ${header}
      ${lines}
      <div class="sep"></div>
      <div class="row b tot"><span>TOTAL</span><span>${money(r.total)}</span></div>
      <div class="row"><span>${esc(r.payment)}</span><span>${money(r.total)}</span></div>
      <div class="c small">Prices include sales tax</div>
      ${footer}
      <div class="c thanks">Thank you, see you again</div>
    </div>`;
  const scene = `<div class="table">${paper}</div>${lightOverlay(l)}`;
  const t = tweakWrap(scene, tweak);
  const css = `
    .table{position:absolute;inset:0;${surface(l.background)};perspective:1500px}
    .paper{position:absolute;left:50%;top:50%;width:430px;padding:24px 24px 30px;box-sizing:border-box;
      transform:translate(calc(-50% + ${l.x}px), calc(-50% + ${l.y}px)) rotateX(${l.tiltX}deg) rotateY(${l.tiltY}deg) rotateZ(${l.rotate}deg) scale(${l.scale});
      background:linear-gradient(180deg,#fdfcf8,#f6f4ee 70%,#efece4);color:#262626;
      font-family:Menlo,'Courier New',monospace;font-size:14.5px;line-height:1.45;
      box-shadow:0 22px 40px rgba(0,0,0,.38),0 2px 6px rgba(0,0,0,.2);border-radius:2px}
    .c{text-align:center}.b{font-weight:700}.big{font-size:19px;letter-spacing:1px}
    .row{display:flex;justify-content:space-between}
    .qrrow{display:flex;align-items:center;justify-content:center;gap:14px;margin:12px 0 4px}
    .qr svg{display:block;width:176px;height:176px}
    .qrnote{font-size:12.5px;color:#444;line-height:1.35}
    .sep{border-top:2px dashed #8a8a8a;margin:10px 0}
    .li{margin-top:6px}.li2{padding-left:24px}
    .small{font-size:12px;color:#555;margin-top:4px}
    .tot{font-size:17px}.thanks{margin-top:12px;font-size:13px;color:#444}`;
  return page(width, height, `<div class="scene">${t.html}</div>`, `brightness(${l.light}) ${t.filter}`, css);
}

// ---------------------------------------------------------------------------
// Item photo
// ---------------------------------------------------------------------------

function bunny(): string {
  return `<svg width="190" height="230" viewBox="0 0 190 230">
    <ellipse cx="66" cy="62" rx="22" ry="58" fill="#fff8f4" stroke="#e8cfc4" stroke-width="3" transform="rotate(-10 66 62)"/>
    <ellipse cx="66" cy="66" rx="10" ry="42" fill="#ffc7d6" transform="rotate(-10 66 66)"/>
    <ellipse cx="124" cy="62" rx="22" ry="58" fill="#fff8f4" stroke="#e8cfc4" stroke-width="3" transform="rotate(12 124 62)"/>
    <ellipse cx="124" cy="66" rx="10" ry="42" fill="#ffc7d6" transform="rotate(12 124 66)"/>
    <g transform="translate(134 30)"><circle r="7" cx="0" cy="-8" fill="#ff8fb8"/><circle r="7" cx="8" cy="-2" fill="#ff8fb8"/><circle r="7" cx="5" cy="7" fill="#ff8fb8"/><circle r="7" cx="-5" cy="7" fill="#ff8fb8"/><circle r="7" cx="-8" cy="-2" fill="#ff8fb8"/><circle r="3.5" fill="#ffe27a"/></g>
    <ellipse cx="95" cy="186" rx="60" ry="40" fill="#fff8f4" stroke="#e8cfc4" stroke-width="3"/>
    <circle cx="95" cy="128" r="58" fill="#fff8f4" stroke="#e8cfc4" stroke-width="3"/>
    <ellipse cx="75" cy="128" rx="6" ry="8" fill="#3a2b33"/><ellipse cx="115" cy="128" rx="6" ry="8" fill="#3a2b33"/>
    <circle cx="73" cy="125" r="2" fill="#fff"/><circle cx="113" cy="125" r="2" fill="#fff"/>
    <ellipse cx="62" cy="146" rx="10" ry="6" fill="#ffb8c9" opacity=".8"/><ellipse cx="128" cy="146" rx="10" ry="6" fill="#ffb8c9" opacity=".8"/>
    <path d="M89 143 q6 6 12 0" fill="none" stroke="#7a3f52" stroke-width="3" stroke-linecap="round"/>
    <ellipse cx="62" cy="200" rx="16" ry="12" fill="#fff8f4" stroke="#e8cfc4" stroke-width="3"/><ellipse cx="128" cy="200" rx="16" ry="12" fill="#fff8f4" stroke="#e8cfc4" stroke-width="3"/>
  </svg>`;
}

function luckyCat(): string {
  return `<svg width="190" height="230" viewBox="0 0 190 230">
    <path d="M40 60 L55 18 L80 50 Z" fill="#ffffff" stroke="#d9d2c4" stroke-width="3"/><path d="M150 60 L135 18 L110 50 Z" fill="#ffffff" stroke="#d9d2c4" stroke-width="3"/>
    <path d="M50 52 L56 30 L70 48 Z" fill="#ffb3c1"/><path d="M140 52 L134 30 L120 48 Z" fill="#ffb3c1"/>
    <ellipse cx="95" cy="178" rx="62" ry="48" fill="#ffffff" stroke="#d9d2c4" stroke-width="3"/>
    <circle cx="95" cy="92" r="58" fill="#ffffff" stroke="#d9d2c4" stroke-width="3"/>
    <path d="M140 150 q28 -40 18 -78" fill="none" stroke="#d9d2c4" stroke-width="30" stroke-linecap="round"/>
    <path d="M140 150 q28 -40 18 -78" fill="none" stroke="#ffffff" stroke-width="24" stroke-linecap="round"/>
    <ellipse cx="158" cy="70" rx="15" ry="13" fill="#ffffff" stroke="#d9d2c4" stroke-width="3"/>
    <path d="M70 92 q6 -8 12 0" fill="none" stroke="#2d2a26" stroke-width="4" stroke-linecap="round"/><path d="M108 92 q6 -8 12 0" fill="none" stroke="#2d2a26" stroke-width="4" stroke-linecap="round"/>
    <path d="M88 110 q7 6 14 0" fill="none" stroke="#2d2a26" stroke-width="3" stroke-linecap="round"/>
    <path d="M55 136 q40 18 80 0" fill="none" stroke="#e5484d" stroke-width="10" stroke-linecap="round"/>
    <circle cx="95" cy="150" r="11" fill="#f7c948" stroke="#b5891a" stroke-width="3"/>
    <rect x="70" y="175" width="50" height="34" rx="6" fill="#f7c948" stroke="#b5891a" stroke-width="3"/>
  </svg>`;
}

function ramenBowl(): string {
  return `<svg width="250" height="210" viewBox="0 0 250 210">
    <path d="M18 92 Q125 236 232 92 Z" fill="#26262c"/>
    <path d="M40 120 Q125 205 210 120" fill="none" stroke="#3a3a44" stroke-width="6"/>
    <ellipse cx="125" cy="92" rx="107" ry="30" fill="#1b1b20"/>
    <ellipse cx="125" cy="92" rx="98" ry="25" fill="#f2d39b"/>
    <path d="M44 96 q9 -9 18 0 t18 0 t18 0 t18 0 t18 0 t18 0 t18 0 t18 0" fill="none" stroke="#e5b552" stroke-width="5" stroke-linecap="round"/>
    <path d="M52 86 q9 -7 18 0 t18 0 t18 0" fill="none" stroke="#e5b552" stroke-width="4" stroke-linecap="round"/>
    <circle cx="84" cy="86" r="15" fill="#fffaf0" stroke="#e7d7b8" stroke-width="2"/><circle cx="84" cy="86" r="8" fill="#f6a623"/>
    <ellipse cx="136" cy="84" rx="24" ry="12" fill="#c97b5a" stroke="#8e4f35" stroke-width="2"/>
    <path d="M124 84 q12 -6 24 0" fill="none" stroke="#f0c7a8" stroke-width="2"/>
    <rect x="166" y="68" width="22" height="30" rx="3" fill="#2d4a2b" transform="rotate(8 177 83)"/>
    <circle cx="110" cy="100" r="4" fill="#6fbf4a"/><circle cx="119" cy="96" r="4" fill="#6fbf4a"/><circle cx="160" cy="102" r="4" fill="#6fbf4a"/><circle cx="66" cy="100" r="4" fill="#6fbf4a"/>
    <path d="M22 88 Q125 18 228 88" fill="none" stroke="#e8eef3" stroke-width="3" opacity=".7"/>
    <rect x="70" y="138" width="110" height="24" rx="5" fill="#ffb454"/>
    <text x="125" y="155" text-anchor="middle" font-family="Georgia,serif" font-size="10.5" font-weight="700" fill="#3a2405" letter-spacing="0.5">STEAM LANTERN</text>
  </svg>`;
}

function cakeWindow(): string {
  return `<svg width="150" height="70" viewBox="0 0 150 70"><ellipse cx="75" cy="44" rx="62" ry="20" fill="#fffaf0"/><rect x="13" y="22" width="124" height="22" fill="#fffaf0"/><ellipse cx="75" cy="22" rx="62" ry="16" fill="#fff"/>
      <circle cx="45" cy="18" r="7" fill="#e3263a"/><circle cx="75" cy="14" r="7" fill="#e3263a"/><circle cx="105" cy="18" r="7" fill="#e3263a"/><circle cx="60" cy="26" r="6" fill="#e3263a"/><circle cx="90" cy="26" r="6" fill="#e3263a"/></svg>`;
}

function itemUnit(itemId: string, i: number): string {
  if (itemId === 'plush-paper-moon') {
    return `<div class="plush" style="--i:${i}">${bunny()}<div class="tag"><b>PAPER MOON</b><span>Mochi Bunny &middot; sakura</span></div></div>`;
  }
  if (itemId === 'plush-little-lantern') {
    return `<div class="plush" style="--i:${i}">${luckyCat()}<div class="tag"><b>LITTLE LANTERN</b><span>Lucky Cat &middot; launch</span></div></div>`;
  }
  if (itemId.startsWith('ramen')) {
    return `<div class="bowl" style="--i:${i}">${ramenBowl()}</div>`;
  }
  const sugar = itemId === 'cake-sugar-cloud';
  return `<div class="box cakebox${sugar ? ' mint' : ''}" style="--i:${i}">
      <div class="top"></div>
      <div class="front"><div class="brand pink">${sugar ? 'SUGAR CLOUD' : 'PETAL &amp; CRUMB'}</div>
      <div class="window">${cakeWindow()}</div>
      <div class="name">${sugar ? 'Strawberry cloud cake' : 'Strawberry shortcake'}</div></div></div>`;
}

/** What the phone stamps on a photo after it is taken (D-159): same text, corner, size and backing as web/src/ui/queuer/stamp.ts. */
export interface PhotoStamp {
  hhmm: string;
  shopName: string;
}

function stampHtml(width: number, height: number, code: string | null, stamp: PhotoStamp | null): string {
  if (!code || !stamp) return '';
  const font = Math.round(Math.min(width, height) * 0.04);
  return `<div style="position:absolute;left:${font / 2}px;top:${font / 2}px;padding:${Math.round(font * 0.35)}px ${Math.round(font * 0.6)}px;border-radius:${Math.round(font * 0.3)}px;background:rgba(10,12,22,.92);color:#fff;font:600 ${font}px ui-monospace,Menlo,Consolas,monospace;white-space:nowrap">${esc(photoStampText(code, stamp.hhmm, stamp.shopName))}</div>`;
}

export function itemHtml(s: ItemPhotoSpec, tweak: Tweak | null = null, stamp: PhotoStamp | null = null): string {
  const { width, height } = SIZES.item;
  const l = s.look;
  const unitsHtml = Array.from({ length: s.units }, (_, i) => itemUnit(s.itemId, i)).join('');
  const group = `<div class="units ${s.layout}">${unitsHtml}</div>`;
  const scene = `<div class="table"><div class="stage">${group}</div></div>${lightOverlay(l)}`;
  const t = tweakWrap(scene, tweak);
  const css = `
    .table{position:absolute;inset:0;${surface(l.background)};perspective:1300px}
    .stage{position:absolute;left:50%;top:52%;display:flex;align-items:center;gap:38px;
      transform:translate(calc(-50% + ${l.x}px), calc(-50% + ${l.y}px)) rotateX(${l.tiltX}deg) rotateY(${l.tiltY}deg) rotateZ(${l.rotate}deg) scale(${l.scale});transform-style:preserve-3d}
    .units{position:relative;display:flex;gap:26px;align-items:flex-end}
    .units.stack{flex-direction:column;gap:6px}
    .units.pair .box:nth-child(2),.units.pair .plush:nth-child(2),.units.pair .bowl:nth-child(2){transform:translateY(-26px) rotate(4deg)}
    .box{position:relative;width:250px;height:205px;filter:drop-shadow(0 18px 18px rgba(0,0,0,.4))}
    .box .front{position:absolute;left:0;top:26px;width:226px;height:179px;border-radius:4px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;
      font-family:Georgia,'Times New Roman',serif;color:#3a2405;box-shadow:inset 0 0 0 3px rgba(0,0,0,.08)}
    .box .top{position:absolute;left:12px;top:0;width:226px;height:26px;transform:skewX(-35deg);transform-origin:bottom left;border-radius:3px 3px 0 0}
    .cakebox .front{background:linear-gradient(160deg,#ffffff,#f1ece6);color:#7a2441}.cakebox .top{background:#fff}
    .mint .front{background:linear-gradient(160deg,#ffffff,#e4f6f1);color:#1f6f5f}.mint .top{background:#f4fffb}
    .window{width:160px;height:76px;background:#f7ecd9;border:3px solid #f2b8c9;border-radius:6px;display:flex;align-items:center;justify-content:center}
    .brand{font-weight:700;font-size:22px;letter-spacing:2px}.pink{color:#c2185b}
    .sub{font-size:13px;letter-spacing:1px}.name{font-size:18px;font-style:italic}
    .plush{position:relative;display:flex;flex-direction:column;align-items:center;filter:drop-shadow(0 16px 16px rgba(0,0,0,.38))}
    .plush .tag{margin-top:-30px;transform:rotate(-6deg);background:#fffdf7;border:2px solid #d9c9b6;border-radius:6px;padding:4px 10px;
      font-family:'Avenir Next','Helvetica Neue',Arial,sans-serif;font-size:12px;color:#5a3a46;display:flex;flex-direction:column;align-items:center}
    .plush .tag b{font-size:13px;letter-spacing:1px}
    .bowl{filter:drop-shadow(0 16px 16px rgba(0,0,0,.4))}`;
  return page(width, height, `<div class="scene">${t.html}</div>${stampHtml(width, height, s.code, stamp)}`, `brightness(${l.light}) ${t.filter}`, css);
}

// ---------------------------------------------------------------------------
// Line photo
// ---------------------------------------------------------------------------

const SKIN = ['#f1c7a5', '#e0ac85', '#c68b62', '#a8704b', '#f6d5bd', '#8d5a3a'];
const CLOTHES = ['#3f6fb5', '#c2453d', '#2f8f6b', '#e0a43a', '#6b4fa3', '#33363b', '#d9d4c7', '#8b5e3c', '#1f7a99', '#b5476f', '#56606a', '#e6e1d4'];
const HAIR = ['#1d1a17', '#3b2a1e', '#5a3d27', '#8a6a4a', '#2b2b2b', '#c9b38a'];

function person(x: number, y: number, s: number, rnd: () => number): string {
  const skin = SKIN[Math.floor(rnd() * SKIN.length)];
  const top = CLOTHES[Math.floor(rnd() * CLOTHES.length)];
  const pants = ['#2d3440', '#3a3a3a', '#4b5568', '#6d5b45', '#22303f'][Math.floor(rnd() * 5)];
  const hair = HAIR[Math.floor(rnd() * HAIR.length)];
  const bag = rnd() > 0.7;
  const phone = !bag && rnd() > 0.6;
  const h = 150 * s;
  const w = 46 * s;
  const head = 15 * s;
  return `<g>
    <rect x="${x - w * 0.32}" y="${y - h * 0.42}" width="${w * 0.26}" height="${h * 0.42}" rx="${4 * s}" fill="${pants}"/>
    <rect x="${x + w * 0.06}" y="${y - h * 0.42}" width="${w * 0.26}" height="${h * 0.42}" rx="${4 * s}" fill="${pants}"/>
    <rect x="${x - w / 2}" y="${y - h * 0.82}" width="${w}" height="${h * 0.44}" rx="${12 * s}" fill="${top}"/>
    ${bag ? `<rect x="${x + w * 0.38}" y="${y - h * 0.6}" width="${w * 0.42}" height="${h * 0.2}" rx="${4 * s}" fill="#7a5230"/>` : ''}
    ${phone ? `<rect x="${x - w * 0.12}" y="${y - h * 0.74}" width="${w * 0.22}" height="${h * 0.1}" rx="${2 * s}" fill="#151515"/>` : ''}
    <circle cx="${x}" cy="${y - h * 0.82 - head * 0.9}" r="${head}" fill="${skin}"/>
    <path d="M ${x - head} ${y - h * 0.82 - head * 0.9} a ${head} ${head} 0 0 1 ${head * 2} 0 z" fill="${hair}"/>
  </g>`;
}

export function lineHtml(s: LinePhotoSpec, tweak: Tweak | null = null, stamp: PhotoStamp | null = null): string {
  const { width, height } = SIZES.line;
  const rnd = seeded(s.seed);
  const facade = { cream: ['#efe2c6', '#d9c7a2'], brick: ['#a5533e', '#8a4231'], teal: ['#5c9a96', '#467d7a'] }[s.facade];
  const doorX = s.doorSide === 'right' ? 700 : 300;
  // The line runs from the door (far) toward the camera (near), curving slightly.
  const people: string[] = [];
  const n = s.people;
  for (let i = n - 1; i >= 0; i--) {
    const t = n <= 1 ? 1 : i / (n - 1);
    const depth = 1 - t;
    const scale = 0.26 + 0.74 * Math.pow(depth, 1.6);
    const y = 420 + 300 * Math.pow(depth, 1.25);
    const sway = Math.sin(i * 0.9 + s.seed) * 18 * scale;
    const x = doorX + (s.doorSide === 'right' ? -1 : 1) * (depth * 330) + sway;
    people.push(person(x, y, scale, rnd));
  }
  const windows = Array.from({ length: 5 }, (_, i) => `<rect x="${90 + i * 170}" y="40" width="110" height="80" rx="4" fill="#9fb8cc" stroke="${facade[1]}" stroke-width="6"/>`).join('');
  const front = s.shutter
    ? `<rect x="${doorX - 230}" y="230" width="460" height="200" fill="#9ea4aa"/>${Array.from({ length: 18 }, (_, i) => `<line x1="${doorX - 230}" x2="${doorX + 230}" y1="${236 + i * 11}" y2="${236 + i * 11}" stroke="#7d848b" stroke-width="3"/>`).join('')}`
    : `<rect x="${doorX - 230}" y="230" width="460" height="200" fill="#ffe2a8"/><rect x="${doorX - 60}" y="250" width="120" height="180" fill="#f2c779" stroke="#6b4a1f" stroke-width="6"/>
       <rect x="${doorX - 215}" y="250" width="135" height="120" fill="#ffd27f" stroke="#6b4a1f" stroke-width="5"/><rect x="${doorX + 80}" y="250" width="135" height="120" fill="#ffd27f" stroke="#6b4a1f" stroke-width="5"/>`;
  const svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fc0e8"/><stop offset="1" stop-color="#e6f1f8"/></linearGradient>
    <linearGradient id="walk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#b9b3a8"/><stop offset="1" stop-color="#d8d2c6"/></linearGradient></defs>
    <rect width="${width}" height="${height}" fill="url(#sky)"/>
    <rect x="0" y="0" width="${width}" height="440" fill="${facade[0]}"/>
    ${windows}
    <rect x="0" y="150" width="${width}" height="16" fill="${facade[1]}"/>
    <rect x="${doorX - 250}" y="170" width="500" height="52" rx="6" fill="#3a2a1a"/>
    <text x="${doorX}" y="208" text-anchor="middle" font-family="Georgia,'Times New Roman',serif" font-weight="700" font-size="34" fill="#f5c451" letter-spacing="3">${esc(s.storefront)}</text>
    ${front}
    <polygon points="0,430 ${width},430 ${width},${height} 0,${height}" fill="url(#walk)"/>
    ${Array.from({ length: 12 }, (_, i) => `<line x1="${(i * width) / 11}" y1="430" x2="${(i - 5.5) * 260 + width / 2}" y2="${height}" stroke="#a49d90" stroke-width="2"/>`).join('')}
    ${Array.from({ length: 6 }, (_, i) => `<line x1="0" x2="${width}" y1="${440 + i * i * 9}" y2="${440 + i * i * 9}" stroke="#a49d90" stroke-width="2"/>`).join('')}
    ${people.join('')}
  </svg>`;
  const look: PhotoLook = { background: 'linen', rotate: 0, tiltX: 0, tiltY: 0, x: 0, y: 0, scale: 1, light: s.light, lightFrom: s.doorSide === 'right' ? 'left' : 'right' };
  const scene = `<div style="position:absolute;inset:0">${svg}</div>${lightOverlay(look)}`;
  const t = tweakWrap(scene, tweak);
  return page(width, height, `<div class="scene">${t.html}</div>${stampHtml(width, height, s.code, stamp)}`, `brightness(${s.light}) ${t.filter}`);
}
