#!/usr/bin/env node
/**
 * Generates the default, original "critters" skin pack (CC0) into packs/critters/.
 * Every creature is drawn procedurally here on a 32x32 grid — no external art — so the pack can ship in the repo.
 *
 *   node tools/build-critters-pack.mjs [--out <dir>]
 *
 * Output: frames/<id>/frame-NNN.png (+ manifest.json), frames-shiny/<id>/..., gif/<id>.gif, gif-shiny/<id>.gif
 * (3x, for web views), art/<id>.png (4x), pack.json, LICENSE.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeGif, encodePng, hexToRgb, upscale } from './pixel-encode.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const outIdx = argv.indexOf('--out');
const OUT = resolve(outIdx !== -1 ? argv[outIdx + 1] : join(here, '..', 'packs', 'critters'));

const N = 32; // canvas size
const FRAMES = 16;
const DELAY_MS = 140;
const BOB = [0, 0, -1, -1, -1, -1, 0, 0, 0, 0, -1, -1, -1, -1, 0, 0];
const BLINK_FRAME = 12;

// Palette slots shared by every creature (index 0 = transparent).
const O = 1; // outline
const B = 2; // body
const S = 3; // body shade
const L = 4; // body light
const A = 5; // accent
const a = 6; // accent shade
const W = 7; // white
const K = 8; // eye / dark
const P = 9; // blush
const X = 10; // extra 1
const Y = 11; // extra 2
const Z = 12; // extra 3

// ---- raster helpers ---------------------------------------------------------------------------------
function canvas() {
  return new Uint8Array(N * N);
}
function set(cv, x, y, c) {
  x = Math.round(x);
  y = Math.round(y);
  if (x >= 0 && y >= 0 && x < N && y < N) cv[y * N + x] = c;
}
function get(cv, x, y) {
  return x >= 0 && y >= 0 && x < N && y < N ? cv[y * N + x] : 0;
}
/** Shaded ellipse: light spot top-left, shade bottom-right. `only` limits painting to pixels already in that set. */
function blob(cv, cx, cy, rx, ry, base, shade = base, light = 0, only = null) {
  for (let y = Math.floor(cy - ry - 1); y <= Math.ceil(cy + ry + 1); y++) {
    for (let x = Math.floor(cx - rx - 1); x <= Math.ceil(cx + rx + 1); x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = nx * nx + ny * ny;
      if (d > 1) continue;
      if (only && !only.includes(get(cv, x, y))) continue;
      let c = base;
      if (nx * 0.45 + ny * 0.85 > 0.48 && d > 0.3) c = shade;
      const lx = nx + 0.4;
      const ly = ny + 0.45;
      if (light && lx * lx + ly * ly < 0.06) c = light;
      set(cv, x, y, c);
    }
  }
}
function rect(cv, x0, y0, x1, y1, c) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(cv, x, y, c);
}
function tri(cv, p1, p2, p3, c) {
  const xs = [p1[0], p2[0], p3[0]];
  const ys = [p1[1], p2[1], p3[1]];
  const sgn = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
    for (let x = Math.floor(Math.min(...xs)); x <= Math.ceil(Math.max(...xs)); x++) {
      const pt = [x + 0.5, y + 0.5];
      const d1 = sgn(pt, p1, p2);
      const d2 = sgn(pt, p2, p3);
      const d3 = sgn(pt, p3, p1);
      const neg = d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d1 > 0 || d2 > 0 || d3 > 0;
      if (!(neg && pos)) set(cv, x, y, c);
    }
  }
}
/** 2x3 eye with a white glint; a closed eye is a 2x1 line. */
function eye(cv, x, y, blink, dark = K) {
  if (blink) {
    rect(cv, x, y + 2, x + 1, y + 2, dark);
    return;
  }
  rect(cv, x, y, x + 1, y + 2, dark);
  set(cv, x, y, W);
}
/** Dark-outline every transparent pixel that touches the sprite (4-neighbourhood). */
function outline(cv) {
  const src = cv.slice();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (src[y * N + x]) continue;
      if (get(src, x - 1, y) || get(src, x + 1, y) || get(src, x, y - 1) || get(src, x, y + 1)) cv[y * N + x] = O;
    }
  }
}
function sparkle(cv, x, y, c) {
  set(cv, x, y, c);
  set(cv, x - 1, y, c);
  set(cv, x + 1, y, c);
  set(cv, x, y - 1, c);
  set(cv, x, y + 1, c);
}

