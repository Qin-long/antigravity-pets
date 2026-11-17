/**
 * Partner gacha for new agents — the pool comes from the active skin pack (see bridge/pet-packs.mjs).
 *
 * Every agent that appears for the first time (new conversation lead or new subagent) "draws" a creature:
 *   - weighted roll over the pack's creatures (rarity tiers N / R / SR / SSR, weights from pack.json)
 *   - independent shiny roll (default 1/256, configurable)
 * Results are persisted locally so each agent keeps its partner across restarts, and every draw is recorded
 * in a per-pack dex (caught / shiny counts) that the stage UI can browse and re-assign from.
 *
 * Storage: `~/.gemini/antigravity/pokemon-collection.json` (UTF-8, no BOM, atomic rename writes).
 *   v2 layout: roster keys are `<packId>|<agentKey>`, dex is `{ <packId>: { <creatureId>: {...} } }`.
 *   v1 files (single built-in Pokémon pool) are migrated into pack "pokemon" on load.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { RARITY_IDS } from './pet-packs.mjs';

export const RARITY_META = {
  N: { id: 'N', label: '普通', stars: 1, color: '#94A3B8' },
  R: { id: 'R', label: '稀有', stars: 2, color: '#38BDF8' },
  SR: { id: 'SR', label: '超稀有', stars: 3, color: '#C084FC' },
  SSR: { id: 'SSR', label: '传说', stars: 4, color: '#FBBF24' }
};

export const SHINY_RATE_PRESETS = [4096, 1024, 512, 256, 128, 64, 16];
const LEGACY_PACK_ID = 'pokemon';

const DEFAULT_SETTINGS = {
  gachaEnabled: true,
  shinyRate: 256, // 1 / shinyRate
  leadMode: 'gacha', // 'gacha' | 'fixed'
  leadSpecies: '', // '' -> the pack's designated lead (match.lead)
  revealAnimation: true,
  activePack: null // null -> registry default
};

const MAX_ROSTER = 400;
const MAX_HISTORY = 80;
const RECENT_REVEAL_TTL_MS = 25_000;

function clampShinyRate(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_SETTINGS.shinyRate;
  return Math.min(65536, Math.max(2, n));
}

/** Drawable creatures of a pack, in display order (rarity tier, then most common first). */
export function poolOf(pack) {
  if (!pack) return [];
  return pack.creatures
    .filter((c) => c.weight > 0)
    .map((c) => ({ species: c.id, rarity: c.rarity, weight: c.weight }))
    .sort((a, b) => RARITY_IDS.indexOf(a.rarity) - RARITY_IDS.indexOf(b.rarity) || b.weight - a.weight);
}

export function rollFromPool(pool, rand = Math.random, excludeSpecies = null) {
  const filtered = excludeSpecies && excludeSpecies.size > 0
    ? pool.filter((p) => !excludeSpecies.has(p.species))
    : pool;
  const activePool = filtered.length > 0 ? filtered : pool;
  const total = activePool.reduce((s, p) => s + p.weight, 0);
  let r = rand() * total;
  for (const p of activePool) {
    r -= p.weight;
    if (r < 0) return p.species;
  }
  return activePool[0]?.species || '';
}

/** Stable roster key: one partner per conversation lead, one per (conversation, subagent name). */
export function gachaKeyFor({ conversationId = '', name = '', id = '', isLead = false } = {}) {
  const conv = String(conversationId || '').trim() || 'global';
  if (isLead) return `lead:${conv}`;
  const nm = String(name || id || 'agent').trim().toLowerCase();
  return `sub:${conv}:${nm}`;
}

function migrate(raw) {
  if (Number(raw.version) >= 2) return raw;
  const roster = {};
  for (const [k, v] of Object.entries(raw.roster || {})) roster[`${LEGACY_PACK_ID}|${k}`] = { ...v, pack: LEGACY_PACK_ID };
  return {
    ...raw,
    version: 2,
    roster,
    dex: { [LEGACY_PACK_ID]: raw.dex && typeof raw.dex === 'object' ? raw.dex : {} },
    history: (Array.isArray(raw.history) ? raw.history : []).map((h) => ({ pack: LEGACY_PACK_ID, ...h }))
  };
}

