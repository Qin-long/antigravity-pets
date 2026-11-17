/**
 * Pet skin packs ("皮肤包").
 *
 * A pack is a folder with a `pack.json` plus its sprites. The bridge discovers packs in:
 *   1. `<suite>/packs/<id>/`                         (packs shipped with the repo — original / CC0 art only)
 *   2. `~/.gemini/antigravity/pet-packs/<id>/`       (user-installed / private packs; wins on id clash)
 *   3. extra dirs from `POKEMON_PACK_DIRS` (path-delimited list of pack folders or folders of packs)
 *
 * pack.json (schema 1):
 * {
 *   "schema": 1, "id": "pokemon", "name": "宝可梦", "version": "1.0.0",
 *   "author": "...", "license": "...", "private": true, "description": "...",
 *   "defaultStyle": "showdown",
 *   "styles": {
 *     "showdown": { "label": "3D 动态", "gif": "showdown/{id}.gif", "frames": "frames/{id}",
 *                   "shinyGif": "showdown-shiny/{id}.gif", "shinyFrames": "frames-shiny/{id}" },
 *     "pixel":    { "label": "像素", "gif": "pixel/{id}.gif", "frames": "frames-pixel/{id}", "pixelated": true }
 *   },
 *   "artwork": "artwork/{id}.png",
 *   "creatures": [
 *     { "id": "pikachu", "name": "皮卡丘", "short": "皮卡丘", "dexNo": 25, "rarity": "N", "weight": 24,
 *       "scale": 0.86, "color": "#FFD43B", "cheer": "celebration bubble text", "spark": "⚡",
 *       "match": { "lead": false, "coordinator": false, "keywords": ["scout", "research"] },
 *       "shiny": { "hue": -14, "saturation": 1.08, "lightness": 1.0 }      // or
 *       "shiny": { "palette": { "#F8D030": "#F8A030" }, "tolerance": 24 }   // exact colour swap (+ optional hue for the web)
 *     }
 *   ]
 * }
 *
 * `frames` folders hold `frame-000.png ...` and optionally a `manifest.json` with `frameDelaysMs`.
 * Shiny look, best first: real shiny art (shinyGif / shinyFrames on disk) -> palette swap -> HSL shift.
 * Every path in pack.json is relative to the pack folder and may not leave it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, normalize, relative, resolve } from 'node:path';

export const PACK_SCHEMA = 1;
export const RARITY_IDS = ['N', 'R', 'SR', 'SSR'];
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;
const RESCAN_MS = 5000;

export const USER_PACKS_DIR = join(homedir(), '.gemini', 'antigravity', 'pet-packs');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

function num(v, fallback, min = -Infinity, max = Infinity) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Resolve a pack-relative path; returns null if it escapes the pack root or touches dot-folders. */
export function safePackPath(rootDir, relPath) {
  const relIn = String(relPath || '').replace(/\\/g, '/');
  if (!relIn || isAbsolute(relIn) || relIn.split('/').some((seg) => seg === '..' || seg.startsWith('.'))) return null;
  const abs = resolve(rootDir, normalize(relIn));
  const rel = relative(rootDir, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

/** Display text from a (possibly third-party) pack: no markup characters, bounded length. */
function cleanText(v, max = 80) {
  return String(v ?? '').replace(/[<>&"'`\x00-\x1f]/g, '').trim().slice(0, max);
}

function fill(template, id) {
  return template ? String(template).split('{id}').join(id) : '';
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function listFrames(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => /^frame-\d+\.png$/i.test(f))
      .sort();
  } catch {
    return [];
  }
}

function frameDelays(dir, count) {
  let delays = [];
  try {
    const m = readJson(join(dir, 'manifest.json'));
    if (Array.isArray(m?.frameDelaysMs)) delays = m.frameDelaysMs.map((d) => Number(d));
  } catch {
    // no per-folder manifest
  }
  const out = [];
  for (let i = 0; i < count; i++) out.push(Number.isFinite(delays[i]) && delays[i] >= 15 ? delays[i] : 50);
  return out;
}

function normalizeShiny(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const palette = {};
  if (s.palette && typeof s.palette === 'object') {
    for (const [from, to] of Object.entries(s.palette)) {
      if (HEX_RE.test(from) && HEX_RE.test(String(to))) {
        palette[`#${from.replace('#', '').toUpperCase()}`] = `#${String(to).replace('#', '').toUpperCase()}`;
      }
    }
  }
  return {
    hue: num(s.hue, Object.keys(palette).length ? 0 : 180, -360, 360),
    saturation: num(s.saturation, 1, 0, 4),
    lightness: num(s.lightness, 1, 0.1, 3),
    palette,
    tolerance: num(s.tolerance, 24, 0, 128)
  };
}

/** Validate + normalize one pack folder. Returns { pack } or { error }. */
export function loadPackDir(rootDir, source = 'user') {
  const file = join(rootDir, 'pack.json');
  let raw;
  try {
    raw = readJson(file);
  } catch (err) {
    return { error: `pack.json unreadable: ${err.message}` };
  }
  if (!raw || typeof raw !== 'object') return { error: 'pack.json is not an object' };
  if (Number(raw.schema) !== PACK_SCHEMA) return { error: `unsupported schema ${raw.schema}` };
  const id = String(raw.id || '').trim().toLowerCase();
  if (!ID_RE.test(id)) return { error: `invalid pack id "${raw.id}"` };

  const stylesIn = raw.styles && typeof raw.styles === 'object' ? raw.styles : {};
  const styleIds = Object.keys(stylesIn).filter((k) => ID_RE.test(k));
  if (!styleIds.length) return { error: 'pack has no styles' };
  const styles = {};
  for (const sid of styleIds) {
    const s = stylesIn[sid] || {};
    styles[sid] = {
      id: sid,
      label: cleanText(s.label || sid, 20) || sid,
      pixelated: Boolean(s.pixelated),
      gif: s.gif ? String(s.gif) : '',
      frames: s.frames ? String(s.frames) : '',
      shinyGif: s.shinyGif ? String(s.shinyGif) : '',
      shinyFrames: s.shinyFrames ? String(s.shinyFrames) : ''
    };
  }
  const defaultStyle = styles[raw.defaultStyle] ? raw.defaultStyle : styleIds[0];

  const creatures = [];
  const seen = new Set();
  const errors = [];
  for (const c of Array.isArray(raw.creatures) ? raw.creatures : []) {
    const cid = String(c?.id || '').trim().toLowerCase();
    if (!ID_RE.test(cid) || seen.has(cid)) {
      errors.push(`skipped creature "${c?.id}"`);
      continue;
    }
    seen.add(cid);
    const rarity = RARITY_IDS.includes(String(c.rarity)) ? String(c.rarity) : 'N';
    const match = c.match && typeof c.match === 'object' ? c.match : {};
    const assets = {};
    for (const sid of styleIds) {
      const st = styles[sid];
      const resolveRel = (tpl, kind) => {
        const rel = fill(tpl, cid);
        if (!rel) return null;
        const abs = safePackPath(rootDir, rel);
        if (!abs) return null;
        if (kind === 'file') {
          if (isFile(abs)) return { rel: rel.replace(/\\/g, '/'), abs };
          if (/\.gif$/i.test(rel)) {
            const pngRel = rel.replace(/\.gif$/i, '.png');
            const pngAbs = safePackPath(rootDir, pngRel);
            if (pngAbs && isFile(pngAbs)) return { rel: pngRel.replace(/\\/g, '/'), abs: pngAbs };
          }
          return null;
        }
        const frames = listFrames(abs);
        return frames.length ? { rel: rel.replace(/\\/g, '/'), abs, frames, delays: frameDelays(abs, frames.length) } : null;
      };
      assets[sid] = {
        gif: resolveRel(st.gif, 'file'),
        frames: resolveRel(st.frames, 'dir'),
        shinyGif: resolveRel(st.shinyGif, 'file'),
        shinyFrames: resolveRel(st.shinyFrames, 'dir')
      };
    }
    const artRel = fill(raw.artwork, cid);
    const artAbs = artRel ? safePackPath(rootDir, artRel) : null;
    creatures.push({
      id: cid,
      name: cleanText(c.name || cid, 40) || cid,
      short: cleanText(c.short || c.name || cid, 20) || cid,
      dexNo: Number.isFinite(Number(c.dexNo)) ? Number(c.dexNo) : creatures.length + 1,
      rarity,
      weight: num(c.weight, 10, 0, 100000),
      scale: num(c.scale, 1, 0.3, 2),
      color: HEX_RE.test(String(c.color || '')) ? `#${String(c.color).replace('#', '').toUpperCase()}` : '#94A3B8',
      cheer: cleanText(c.cheer, 60),
      spark: [...cleanText(c.spark, 8)].slice(0, 2).join(''),
      match: {
        lead: Boolean(match.lead),
        coordinator: Boolean(match.coordinator),
        keywords: Array.isArray(match.keywords) ? match.keywords.map((k) => String(k).toLowerCase()).filter(Boolean) : []
      },
      shiny: normalizeShiny(c.shiny),
      assets,
      artwork: artAbs && isFile(artAbs) ? { rel: artRel.replace(/\\/g, '/'), abs: artAbs } : null
    });
  }
  const drawable = creatures.filter((c) => c.weight > 0 && Object.values(c.assets).some((a) => a.gif || a.frames));
  if (!drawable.length) return { error: 'pack has no creature with sprites and weight > 0' };

  return {
    pack: {
      id,
      name: cleanText(raw.name || id, 60) || id,
      version: cleanText(raw.version || '0.0.0', 20),
      author: cleanText(raw.author, 80),
      license: cleanText(raw.license, 160),
      description: cleanText(raw.description, 300),
      private: Boolean(raw.private),
      source,
      rootDir,
      defaultStyle,
      styles,
      creatures,
      warnings: errors
    }
  };
}

function candidateDirs(builtinDir, extraDirs) {
  const out = [];
  const addParent = (parent, source) => {
    try {
      for (const name of readdirSync(parent)) {
        if (name.startsWith('.')) continue;
        const d = join(parent, name);
        if (existsSync(join(d, 'pack.json'))) out.push({ dir: d, source });
      }
    } catch {
      // folder missing
    }
  };
  if (builtinDir) addParent(builtinDir, 'builtin');
  addParent(USER_PACKS_DIR, 'user');
  for (const d of extraDirs) {
    if (existsSync(join(d, 'pack.json'))) out.push({ dir: d, source: 'env' });
    else addParent(d, 'env');
  }
  return out;
}

/** Deterministic, role-aware pick inside a pack (used for silent bootstrap + when gacha is off). */
export function assignCreature(pack, { id = '', name = '', role = '', isLead = false } = {}) {
  const list = pack.creatures.filter((c) => c.weight > 0);
  const lowerName = String(name || '').toLowerCase();
  const lowerRole = String(role || '').toLowerCase();
  if (lowerName === 'coordinator' || lowerRole === 'coordinator') {
    const c = list.find((x) => x.match.coordinator);
    if (c) return c.id;
  }
  const leadish =
    isLead ||
    lowerRole === 'main-agent' ||
    ['monitor', 'planner', 'architect', 'master', 'lead'].some((k) => lowerName.includes(k));
  if (leadish) {
    const c = list.find((x) => x.match.lead);
    if (c) return c.id;
  }
  for (const c of list) {
    if (c.match.keywords.some((k) => lowerName.includes(k))) return c.id;
  }
  const seed = `${name || id}`;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return list[hash % list.length].id;
}

/**
 * Public, JSON-safe description of a pack. `baseUrl` prefixes asset URLs (e.g. `/packs/pokemon/`).
 * `withPaths` adds absolute folders for native clients (the WPF overlay reads frames straight from disk).
 */
export function describePack(pack, { baseUrl = `/packs/${pack.id}/`, withPaths = false, rarityMeta = null } = {}) {
  const totalWeight = pack.creatures.reduce((s, c) => s + c.weight, 0) || 1;
  const url = (a) => (a ? baseUrl + a.rel.split('/').map(encodeURIComponent).join('/') : null);
  return {
    schema: PACK_SCHEMA,
    id: pack.id,
    name: pack.name,
    version: pack.version,
    author: pack.author,
    license: pack.license,
    description: pack.description,
    private: pack.private,
    source: pack.source,
    baseUrl,
    ...(withPaths ? { rootDir: pack.rootDir } : {}),
    defaultStyle: pack.defaultStyle,
    styles: Object.values(pack.styles).map((s) => ({ id: s.id, label: s.label, pixelated: s.pixelated })),
    rarity: rarityMeta || undefined,
    creatures: pack.creatures.map((c) => {
      const assets = {};
      for (const [sid, a] of Object.entries(c.assets)) {
        const shinyMode = a.shinyGif || a.shinyFrames ? 'art' : Object.keys(c.shiny.palette).length ? 'palette' : 'hsl';
        assets[sid] = {
          gif: url(a.gif),
          shinyGif: url(a.shinyGif),
          frameCount: a.frames ? a.frames.frames.length : 0,
          frameUrls: a.frames ? a.frames.frames.map((f) => url({ rel: `${a.frames.rel}/${f}` })) : [],
          frameDelaysMs: a.frames ? a.frames.delays : [],
          shinyFrameUrls: a.shinyFrames ? a.shinyFrames.frames.map((f) => url({ rel: `${a.shinyFrames.rel}/${f}` })) : [],
          shinyMode,
          ...(withPaths
            ? {
                framesDir: a.frames ? a.frames.abs : null,
                shinyFramesDir: a.shinyFrames ? a.shinyFrames.abs : null,
                gifPath: a.gif ? a.gif.abs : null
              }
            : {})
        };
      }
      return {
        id: c.id,
        name: c.name,
        short: c.short,
        dexNo: c.dexNo,
        rarity: c.rarity,
        weight: c.weight,
        pct: Math.round((c.weight / totalWeight) * 1000) / 10,
        scale: c.scale,
        color: c.color,
        cheer: c.cheer,
        spark: c.spark,
        shiny: {
          hue: c.shiny.hue,
          saturation: c.shiny.saturation,
          lightness: c.shiny.lightness,
          palette: c.shiny.palette,
          tolerance: c.shiny.tolerance,
          // Ready-made CSS approximation for web views (exact art / palette swaps are preferred where possible).
          cssFilter: `hue-rotate(${c.shiny.hue}deg) saturate(${c.shiny.saturation}) brightness(${c.shiny.lightness})`
        },
        artwork: url(c.artwork),
        ...(withPaths ? { artworkPath: c.artwork ? c.artwork.abs : null } : {}),
        assets
      };
    })
  };
}

/** Pack registry with lazy rescans (cheap: one readdir per source every few seconds at most). */
export function createPackRegistry({ builtinDir, extraDirs = String(process.env.POKEMON_PACK_DIRS || '').split(delimiter).filter(Boolean), preferredDefault = ['pokemon', 'critters'] } = {}) {
  let packs = new Map();
  let problems = [];
  let scannedAtMs = 0;
  let signature = '';

  function scan(force = false) {
    const nowMs = Date.now();
    if (!force && nowMs - scannedAtMs < RESCAN_MS) return;
    scannedAtMs = nowMs;
    const dirs = candidateDirs(builtinDir, extraDirs);
    const sig = dirs
      .map(({ dir }) => {
        try {
          return `${dir}@${statSync(join(dir, 'pack.json')).mtimeMs}`;
        } catch {
          return dir;
        }
      })
      .join('|');
    if (!force && sig === signature) return;
    signature = sig;
    const next = new Map();
    const probs = [];
    for (const { dir, source } of dirs) {
      const { pack, error } = loadPackDir(dir, source);
      if (error) {
        probs.push({ dir, error });
        continue;
      }
      next.set(pack.id, pack); // later sources (user, env) override built-ins
      for (const w of pack.warnings) probs.push({ dir, error: w });
    }
    packs = next;
    problems = probs;
  }

  function list() {
    scan();
    return [...packs.values()];
  }

  function get(id) {
    scan();
    return packs.get(String(id || '').toLowerCase()) || null;
  }

  function defaultId() {
    scan();
    for (const id of preferredDefault) if (packs.has(id)) return id;
    return packs.keys().next().value || null;
  }

  /** The pack to use for `wantedId`, falling back to the default pack. */
  function resolveActive(wantedId) {
    return get(wantedId) || get(defaultId());
  }

  return {
    scan,
    list,
    get,
    defaultId,
    resolveActive,
    get problems() {
      scan();
      return problems.slice();
    }
  };
}