// ---- the creatures ------------------------------------------------------------------------------------
// palette: slot -> hex; shiny: slot -> hex (real shiny art is rendered from it, and pack.json lists it as a palette).
const CREATURES = [
  {
    id: 'sprout', name: '芽芽', rarity: 'N', weight: 26, scale: 0.86, color: '#5FBF5A',
    cheer: '🌱 芽芽冒头啦！', spark: '🌱', match: { keywords: ['sprite', 'art', 'asset'] },
    palette: { [O]: '#2B3A2A', [B]: '#F4E9C8', [S]: '#D9C38F', [L]: '#FFFBEA', [A]: '#5FBF5A', [a]: '#3E8E45', [W]: '#FFFFFF', [K]: '#2A2233', [P]: '#F2A0A0' },
    shiny: { [A]: '#E8A33D', [a]: '#B5701F', [B]: '#EAF1FF', [S]: '#B7C6E6', [L]: '#FFFFFF' },
    draw(cv, f, y, blink) {
      const sway = f % 8 < 4 ? 0 : 1;
      blob(cv, 11.5, 28.6, 2.6, 1.4, S);
      blob(cv, 20.5, 28.6, 2.6, 1.4, S);
      rect(cv, 16, 10 + y, 16, 13 + y, a);
      blob(cv, 12 - sway, 10.5 + y, 4.2, 2.1, A, a);
      blob(cv, 20.5 - sway, 9.5 + y, 4.2, 2.1, A, a);
      blob(cv, 16, 21 + y, 9.6, 7.8, B, S, L);
      eye(cv, 12, 19 + y, blink);
      eye(cv, 19, 19 + y, blink);
      rect(cv, 9, 23 + y, 10, 23 + y, P);
      rect(cv, 22, 23 + y, 23, 23 + y, P);
      rect(cv, 15, 24 + y, 16, 24 + y, O);
    }
  },
  {
    id: 'mochi', name: '团子', rarity: 'N', weight: 24, scale: 0.86, color: '#FF7FA8',
    cheer: '🍡 软软团子，弹弹弹！', spark: '🌸', match: { keywords: ['scout', 'research'] },
    palette: { [O]: '#4A2E3A', [B]: '#FFE6EE', [S]: '#F2B6C8', [L]: '#FFFFFF', [A]: '#FF7FA8', [a]: '#D94F7E', [W]: '#FFFFFF', [K]: '#3A2430', [P]: '#FF9DB8', [X]: '#FFD447' },
    shiny: { [B]: '#E2F7EC', [S]: '#A6DCC0', [A]: '#7FB6FF', [a]: '#4F7FD9', [P]: '#9FE0C4' },
    draw(cv, f, _y, blink) {
      const squash = f % 8 >= 2 && f % 8 <= 5;
      const rx = squash ? 11.8 : 11;
      const ry = squash ? 6.8 : 7.6;
      const cy = 29.4 - ry;
      blob(cv, 9.5, cy - ry + 2.2, 2.6, 2.2, B, S);
      blob(cv, 22.5, cy - ry + 2.2, 2.6, 2.2, B, S);
      blob(cv, 16, cy, rx, ry, B, S, L);
      const fy = Math.round(cy - ry);
      set(cv, 16, fy - 2, A);
      set(cv, 15, fy - 1, A);
      set(cv, 17, fy - 1, A);
      set(cv, 16, fy, a);
      set(cv, 16, fy - 1, X);
      const ey = Math.round(cy) - 1;
      if (blink) {
        rect(cv, 11, ey + 1, 12, ey + 1, K);
        rect(cv, 19, ey + 1, 20, ey + 1, K);
      } else {
        rect(cv, 11, ey, 12, ey + 1, K);
        rect(cv, 19, ey, 20, ey + 1, K);
        set(cv, 11, ey, W);
        set(cv, 19, ey, W);
      }
      rect(cv, 8, ey + 3, 9, ey + 3, P);
      rect(cv, 22, ey + 3, 23, ey + 3, P);
      set(cv, 15, ey + 3, O);
      set(cv, 16, ey + 3, O);
    }
  },
  {
    id: 'cog', name: '齿轮', rarity: 'R', weight: 16, scale: 0.9, color: '#5EF2FF',
    cheer: '📡 信号满格，全员集合！', spark: '⚙', match: { coordinator: true },
    palette: { [O]: '#1B2433', [B]: '#9DBBDD', [S]: '#5F84AD', [L]: '#D6E6F7', [A]: '#5EF2FF', [a]: '#2BB5C9', [W]: '#FFFFFF', [K]: '#1D2B3A', [X]: '#FF5A5A', [Y]: '#A82A3A' },
    shiny: { [B]: '#E8C35A', [S]: '#B08E2E', [L]: '#FFF0B8', [A]: '#FF7AE0', [a]: '#C946AA' },
    draw(cv, f, y, blink) {
      // legs + body stay on the ground, the head bobs
      rect(cv, 12, 27, 14, 29, S);
      rect(cv, 18, 27, 20, 29, S);
      rect(cv, 11, 22, 21, 26, B);
      rect(cv, 11, 25, 21, 26, S);
      rect(cv, 12, 22, 13, 23, L);
      rect(cv, 15, 23, 17, 24, A);
      rect(cv, 8, 23, 9, 25, S);
      rect(cv, 23, 23, 24, 25, S);
      // head: rounded box
      rect(cv, 8, 10 + y, 24, 21 + y, B);
      rect(cv, 8, 19 + y, 24, 21 + y, S);
      rect(cv, 9, 10 + y, 12, 11 + y, L);
      set(cv, 8, 10 + y, 0);
      set(cv, 24, 10 + y, 0);
      set(cv, 8, 21 + y, 0);
      set(cv, 24, 21 + y, 0);
      rect(cv, 10, 12 + y, 22, 19 + y, K);
      if (blink) {
        rect(cv, 12, 15 + y, 14, 15 + y, A);
        rect(cv, 18, 15 + y, 20, 15 + y, A);
      } else {
        rect(cv, 12, 13 + y, 14, 15 + y, A);
        rect(cv, 18, 13 + y, 20, 15 + y, A);
        set(cv, 12, 13 + y, W);
        set(cv, 18, 13 + y, W);
      }
      set(cv, 14, 17 + y, a);
      rect(cv, 15, 18 + y, 17, 18 + y, a);
      set(cv, 18, 17 + y, a);
      rect(cv, 16, 6 + y, 16, 9 + y, S);
      blob(cv, 16.5, 5.2 + y, 1.7, 1.7, f % 4 < 2 ? X : Y);
      rect(cv, 6, 14 + y, 7, 17 + y, S);
      rect(cv, 25, 14 + y, 26, 17 + y, S);
    }
  },
  {
    id: 'inky', name: '墨墨', rarity: 'R', weight: 14, scale: 0.92, color: '#8E6BD8',
    cheer: '🎨 墨墨给你换个配色！', spark: '🎨', match: { keywords: ['theme', 'css', 'ui', 'refactor'] },
    palette: { [O]: '#2A1E45', [B]: '#9677E0', [S]: '#6347A8', [L]: '#C9B8F5', [A]: '#49D3C6', [a]: '#2A9E93', [W]: '#FFFFFF', [K]: '#1E1530', [P]: '#F29DC4' },
    shiny: { [B]: '#46AEDD', [S]: '#2774A0', [L]: '#A8E2FA', [A]: '#FF9F43', [a]: '#D9741A' },
    draw(cv, f, y, blink) {
      [9, 13, 19, 23].forEach((x, i) => {
        const wig = (f + i * 2) % 8 < 4 ? 0 : 1;
        blob(cv, x + 0.5, 24.5 + y + wig, 2.3, 3.4, B, S);
      });
      blob(cv, 16, 15 + y, 9.6, 8.6, B, S, L);
      blob(cv, 18.5, 7 + y, 6.2, 2.3, A, a);
      set(cv, 18, 4 + y, a);
      set(cv, 18, 5 + y, a);
      eye(cv, 12, 14 + y, blink);
      eye(cv, 19, 14 + y, blink);
      set(cv, 10, 18 + y, P);
      set(cv, 22, 18 + y, P);
      set(cv, 15, 19 + y, O);
      set(cv, 16, 20 + y, O);
      set(cv, 17, 19 + y, O);
    }
  },
  {
    id: 'lumo', name: '灯灯', rarity: 'SR', weight: 9, scale: 0.92, color: '#FFE066',
    cheer: '💡 灯灯照亮每一个 bug！', spark: '✨', match: { keywords: ['verif', 'test', 'qa'] },
    palette: { [O]: '#1E2240', [B]: '#3B4A80', [S]: '#26305A', [L]: '#6F82C2', [A]: '#FFE066', [a]: '#F2B530', [W]: '#FFFFFF', [K]: '#141830', [X]: '#CDE8FF', [Y]: '#FFF8CC' },
    shiny: { [A]: '#FF8FD8', [a]: '#D9579F', [Y]: '#FFE0F4', [B]: '#5E3A7A', [S]: '#3E2454', [L]: '#9A6CC0' },
    draw(cv, f, y, blink) {
      const flap = f % 4 < 2;
      blob(cv, 11.5, 9.5 + y, 4.2, flap ? 3.2 : 2.2, X);
      blob(cv, 18, 8.5 + y, 4.2, flap ? 3.2 : 2.2, X);
      const glow = f % 8 < 4 ? 5.6 : 5.2;
      blob(cv, 22, 20 + y, glow, glow, A, a, Y);
      blob(cv, 13, 17 + y, 6.6, 5.6, B, S, L);
      set(cv, 9, 11 + y, O);
      set(cv, 8, 10 + y, O);
      set(cv, 13, 11 + y, O);
      set(cv, 13, 10 + y, O);
      for (const ex of [9, 14]) {
        if (blink) rect(cv, ex, 18 + y, ex + 1, 18 + y, W);
        else {
          rect(cv, ex, 16 + y, ex + 1, 18 + y, W);
          rect(cv, ex + 1, 17 + y, ex + 1, 18 + y, K);
        }
      }
      rect(cv, 11, 20 + y, 12, 20 + y, L);
      for (const lx of [10, 13, 16]) rect(cv, lx, 23 + y, lx, 24 + y, S);
      if (f % 8 < 4) {
        set(cv, 28, 15 + y, Y);
        set(cv, 27, 26 + y, Y);
      } else {
        set(cv, 29, 19 + y, Y);
        set(cv, 25, 13 + y, Y);
      }
    }
  },
  {
    id: 'pebble', name: '岩岩', rarity: 'SR', weight: 8, scale: 0.95, color: '#9AA0A6',
    cheer: '🪨 稳如岩岩，提交！', spark: '💎', match: { keywords: ['pet', 'overlay', 'desktop', 'commit'] },
    palette: { [O]: '#262A30', [B]: '#9AA0A6', [S]: '#6E747A', [L]: '#C8CDD2', [A]: '#7CC46B', [a]: '#4E8F43', [W]: '#FFFFFF', [K]: '#1F2228', [X]: '#7FD4FF', [Y]: '#D8F3FF' },
    shiny: { [B]: '#D6A86A', [S]: '#A97B43', [L]: '#F0CF9A', [X]: '#FF6B8A', [Y]: '#FFD3DD' },
    draw(cv, f, y, blink) {
      rect(cv, 9, 27, 13, 29, S);
      rect(cv, 19, 27, 23, 29, S);
      const shine = f % 8 < 2;
      tri(cv, [21, 13 + y], [25.5, 5 + y], [27.5, 15 + y], X);
      tri(cv, [23.5, 9 + y], [25.5, 5 + y], [25, 12 + y], shine ? W : Y);
      blob(cv, 13, 15.5 + y, 6.4, 4.6, B, S, L);
      blob(cv, 16, 21 + y, 11.2, 7.8, B, S, L);
      blob(cv, 13.5, 11.8 + y, 5.2, 1.7, A, a);
      set(cv, 9, 13 + y, A);
      set(cv, 17, 13 + y, a);
      set(cv, 24, 22 + y, S);
      set(cv, 25, 23 + y, S);
      set(cv, 24, 24 + y, S);
      set(cv, 7, 19 + y, S);
      set(cv, 8, 20 + y, S);
      rect(cv, 10, 18 + y, 12, 18 + y, S);
      rect(cv, 18, 18 + y, 20, 18 + y, S);
      eye(cv, 11, 19 + y, blink);
      eye(cv, 18, 19 + y, blink);
      rect(cv, 14, 24 + y, 16, 24 + y, O);
    }
  },
  {
    id: 'astra', name: '星鲸', rarity: 'SSR', weight: 3, scale: 1.0, color: '#4C72D6',
    cheer: '🐋 星鲸领航，全速前进！', spark: '⭐', match: { lead: true, keywords: ['astra'] },
    palette: { [O]: '#121B3D', [B]: '#2D4BA0', [S]: '#1E3270', [L]: '#5A82E0', [A]: '#FFE27A', [a]: '#E0B23A', [W]: '#FFFFFF', [K]: '#0B1128', [P]: '#7F9CF0', [X]: '#B5CBFF' },
    shiny: { [B]: '#6A2DA0', [S]: '#461E70', [L]: '#A066DA', [X]: '#F2C4FF', [A]: '#7AF0FF', [a]: '#3AB8D0', [P]: '#C58CF0' },
    draw(cv, f, y, blink) {
      const flick = f % 8 < 4 ? 0 : 1;
      tri(cv, [24, 17 + y], [30, 10 + y + flick], [29, 18 + y], S);
      tri(cv, [24, 18 + y], [29, 18 + y], [30, 25 + y - flick], S);
      blob(cv, 14.5, 18 + y, 12, 7.4, B, S, L);
      blob(cv, 13.5, 22.2 + y, 9.5, 3.4, X, X, 0, [B, S, L]);
      blob(cv, 14, 26 + y, 3.4, 1.6, S);
      [[13, 14], [17, 13], [20, 16], [16, 17], [10, 13]].forEach(([sx, sy], i) => {
        set(cv, sx, sy + y, (f + i) % 6 === 0 ? W : A);
      });
      set(cv, 21, 21 + y, P);
      set(cv, 23, 20 + y, P);
      if (blink) rect(cv, 6, 17 + y, 7, 17 + y, K);
      else {
        rect(cv, 6, 16 + y, 7, 17 + y, K);
        set(cv, 6, 16 + y, W);
      }
      rect(cv, 4, 20 + y, 8, 20 + y, S);
      set(cv, 9, 19 + y, S);
      for (let k = 0; k < 2; k++) {
        const t = (f + k * 8) % 16;
        const sy = 9 - Math.floor(t / 2);
        if (sy >= 1) sparkle(cv, 9 + k * 3 - (t % 4 < 2 ? 0 : 1), sy + y, t < 8 ? A : a);
      }
    }
  }
];