/**
 * @param {object} o
 * @param {string|null} o.filePath
 * @param {{ resolveActive(id): object|null, get(id): object|null }} o.packs  pack registry
 * @param {(info, pack) => string} [o.legacySpecies]  deterministic pick for silent bootstrap / gacha off
 * @param {(evt) => void} [o.onReveal]
 */
export function createGachaEngine({ filePath, packs, legacySpecies, onReveal } = {}) {
  const state = {
    version: 2,
    settings: { ...DEFAULT_SETTINGS },
    roster: {},
    dex: {},
    history: [],
    seq: 0,
    totalDraws: 0
  };
  const recent = []; // { ...event, expiresAtMs }
  let bootstrapping = true;
  let saveTimer = null;

  // ---- persistence -------------------------------------------------------
  try {
    if (filePath && existsSync(filePath)) {
      const raw0 = JSON.parse(readFileSync(filePath, 'utf8').replace(/^﻿/, ''));
      if (raw0 && typeof raw0 === 'object') {
        const raw = migrate(raw0);
        state.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
        state.settings.shinyRate = clampShinyRate(state.settings.shinyRate);
        state.roster = raw.roster && typeof raw.roster === 'object' ? raw.roster : {};
        state.dex = raw.dex && typeof raw.dex === 'object' ? raw.dex : {};
        state.history = Array.isArray(raw.history) ? raw.history.slice(-MAX_HISTORY) : [];
        state.seq = Number(raw.seq) || 0;
        state.totalDraws = Number(raw.totalDraws) || 0;
        if (!(Number(raw0.version) >= 2)) setTimeout(() => saveNow(), 0).unref?.();
      }
    }
  } catch {
    // corrupt file -> start fresh (old file is overwritten on next save)
  }

  function saveNow() {
    if (!filePath) return;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      const tmp = `${filePath}.tmp`;
      writeFileSync(tmp, JSON.stringify(state, null, 1), { encoding: 'utf8' });
      renameSync(tmp, filePath);
    } catch {
      // best effort
    }
  }
  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveNow();
    }, 300);
    saveTimer.unref?.();
  }

  // ---- pack helpers ------------------------------------------------------
  function pack() {
    return packs?.resolveActive(state.settings.activePack) || null;
  }
  function packId() {
    return pack()?.id || '';
  }
  function hasSpecies(p, species) {
    return Boolean(p && p.creatures.some((c) => c.id === species && c.weight > 0));
  }
  function rarityOf(p, species) {
    return p?.creatures.find((c) => c.id === species)?.rarity || 'N';
  }
  function dexOf(pid) {
    if (!state.dex[pid] || typeof state.dex[pid] !== 'object') state.dex[pid] = {};
    return state.dex[pid];
  }
  function legacyPick(info, p) {
    const s = legacySpecies ? legacySpecies(info, p) : '';
    if (hasSpecies(p, s)) return s;
    return poolOf(p)[0]?.species || '';
  }

  function pruneRoster() {
    const keys = Object.keys(state.roster);
    if (keys.length <= MAX_ROSTER) return;
    keys
      .sort((a, b) => Date.parse(state.roster[a].lastSeenAt || 0) - Date.parse(state.roster[b].lastSeenAt || 0))
      .slice(0, keys.length - MAX_ROSTER)
      .forEach((k) => delete state.roster[k]);
  }

  function addToDex(pid, species, shiny, atIso) {
    const dex = dexOf(pid);
    const d = dex[species] || { caught: 0, shinyCaught: 0, firstAt: atIso, lastAt: atIso };
    const isNewSpecies = d.caught === 0;
    const isFirstShiny = shiny && d.shinyCaught === 0;
    d.caught += 1;
    if (shiny) d.shinyCaught += 1;
    d.lastAt = atIso;
    if (!d.firstAt) d.firstAt = atIso;
    dex[species] = d;
    return { isNewSpecies, isFirstShiny };
  }

  function pruneRecent(nowMs) {
    while (recent.length && recent[0].expiresAtMs <= nowMs) recent.shift();
  }

  function draw(p, info, { silent = false, demo = false, forcedSpecies = '', nowMs = Date.now(), excludeSpecies = null } = {}) {
    const atIso = new Date(nowMs).toISOString();
    const s = state.settings;
    let species = forcedSpecies && hasSpecies(p, forcedSpecies) && !(excludeSpecies && excludeSpecies.has(forcedSpecies)) ? forcedSpecies : '';
    if (!species && info.isLead && s.leadMode === 'fixed') {
      // Fixed lead: the chosen creature if this pack has it and it isn't occupied on screen
      const pref = hasSpecies(p, s.leadSpecies) ? s.leadSpecies : p.creatures.find((c) => c.match.lead && c.weight > 0)?.id || '';
      if (pref && !(excludeSpecies && excludeSpecies.has(pref))) species = pref;
    }
    if (!species) species = rollFromPool(poolOf(p), Math.random, excludeSpecies);
    const shiny = silent ? false : Math.random() < 1 / clampShinyRate(s.shinyRate);
    const rarity = rarityOf(p, species);
    const { isNewSpecies, isFirstShiny } = addToDex(p.id, species, shiny, atIso);
    state.totalDraws += 1;
    state.seq += 1;
    const evt = {
      seq: state.seq,
      pack: p.id,
      key: info.key,
      agentId: info.id || '',
      name: info.name || '',
      isLead: Boolean(info.isLead),
      conversationId: info.conversationId || '',
      conversationTitle: info.conversationTitle || '',
      projectName: info.projectName || '',
      species,
      shiny,
      rarity,
      rarityLabel: RARITY_META[rarity].label,
      stars: RARITY_META[rarity].stars,
      isNewSpecies,
      isFirstShiny,
      demo: Boolean(demo),
      silent: Boolean(silent),
      at: atIso
    };
    state.history.push(evt);
    if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
    return evt;
  }

  function publicEntry(entry, nowMs = Date.now()) {
    const fresh = entry.revealSeq && nowMs - Date.parse(entry.rolledAt || 0) < RECENT_REVEAL_TTL_MS;
    return {
      key: entry.key,
      pack: entry.pack,
      species: entry.species,
      shiny: Boolean(entry.shiny),
      rarity: entry.rarity || 'N',
      revealSeq: fresh ? entry.revealSeq : 0
    };
  }

  function fallbackEntry(key, info, p) {
    const species = p ? legacyPick(info, p) : '';
    return { key, pack: p?.id || '', species, shiny: false, rarity: rarityOf(p, species), revealSeq: 0 };
  }

  /**
   * Resolve (and on first sight, draw) the partner for an agent.
   * `info`: { id, name, role, isLead, conversationId, conversationTitle, projectName, demo }
   */
  function resolve(info, nowMs = Date.now(), { excludeSpecies = null } = {}) {
    const key = info.key || gachaKeyFor(info);
    const p = pack();
    if (!p) return fallbackEntry(key, info, null);
    const rk = `${p.id}|${key}`;
    const existing = state.roster[rk];
    if (existing && hasSpecies(p, existing.species) && !(excludeSpecies && excludeSpecies.has(existing.species))) {
      const nowIso = new Date(nowMs).toISOString();
      if (!existing.lastSeenAt || nowMs - Date.parse(existing.lastSeenAt) > 60_000) {
        existing.lastSeenAt = nowIso;
        if (info.conversationTitle) existing.conversationTitle = info.conversationTitle;
        scheduleSave();
      }
      return publicEntry(existing, nowMs);
    }

    if (!state.settings.gachaEnabled) {
      const fb = fallbackEntry(key, info, p);
      if (excludeSpecies && excludeSpecies.has(fb.species)) {
        fb.species = rollFromPool(poolOf(p), Math.random, excludeSpecies);
      }
      return fb;
    }

    // Silent while bootstrapping (bridge start / pack switch) or when re-rolling a screen collision.
    const silent = (bootstrapping || Boolean(existing)) && !info.demo;
    let forced = silent && !existing ? legacyPick(info, p) : '';
    if (forced && excludeSpecies && excludeSpecies.has(forced)) forced = '';
    const evt = draw(p, { ...info, key }, { silent, demo: info.demo, forcedSpecies: forced, nowMs, excludeSpecies });
    state.roster[rk] = {
      key,
      pack: p.id,
      name: info.name || '',
      isLead: Boolean(info.isLead),
      conversationId: info.conversationId || '',
      conversationTitle: info.conversationTitle || '',
      projectName: info.projectName || '',
      species: evt.species,
      shiny: evt.shiny,
      rarity: evt.rarity,
      rolledAt: evt.at,
      lastSeenAt: evt.at,
      revealSeq: silent ? 0 : evt.seq,
      demo: Boolean(info.demo)
    };
    pruneRoster();
    scheduleSave();
    if (!silent) {
      pruneRecent(nowMs);
      recent.push({ ...evt, expiresAtMs: nowMs + RECENT_REVEAL_TTL_MS });
      try {
        onReveal?.(evt);
      } catch {
        // ignore listener errors
      }
    }
    return publicEntry(state.roster[rk], nowMs);
  }

  /** Look up an agent's partner without drawing (used for queues that are about to be retired). */
  function peek(info, nowMs = Date.now()) {
    const key = info.key || gachaKeyFor(info);
    const p = pack();
    const existing = p ? state.roster[`${p.id}|${key}`] : null;
    if (existing && hasSpecies(p, existing.species)) return publicEntry(existing, nowMs);
    return fallbackEntry(key, info, p);
  }

  function finishBootstrap() {
    bootstrapping = false;
  }

  function getRecent(nowMs = Date.now()) {
    pruneRecent(nowMs);
    const pid = packId();
    return recent.filter((r) => r.pack === pid).map(({ expiresAtMs: _e, ...pub }) => pub);
  }

  function getPublicState() {
    const p = pack();
    const pid = p?.id || '';
    const pool = poolOf(p);
    const dexData = state.dex[pid] || {};
    const prefix = `${pid}|`;
    const roster = Object.entries(state.roster)
      .filter(([k]) => k.startsWith(prefix))
      .map(([, v]) => v)
      .sort((a, b) => Date.parse(b.lastSeenAt || 0) - Date.parse(a.lastSeenAt || 0))
      .slice(0, 200);
    const dex = pool.map((e) => {
      const c = p.creatures.find((x) => x.id === e.species);
      return {
        species: e.species,
        name: c?.name || e.species,
        dexNo: c?.dexNo ?? null,
        rarity: e.rarity,
        rarityLabel: RARITY_META[e.rarity].label,
        stars: RARITY_META[e.rarity].stars,
        rate: e.weight,
        caught: dexData[e.species]?.caught || 0,
        shinyCaught: dexData[e.species]?.shinyCaught || 0,
        firstAt: dexData[e.species]?.firstAt || null,
        lastAt: dexData[e.species]?.lastAt || null
      };
    });
    const totalWeight = pool.reduce((s, e) => s + e.weight, 0) || 1;
    return {
      ok: true,
      pack: p ? { id: p.id, name: p.name } : null,
      settings: { ...state.settings, activePack: pid || state.settings.activePack },
      shinyRatePresets: SHINY_RATE_PRESETS,
      rarity: RARITY_META,
      pool: pool.map((e) => ({ ...e, pct: Math.round((e.weight / totalWeight) * 1000) / 10 })),
      dex,
      roster,
      history: state.history
        .filter((h) => (h.pack || LEGACY_PACK_ID) === pid)
        .slice(-40)
        .reverse(),
      stats: {
        totalDraws: dex.reduce((s, d) => s + d.caught, 0),
        totalDrawsAllPacks: state.totalDraws,
        speciesOwned: dex.filter((d) => d.caught > 0).length,
        speciesTotal: dex.length,
        shinyTotal: dex.reduce((s, d) => s + d.shinyCaught, 0)
      }
    };
  }

  /** Returns the new settings; `packChanged` tells the caller to rebroadcast everything. */
  function updateSettings(patch = {}) {
    const s = state.settings;
    let packChanged = false;
    if (patch.activePack !== undefined) {
      const next = packs?.get(String(patch.activePack || ''));
      if (next && next.id !== packId()) {
        s.activePack = next.id;
        packChanged = true;
        bootstrapping = true; // visible agents get partners from the new pack silently on the next scan
        recent.length = 0;
      }
    }
    const p = pack();
    if (patch.gachaEnabled !== undefined) s.gachaEnabled = Boolean(patch.gachaEnabled);
    if (patch.revealAnimation !== undefined) s.revealAnimation = Boolean(patch.revealAnimation);
    if (patch.shinyRate !== undefined) s.shinyRate = clampShinyRate(patch.shinyRate);
    if (patch.leadMode === 'gacha' || patch.leadMode === 'fixed') s.leadMode = patch.leadMode;
    if (patch.leadSpecies && hasSpecies(p, String(patch.leadSpecies))) s.leadSpecies = String(patch.leadSpecies);
    scheduleSave();
    return { ...s, activePack: packId() || s.activePack, packChanged };
  }

  /** Re-assign an agent's partner to a creature already in the dex (shiny only if a shiny was caught). */
  function assign(key, species, shiny = false) {
    const p = pack();
    if (!p) return { ok: false, error: 'no-pack' };
    const entry = state.roster[`${p.id}|${key}`];
    if (!entry) return { ok: false, error: 'unknown-agent' };
    if (!hasSpecies(p, species)) return { ok: false, error: 'unknown-species' };
    const d = dexOf(p.id)[species];
    if (!d || d.caught <= 0) return { ok: false, error: 'not-caught' };
    if (shiny && !(d.shinyCaught > 0)) return { ok: false, error: 'shiny-not-caught' };
    entry.species = species;
    entry.shiny = Boolean(shiny);
    entry.rarity = rarityOf(p, species);
    entry.revealSeq = 0;
    entry.assignedAt = new Date().toISOString();
    scheduleSave();
    return { ok: true, entry: { ...entry } };
  }

  /** Manual "try a pull" from the stage: adds to the dex and fires a reveal, but binds to no agent. */
  function demoPull(nowMs = Date.now()) {
    const p = pack();
    if (!p) return null;
    const evt = draw(p, { key: `demo:${state.seq + 1}`, name: '试抽', isLead: false }, { demo: true, nowMs });
    scheduleSave();
    pruneRecent(nowMs);
    recent.push({ ...evt, expiresAtMs: nowMs + RECENT_REVEAL_TTL_MS });
    try {
      onReveal?.(evt);
    } catch {
      // ignore
    }
    return evt;
  }

  /** Wipes the active pack's dex, roster and history (other packs keep their collections). */
  function resetCollection() {
    const pid = packId();
    for (const k of Object.keys(state.roster)) if (k.startsWith(`${pid}|`)) delete state.roster[k];
    delete state.dex[pid];
    state.history = state.history.filter((h) => (h.pack || LEGACY_PACK_ID) !== pid);
    recent.length = 0;
    bootstrapping = true; // current agents re-register silently on the next scan
    scheduleSave();
  }

  function flush() {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveNow();
  }

  return {
    resolve,
    peek,
    finishBootstrap,
    getRecent,
    getPublicState,
    updateSettings,
    assign,
    demoPull,
    resetCollection,
    flush,
    get activePackId() {
      return packId();
    },
    get isBootstrapping() {
      return bootstrapping;
    },
    get settings() {
      return { ...state.settings, activePack: packId() || state.settings.activePack };
    }
  };
}
