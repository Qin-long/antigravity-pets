#!/usr/bin/env node
/**
 * Build a compact, full-generation (Gen 1–9, #1..#1025) private Pokémon pack
 * at `~/.gemini/antigravity/pet-packs/pokemon/` with minimal disk footprint.
 *
 * Strategy for minimal size:
 *  - Uses single compact animated GIFs (`showdown/{id}.gif`, or PNG fallback `showdown/{id}.png`
 *    when a Gen-9 species has no animated GIF yet) instead of tens of thousands of unpacked PNG frames.
 *  - Removes legacy `frames/`, `frames-pixel/`, `artwork/`, `pixel/` bloat from the user pack.
 *
 * Usage:
 *   node tools/build-allgen-pokemon-pack.mjs [--concurrency 24] [--keep-legacy]
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { USER_PACKS_DIR, loadPackDir } from '../bridge/pet-packs.mjs';

const argv = process.argv.slice(2);
const flagNum = (name, fallback) => {
  const i = argv.indexOf(name);
  const v = i !== -1 && i + 1 < argv.length ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const CONCURRENCY = flagNum('--concurrency', 24);
const KEEP_LEGACY = argv.includes('--keep-legacy');
const TO = resolve(join(USER_PACKS_DIR, 'pokemon'));
const SHOWDOWN_DIR = join(TO, 'showdown');

const TYPE_COLORS = {
  Electric: '#FFD43B',
  Fire: '#FF6B2B',
  Water: '#38BDF8',
  Grass: '#4ADE80',
  Psychic: '#E879F9',
  Ghost: '#A855F7',
  Dark: '#64748B',
  Dragon: '#6366F1',
  Fairy: '#F472B6',
  Ice: '#67E8F9',
  Fighting: '#FB7185',
  Steel: '#94A3B8',
  Rock: '#D6B88D',
  Ground: '#D99B52',
  Poison: '#C084FC',
  Bug: '#A3E635',
  Flying: '#7DD3FC',
  Normal: '#CBD5E1'
};

const TYPE_SPARKS = {
  Electric: '⚡',
  Fire: '🔥',
  Water: '💧',
  Grass: '🌿',
  Psychic: '🔮',
  Ghost: '👻',
  Dark: '🌙',
  Dragon: '🐉',
  Fairy: '✨',
  Ice: '❄️',
  Fighting: '💥',
  Steel: '⚙️',
  Rock: '🪨',
  Ground: '🏜️',
  Poison: '🟣',
  Bug: '🦋',
  Flying: '🪶',
  Normal: '⭐'
};

// Preserve classic curated metadata for the original 7 favorites
const CLASSIC_OVERRIDES = {
  pikachu: { cheer: '❤️ 皮卡皮卡~！十万伏特！', spark: '⚡', scale: 0.86, color: '#FFD43B', rarity: 'N', weight: 24, match: { keywords: ['scout', 'research'] }, shiny: { hue: -14, saturation: 1.08, lightness: 1.0 } },
  gengar: { cheer: '💜 桀桀桀~！暗影潜袭！', spark: '🟣', scale: 0.96, color: '#A855F7', rarity: 'R', weight: 14, match: { keywords: ['theme', 'css', 'ui', 'refactor'] }, shiny: { hue: -28, saturation: 0.7, lightness: 1.28 } },
  charizard: { cheer: '🔥 吼呜~！喷射火焰！', spark: '🔥', scale: 1.0, color: '#FF6B2B', rarity: 'SR', weight: 8, match: { keywords: ['pet', 'overlay', 'desktop', 'commit'] }, shiny: { hue: -6, saturation: 0.3, lightness: 0.55 } },
  umbreon: { cheer: '🌙 布伊~！月光守护！', spark: '✨', scale: 0.92, color: '#FACC15', rarity: 'SR', weight: 9, match: { keywords: ['verif', 'test', 'qa'] }, shiny: { hue: 165, saturation: 1.0, lightness: 1.0 } },
  eevee: { cheer: '✨ 伊布伊布~！蓬松摇尾！', spark: '✨', scale: 0.86, color: '#D99B52', rarity: 'N', weight: 26, match: { keywords: ['sprite', 'art', 'asset'] }, shiny: { hue: 0, saturation: 0.12, lightness: 1.32 } },
  rotom: { cheer: '📟 洛托洛托~！雷达满电！', spark: '⚡', scale: 0.92, color: '#38BDF8', rarity: 'R', weight: 16, match: { coordinator: true }, shiny: { hue: -95, saturation: 1.0, lightness: 1.0 } },
  mewtwo: { cheer: '🔮 精神击破~！超能共鸣！', spark: '🔮', scale: 1.0, color: '#E879F9', rarity: 'SSR', weight: 3, match: { lead: true, keywords: ['mewtwo'] }, shiny: { hue: -165, saturation: 1.0, lightness: 1.02 } }
};

function parseCsvLines(text) {
  const rows = [];
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    // Handle simple CSV with optional double quotes
    const cols = [];
    let cur = '';
    let inQ = false;
    for (let j = 0; j < ln.length; j++) {
      const ch = ln[j];
      if (ch === '"') {
        inQ = !inQ;
      } else if (ch === ',' && !inQ) {
        cols.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    cols.push(cur);
    rows.push(cols);
  }
  return rows;
}

async function fetchText(url, timeoutMs = 20000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

async function fetchBuffer(url, timeoutMs = 12000) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const ab = await res.arrayBuffer();
    if (!ab || ab.byteLength < 64) return null;
    return Buffer.from(ab);
  } catch {
    return null;
  }
}

function toShowdownSpriteSlug(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’.:]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-/g, '');
}

async function downloadSprite(id, spriteSlug) {
  const gifOut = join(SHOWDOWN_DIR, `${id}.gif`);
  const pngOut = join(SHOWDOWN_DIR, `${id}.png`);
  if (existsSync(gifOut) && statSync(gifOut).size > 64) return { ext: 'gif', size: statSync(gifOut).size, cached: true };
  if (existsSync(pngOut) && statSync(pngOut).size > 64) return { ext: 'png', size: statSync(pngOut).size, cached: true };

  const candidates = [
    { url: `https://play.pokemonshowdown.com/sprites/ani/${spriteSlug}.gif`, ext: 'gif' },
    { url: `https://play.pokemonshowdown.com/sprites/gen5ani/${spriteSlug}.gif`, ext: 'gif' },
    { url: `https://play.pokemonshowdown.com/sprites/dex/${spriteSlug}.png`, ext: 'png' },
    { url: `https://play.pokemonshowdown.com/sprites/gen5/${spriteSlug}.png`, ext: 'png' }
  ];

  for (const cand of candidates) {
    const buf = await fetchBuffer(cand.url, 10000);
    if (buf) {
      const target = cand.ext === 'gif' ? gifOut : pngOut;
      writeFileSync(target, buf);
      return { ext: cand.ext, size: buf.byteLength, cached: false };
    }
  }
  return null;
}

async function main() {
  console.log('📡 Fetching Pokédex metadata (Gen 1–9, #1..#1025)...');
  const [pokedexRaw, namesCsv, speciesCsv] = await Promise.all([
    fetchText('https://play.pokemonshowdown.com/data/pokedex.json', 25000),
    fetchText('https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species_names.csv', 25000),
    fetchText('https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv/pokemon_species.csv', 25000)
  ]);

  const pokedex = JSON.parse(pokedexRaw);
  const cnNames = new Map(); // dexNo -> zh-Hans name
  for (const cols of parseCsvLines(namesCsv)) {
    const dexNo = Number(cols[0]);
    const langId = Number(cols[1]);
    const nm = String(cols[2] || '').trim();
    if (dexNo >= 1 && dexNo <= 1025 && langId === 12 && nm) {
      cnNames.set(dexNo, nm);
    }
  }

  const speciesMeta = new Map(); // dexNo -> { isLegendary, isMythical, captureRate }
  for (const cols of parseCsvLines(speciesCsv)) {
    const dexNo = Number(cols[0]);
    if (dexNo >= 1 && dexNo <= 1025) {
      speciesMeta.set(dexNo, {
        captureRate: Number(cols[8]) || 120,
        isLegendary: cols[14] === '1',
        isMythical: cols[15] === '1'
      });
    }
  }

  // Pick one canonical base entry per dexNo 1..1025 from Showdown pokedex
  const baseByDex = new Map();
  for (const [key, entry] of Object.entries(pokedex)) {
    if (!entry || typeof entry.num !== 'number') continue;
    if (entry.num < 1 || entry.num > 1025) continue;
    if (entry.forme) continue; // skip alternate formes so #1..#1025 are clean canonical species
    if (!baseByDex.has(entry.num)) {
      baseByDex.set(entry.num, { key, entry });
    }
  }

  mkdirSync(SHOWDOWN_DIR, { recursive: true });

  const sortedDex = [...baseByDex.keys()].sort((a, b) => a - b);
  console.log(`🐾 Found ${sortedDex.length} canonical species (#1..#${sortedDex[sortedDex.length - 1]}). Downloading compact sprites (concurrency=${CONCURRENCY})...`);

  const queue = sortedDex.map((num) => {
    const { key, entry } = baseByDex.get(num);
    const id = key.replace(/[^a-z0-9_-]/g, '');
    const spriteSlug = toShowdownSpriteSlug(entry.name || key);
    return { num, id, spriteSlug, entry };
  });

  let idx = 0;
  let downloaded = 0;
  let cachedCount = 0;
  let failed = 0;
  let totalBytes = 0;
  const spriteResult = new Map();

  async function worker() {
    while (idx < queue.length) {
      const item = queue[idx++];
      const res = await downloadSprite(item.id, item.spriteSlug);
      if (res) {
        spriteResult.set(item.id, res);
        totalBytes += res.size;
        if (res.cached) cachedCount++;
        else downloaded++;
      } else {
        failed++;
      }
      const done = downloaded + cachedCount + failed;
      if (done % 100 === 0 || done === queue.length) {
        process.stdout.write(`  progress: ${done}/${queue.length} (new=${downloaded}, cached=${cachedCount}, miss=${failed}, ${(totalBytes / (1024 * 1024)).toFixed(2)} MB)\n`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  if (!KEEP_LEGACY) {
    for (const bloatDir of ['frames', 'frames-pixel', 'frames-shiny', 'frames-pixel-shiny', 'artwork', 'pixel', 'pixel-shiny']) {
      const p = join(TO, bloatDir);
      if (existsSync(p)) {
        rmSync(p, { recursive: true, force: true });
      }
    }
  }

  const creatures = [];
  for (const item of queue) {
    if (!spriteResult.has(item.id)) continue;
    const { num, id, entry } = item;
    const spMeta = speciesMeta.get(num) || { captureRate: 120, isLegendary: false, isMythical: false };
    const primaryType = Array.isArray(entry.types) && entry.types[0] ? entry.types[0] : 'Normal';
    const cnName = cnNames.get(num) || entry.name || id;
    const ov = CLASSIC_OVERRIDES[id];

    let rarity = 'N';
    let weight = 22;
    if (spMeta.isLegendary || spMeta.isMythical) {
      rarity = 'SSR';
      weight = 3;
    } else if (spMeta.captureRate <= 45) {
      rarity = 'SR';
      weight = 9;
    } else if (spMeta.captureRate <= 120) {
      rarity = 'R';
      weight = 15;
    }

    const spark = ov?.spark || TYPE_SPARKS[primaryType] || '✨';
    const color = ov?.color || TYPE_COLORS[primaryType] || '#94A3B8';
    const cheer = ov?.cheer || `${spark} ${cnName}~！全力支援！`;

    creatures.push({
      id,
      name: cnName,
      short: cnName,
      dexNo: num,
      rarity: ov?.rarity || rarity,
      weight: ov?.weight || weight,
      scale: ov?.scale || 0.94,
      color,
      cheer,
      spark,
      ...(ov?.match ? { match: ov.match } : {}),
      shiny: ov?.shiny || { hue: (num * 37) % 300 - 150, saturation: 1.05, lightness: 1.02 }
    });
  }

  const PACK = {
    schema: 1,
    id: 'pokemon',
    name: '宝可梦全世代图鉴（紧凑版）',
    version: '2.0.0',
    author: 'local',
    license: 'Private use only. Pokémon artwork © Nintendo / Creatures / GAME FREAK — do not redistribute.',
    private: true,
    description: `全世代 Gen 1–9 紧凑图鉴（共 ${creatures.length} 只官方宝可梦，单文件动图压缩存储，同屏绝不重复）。`,
    defaultStyle: 'showdown',
    styles: {
      showdown: {
        label: '全世代动态',
        gif: 'showdown/{id}.gif',
        shinyGif: 'showdown-shiny/{id}.gif'
      }
    },
    creatures
  };

  const tmp = join(TO, 'pack.json.tmp');
  writeFileSync(tmp, JSON.stringify(PACK) + '\n', { encoding: 'utf8' }); // compact single-line JSON saves disk & parse time
  renameSync(tmp, join(TO, 'pack.json'));

  const { pack, error } = loadPackDir(TO, 'user');
  if (error) {
    console.error(`❌ Pack validation failed: ${error}`);
    process.exit(2);
  }
  const dirBytes = readdirSync(SHOWDOWN_DIR).reduce((sum, f) => sum + statSync(join(SHOWDOWN_DIR, f)).size, 0);
  console.log(`✅ Built all-gen pack "${pack.id}" (${pack.creatures.length} species, ${(dirBytes / (1024 * 1024)).toFixed(2)} MB total, ${failed} missed).`);
}

main().catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