// ---- render ---------------------------------------------------------------------------------------------
function renderFrames(c) {
  const frames = [];
  for (let f = 0; f < FRAMES; f++) {
    const cv = canvas();
    c.draw(cv, f, BOB[f], f === BLINK_FRAME);
    outline(cv);
    frames.push(cv);
  }
  return frames;
}

function paletteArray(slots) {
  const pal = [[0, 0, 0]];
  for (let i = 1; i <= Z; i++) pal.push(hexToRgb(slots[i] || '#000000'));
  return pal;
}

function rgbToHsl([r, g, b]) {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}

/** CSS-filter approximation of the shiny palette (only used where real shiny art is unavailable). */
function approxHsl(normal, shiny) {
  const [h1, s1, l1] = rgbToHsl(hexToRgb(normal));
  const [h2, s2, l2] = rgbToHsl(hexToRgb(shiny));
  let dh = h2 - h1;
  if (dh > 180) dh -= 360;
  if (dh < -180) dh += 360;
  const r2 = (v) => Math.round(v * 100) / 100;
  return { hue: Math.round(dh), saturation: r2(s1 > 0.02 ? s2 / s1 : 1), lightness: r2(l1 > 0.02 ? l2 / l1 : 1) };
}

function write(rel, data) {
  const p = join(OUT, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, data);
}

