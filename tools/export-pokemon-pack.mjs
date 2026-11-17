#!/usr/bin/env node
/**
 * Build your *private* local "pokemon" skin pack from sprites you already have on disk.
 *
 * The repo ships the sprites under `assets/official-sprites/` for personal, non-commercial use only (copyright belongs
 * to the rights holders; see NOTICE.md). This copies them (or any sprite folder with the layout below) to
 * `~/.gemini/antigravity/pet-packs/pokemon/` and writes a pack.json, so the bridge, stage, desktop overlay and IDE
 * skin can use it. Nothing is uploaded anywhere; the pack stays on this machine.
 *
 *   node tools/export-pokemon-pack.mjs [--from <dir>] [--to <dir>] [--dry-run]
 *
 * Expected source layout (default: <suite>/assets/official-sprites):
 *   showdown/<id>.gif   pixel/<id>.gif   artwork/<id>.png
 *   frames/<id>/frame-000.png ... (+ manifest.json with frameDelaysMs)
 *   frames-pixel/<id>/...        optional: frames-shiny/<id>/, frames-pixel-shiny/<id>/, showdown-shiny/<id>.gif
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { USER_PACKS_DIR, loadPackDir } from '../bridge/pet-packs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : fallback;
};
const FROM = resolve(flag('--from', join(here, '..', 'assets', 'official-sprites')));
const TO = resolve(flag('--to', join(USER_PACKS_DIR, 'pokemon')));
const DRY = argv.includes('--dry-run');

// Rarity / weights / shiny shifts are exactly what the suite used before packs existed, so nothing changes for you.
const CREATURES = [
  { id: 'pikachu', cheer: '❤️ 皮卡皮卡~！十万伏特！', spark: '⚡', name: '皮卡丘', dexNo: 25, rarity: 'N', weight: 24, scale: 0.86, color: '#FFD43B', match: { keywords: ['scout', 'research'] }, shiny: { hue: -14, saturation: 1.08, lightness: 1.0 } },
  { id: 'gengar', cheer: '💜 桀桀桀~！暗影潜袭！', spark: '🟣', name: '耿鬼', dexNo: 94, rarity: 'R', weight: 14, scale: 0.96, color: '#A855F7', match: { keywords: ['theme', 'css', 'ui', 'refactor'] }, shiny: { hue: -28, saturation: 0.7, lightness: 1.28 } },
  { id: 'charizard', cheer: '🔥 吼呜~！喷射火焰！', spark: '🔥', name: '喷火龙', dexNo: 6, rarity: 'SR', weight: 8, scale: 1.0, color: '#FF6B2B', match: { keywords: ['pet', 'overlay', 'desktop', 'commit'] }, shiny: { hue: -6, saturation: 0.3, lightness: 0.55 } },
  { id: 'umbreon', cheer: '🌙 布伊~！月光守护！', spark: '✨', name: '月亮伊布', dexNo: 197, rarity: 'SR', weight: 9, scale: 0.92, color: '#FACC15', match: { keywords: ['verif', 'test', 'qa'] }, shiny: { hue: 165, saturation: 1.0, lightness: 1.0 } },
  { id: 'eevee', cheer: '✨ 伊布伊布~！蓬松摇尾！', spark: '✨', name: '伊布', dexNo: 133, rarity: 'N', weight: 26, scale: 0.86, color: '#D99B52', match: { keywords: ['sprite', 'art', 'asset'] }, shiny: { hue: 0, saturation: 0.12, lightness: 1.32 } },
  { id: 'rotom', cheer: '📟 洛托洛托~！雷达满电！', spark: '⚡', name: '洛托姆', dexNo: 479, rarity: 'R', weight: 16, scale: 0.92, color: '#38BDF8', match: { coordinator: true }, shiny: { hue: -95, saturation: 1.0, lightness: 1.0 } },
  { id: 'mewtwo', cheer: '🔮 精神击破~！超能共鸣！', spark: '🔮', name: '超梦', dexNo: 150, rarity: 'SSR', weight: 3, scale: 1.0, color: '#E879F9', match: { lead: true, keywords: ['mewtwo'] }, shiny: { hue: -165, saturation: 1.0, lightness: 1.02 } }
];

const PACK = {
  schema: 1,
  id: 'pokemon',
  name: '宝可梦（本地私有）',
  version: '1.0.0',
  author: 'local',
  license: 'Private use only. Pokémon artwork © Nintendo / Creatures / GAME FREAK — do not redistribute.',
  private: true,
  description: '由 tools/export-pokemon-pack.mjs 从本机素材生成，仅供个人使用，请勿提交或分发。',
  defaultStyle: 'showdown',
  styles: {
    showdown: { label: '3D 动态', gif: 'showdown/{id}.gif', frames: 'frames/{id}', shinyGif: 'showdown-shiny/{id}.gif', shinyFrames: 'frames-shiny/{id}' },
    pixel: { label: '像素', gif: 'pixel/{id}.gif', frames: 'frames-pixel/{id}', shinyGif: 'pixel-shiny/{id}.gif', shinyFrames: 'frames-pixel-shiny/{id}', pixelated: true }
  },
  artwork: 'artwork/{id}.png',
  creatures: CREATURES.map((c) => ({ short: c.name, ...c }))
};

const COPY_DIRS = ['showdown', 'pixel', 'artwork', 'frames', 'frames-pixel', 'showdown-shiny', 'pixel-shiny', 'frames-shiny', 'frames-pixel-shiny'];

if (!existsSync(FROM)) {
  console.error(`Source folder not found: ${FROM}\nPass --from <dir> pointing at your sprite folder.`);
  process.exit(1);
}
const present = COPY_DIRS.filter((d) => existsSync(join(FROM, d)));
const missing = CREATURES.filter((c) => !existsSync(join(FROM, 'showdown', `${c.id}.gif`)) && !existsSync(join(FROM, 'frames', c.id)));
console.log(`from: ${FROM}\n  to: ${TO}\ncopy: ${present.join(', ') || '(nothing)'}`);
if (missing.length) console.warn(`warning: no sprites for ${missing.map((c) => c.id).join(', ')}`);
if (DRY) process.exit(0);

mkdirSync(TO, { recursive: true });
for (const d of present) cpSync(join(FROM, d), join(TO, d), { recursive: true, force: true });
const tmp = join(TO, 'pack.json.tmp');
writeFileSync(tmp, JSON.stringify(PACK, null, 2) + '\n', { encoding: 'utf8' }); // UTF-8, no BOM
renameSync(tmp, join(TO, 'pack.json'));

const { pack, error } = loadPackDir(TO, 'user');
if (error) {
  console.error(`pack written but failed validation: ${error}`);
  process.exit(2);
}
const files = (dir) => {
  try {
    return readdirSync(dir, { recursive: true }).length;
  } catch {
    return 0;
  }
};
console.log(`ok: pack "${pack.id}" with ${pack.creatures.length} creatures, ${files(TO)} files.`);
for (const c of pack.creatures) {
  const s = c.assets.showdown;
  const p = c.assets.pixel;
  console.log(
    `  ${c.id.padEnd(10)} ${c.rarity.padEnd(3)} w=${String(c.weight).padStart(2)} showdown:${s.frames ? s.frames.frames.length : 0}f pixel:${p.frames ? p.frames.frames.length : 0}f shiny:${s.shinyFrames || s.shinyGif ? 'art' : 'hsl'}`
  );
}
