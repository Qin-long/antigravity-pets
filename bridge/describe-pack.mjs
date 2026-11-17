#!/usr/bin/env node
/**
 * Offline fallback for native clients (the WPF overlay) when the bridge isn't reachable yet:
 * writes the active skin pack's descriptor (with absolute folders) as UTF-8 JSON to `--out <file>` or stdout.
 *
 *   node bridge/describe-pack.mjs [--id <packId>] [--out <file>]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackRegistry, describePack } from './pet-packs.mjs';
import { RARITY_META } from './pokemon-gacha.mjs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : '';
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packs = createPackRegistry({ builtinDir: join(root, 'packs') });

let wanted = flag('--id');
if (!wanted) {
  try {
    const col = JSON.parse(readFileSync(join(homedir(), '.gemini', 'antigravity', 'pokemon-collection.json'), 'utf8').replace(/^﻿/, ''));
    wanted = col?.settings?.activePack || '';
  } catch {
    // no collection yet
  }
}
const pack = packs.resolveActive(wanted);
const out = pack
  ? { ok: true, active: true, ...describePack(pack, { withPaths: true, rarityMeta: RARITY_META }) }
  : { ok: false, error: 'No skin pack installed', problems: packs.problems };
const json = JSON.stringify(out);
const file = flag('--out');
if (file) writeFileSync(file, json, { encoding: 'utf8' });
else process.stdout.write(json);
process.exit(pack ? 0 : 1);