rmSync(OUT, { recursive: true, force: true });
const delays = new Array(FRAMES).fill(DELAY_MS);
const packCreatures = [];
CREATURES.forEach((c, i) => {
  const frames = renderFrames(c);
  for (const [variant, slots] of [['', c.palette], ['-shiny', { ...c.palette, ...c.shiny }]]) {
    const pal = paletteArray(slots);
    frames.forEach((fr, n) => write(`frames${variant}/${c.id}/frame-${String(n).padStart(3, '0')}.png`, encodePng(N, N, fr, pal)));
    write(`frames${variant}/${c.id}/manifest.json`, JSON.stringify({ width: N, height: N, frameCount: FRAMES, frameDelaysMs: delays }, null, 1) + '\n');
    write(`gif${variant}/${c.id}.gif`, encodeGif(N * 3, N * 3, frames.map((fr) => upscale(fr, N, N, 3)), pal, delays));
    if (!variant) write(`art/${c.id}.png`, encodePng(N * 4, N * 4, upscale(frames[0], N, N, 4), pal));
  }
  const paletteSwap = {};
  for (const [slot, hex] of Object.entries(c.shiny)) paletteSwap[c.palette[slot]] = hex;
  packCreatures.push({
    id: c.id,
    name: c.name,
    dexNo: i + 1,
    rarity: c.rarity,
    weight: c.weight,
    scale: c.scale,
    color: c.color,
    cheer: c.cheer,
    spark: c.spark,
    match: c.match,
    shiny: { palette: paletteSwap, tolerance: 6, ...approxHsl(c.palette[B], c.shiny[B] || c.palette[B]) }
  });
});

const pack = {
  schema: 1,
  id: 'critters',
  name: '像素小伙伴',
  version: '1.0.0',
  author: 'Antigravity Pets contributors',
  license: 'CC0-1.0',
  description: '项目原创的默认皮肤包：7 只像素小伙伴，带真·闪光配色。由 tools/build-critters-pack.mjs 生成。',
  defaultStyle: 'pixel',
  styles: {
    pixel: { label: '像素', gif: 'gif/{id}.gif', frames: 'frames/{id}', shinyGif: 'gif-shiny/{id}.gif', shinyFrames: 'frames-shiny/{id}', pixelated: true }
  },
  artwork: 'art/{id}.png',
  creatures: packCreatures
};
write('pack.json', JSON.stringify(pack, null, 2) + '\n');
write(
  'LICENSE',
  `像素小伙伴 / Pixel Critters — default skin pack

To the extent possible under law, the Antigravity Pets contributors have waived all copyright and related or
neighboring rights to the artwork in this folder (CC0 1.0 Universal):
https://creativecommons.org/publicdomain/zero/1.0/

The sprites are drawn procedurally by tools/build-critters-pack.mjs and contain no third-party artwork.
`
);
console.log(`ok: ${CREATURES.length} creatures -> ${OUT}`);
