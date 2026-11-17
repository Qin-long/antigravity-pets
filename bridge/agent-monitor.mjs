#!/usr/bin/env node
/**
 * Pokémon Agent Monitor — Live Antigravity Agent State Bridge (v4.1 Context/Cache Rings + Silent Summon)
 * Zero-dependency Node.js ES module serving `http://127.0.0.1:17580`.
 *
 * Implements v4.1 Per-Agent Context/Cache Telemetry + Summon Overlay + v4.0 Single Shared Overlay + v3.0 Queues:
 *   1. Per-Agent Live Context & Cache-Hit Metrics (`agent.context`):
 *      Extracts exact `input_tokens`, `cache_read_tokens`, and `output_tokens` from `transcript.jsonl`
 *      (`PLANNER_RESPONSE` steps + mid-turn delta estimation) to power concentric circular progress rings:
 *        - 🔴 Red circular bar (`usedPct` = `usedTokens / maxTokens`): Used Context (`已用上下文`)
 *        - 🟢 Green circular bar (`cacheHitPct` = `cachedTokens / promptTokens`): Prompt Cache Hit (`缓存命中`)
 *   2. Explicit Silent Overlay Summon (`POST /api/summon-overlay` -> unmutes + SSE `event: summon-overlay`):
 *      Clears `%TEMP%\antigravity-pokemon-desktop-overlay-muted.json` and broadcasts `summon-overlay` so
 *      `WinSta0\Default` hosts launch the single shared WPF overlay via `wscript.exe //B silent-launch.vbs`
 *      with ZERO `cmd.exe` or Windows Terminal popups.
 *   3. Single Shared Overlay Hub (`mode: "single-shared-overlay"`) + Double-Click `leadAgent` (`POST /api/focus-session`)
 *      + Global Theme Sync (`POST /api/theme`) + All 6 v3.0 Multi-Session Queue Invariants preserved.
 *   4. Safety: Never spawns GUI or console processes.
 *
 * Endpoints (CORS only for allow-listed origins — the bridge's own pages and the IDE; cross-site browser
 * requests are rejected, see `bridge/http-guard.mjs`):
 *   - `GET    /health`             -> Server health, v4.1 capabilities, `activeTheme`, `summonRequestedAt`, & uptime
 *   - `GET    /api/agents`         -> `projects`, `queues`, `summary`, `agents` (each with `context`), `activeTheme`, `lastSummonRequest`
 *   - `GET    /api/events`         -> SSE stream (`snapshot`, `focus-session`, `theme-change`, `summon-overlay`)
 *   - `POST   /api/summon-overlay` -> Unmute & broadcast silent overlay summon command (`GET`/`DELETE` & `/api/summon-desktop-pet` alias)
 *   - `POST   /api/focus-session`  -> Resolve & broadcast session/project pop-up command (`GET`/`DELETE` also supported)
 *   - `POST   /api/theme`          -> Get/set global `activeTheme` across floating overlay & IDE windows
 *   - `POST   /api/ui-sync`        -> Multi-window DOM state + window registry + live theme sync (`8s` TTL)
 *   - `DELETE /api/ui-sync`        -> Clear UI DOM sync state (`?windowId=` optional)
 *   - `POST   /api/simulate`       -> Simulate multi-project queues, `context` rings, `idleMs` TTL, species, or theme
 *   - `DELETE /api/simulate`       -> Reset all simulations
 *   - `POST   /api/hook`           -> Fast-path lifecycle updates from `hook-handler.mjs`
 *   - `GET    /static/*`           -> Safe read-only static file serving from workspace root
 */

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  unlinkSync,
  watch
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ANTIGRAVITY_CONTEXT_TIERS,
  ANTIGRAVITY_DEFAULT_CONTEXT_TOKENS,
  cascadeIdFromTranscriptPath,
  readConversationContextWindow
} from './context-window.mjs';
import { createGachaEngine, RARITY_META } from './pokemon-gacha.mjs';
import { readCacheLedger } from './cache-ledger.mjs';
import { createIdeSession } from './ide-session.mjs';
import { createHttpGuard, STATIC_ALLOWED_DIRS } from './http-guard.mjs';
import { assignCreature, createPackRegistry, describePack, safePackPath } from './pet-packs.mjs';

// Optional built-in `node:sqlite` loader (Node v22.5+ / v24+) for reading `conversation_summaries.db`
let DatabaseSyncClass = null;
try {
  const sqliteMod = await import('node:sqlite');
  DatabaseSyncClass = sqliteMod?.DatabaseSync || null;
} catch {
  DatabaseSyncClass = null;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, '..');

// Parse CLI flags & env vars
const argv = process.argv.slice(2);
function getFlagValue(flag, fallback) {
  const idx = argv.indexOf(flag);
  if (idx !== -1 && idx + 1 < argv.length) return argv[idx + 1];
  return fallback;
}
const HOST = getFlagValue('--host', process.env.POKEMON_BRIDGE_HOST || '127.0.0.1');
const PORT = Number(getFlagValue('--port', process.env.POKEMON_BRIDGE_PORT || 17580));
const ONCE_MODE = argv.includes('--once');
const STRICT_PORT = argv.includes('--strict-port');
// IDE binding: `--bind-ide` (set by the IDE extension) exits with the IDE; `--standalone` opts out entirely.
// Without either flag the bridge still binds itself as soon as an IDE window connects.
const BIND_IDE = argv.includes('--bind-ide') || process.env.POKEMON_BIND_IDE === '1';
const STANDALONE = argv.includes('--standalone');
// Extra browser origins allowed to call the API (e.g. a sidecar UI host): `--allow-origin a,b`.
const EXTRA_ALLOWED_ORIGINS = String(getFlagValue('--allow-origin', process.env.POKEMON_ALLOW_ORIGINS || ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const HOST_EXES = String(getFlagValue('--host-exe', process.env.POKEMON_HOST_EXE || ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const GEMINI_DIR = join(homedir(), '.gemini');
const BRAIN_ROOTS = [
  join(GEMINI_DIR, 'antigravity', 'brain'),
  join(GEMINI_DIR, 'antigravity-ide', 'brain'),
  join(GEMINI_DIR, 'antigravity-cli', 'brain')
];
const SUMMARIES_DB_PATH = join(GEMINI_DIR, 'antigravity', 'conversation_summaries.db');
const HOOK_STATE_FILE = join(GEMINI_DIR, 'antigravity', 'pokemon-hook-state.json');

// Skin packs: the creature roster (ids, names, rarity, sprites, shiny looks) comes from the active pack.
export const petPacks = createPackRegistry({ builtinDir: join(WORKSPACE_ROOT, 'packs') });
function activePack() {
  return petPacks.resolveActive(gacha?.settings?.activePack);
}
/** True if `species` is a creature of the active pack. */
export function isPackSpecies(species) {
  const p = activePack();
  return Boolean(p && species && p.creatures.some((c) => c.id === String(species)));
}
export function activeSpeciesIds() {
  return activePack()?.creatures.map((c) => c.id) || [];
}

export const VALID_THEMES = new Set([
  'pikachu',
  'gengar',
  'charizard',
  'umbreon',
  'mewtwo',
  'rotom-light',
  'rotom',
  'eevee'
]);

export const VALID_STATES = new Set([
  'thinking',
  'working',
  'sleeping',
  'celebrating',
  'error'
]);

export const SUBAGENT_IDLE_TTL_MS = 60 * 1000;        // Rule 4: > 60,000ms sleeping subagent auto-removed
export const INACTIVE_QUEUE_RETIRE_MS = 60 * 1000;    // Rule 5: Retire background queue when no subagents & lead idle > 60s
const POLL_INTERVAL_MS = 1500;                        // 1.5s fallback cadence (fs.watch provides 60ms real-time updates)
const FS_WATCH_DEBOUNCE_MS = 60;                      // 60ms debounce on fs.watch events
const UI_SYNC_TTL_MS = 90 * 1000;                     // 90s TTL so minimized Chromium windows stay bound across background throttling
const FOCUS_REQUEST_TTL_MS = 15 * 1000;               // 15s TTL for `lastFocusRequest` polling fallback
const SUMMON_REQUEST_TTL_MS = 30 * 1000;              // 30s TTL for `lastSummonRequest` / `summonRequestedAt`
const PROMPT_CACHE_WARM_TTL_MS = 300 * 1000;          // 5-minute LLM KV-cache warm TTL window
const CANDIDATE_SCAN_WINDOW_MS = 6 * 60 * 60 * 1000;  // Scan candidate sessions modified within last 6h
const STALE_WORKING_GUARD_MS = 90 * 1000;             // > 90s with zero transcript activity -> sleeping
const IDLE_SLEEP_THRESHOLD_MS = 20 * 1000;            // > 20s idle threshold
const CELEBRATE_WINDOW_MS = 3 * 1000;                 // 3s celebration sparkle right after turn completion
const POST_TOOL_FLASH_MS = 650;                       // Brief Working flash for ultra-fast synchronous tools before Thinking
const TRANSCRIPT_TAIL_BYTES = 98304;                  // Read last 96KB of JSONL for O(1) speed + token telemetry
const TRANSCRIPT_HEAD_BYTES = 24576;                  // Read first 24KB once per conv for workspace & prompt fallback
const OVERLAY_MUTE_FILE = join(tmpdir(), 'antigravity-pokemon-desktop-overlay-muted.json');
const OVERLAY_STATE_FILE = join(tmpdir(), 'antigravity-pokemon-desktop-overlay-state.json');
const SILENT_LAUNCH_VBS = join(WORKSPACE_ROOT, 'desktop-pet', 'silent-launch.vbs');
const LAUNCH_DESKTOP_PET_PS1 = join(WORKSPACE_ROOT, 'desktop-pet', 'launch-desktop-pet.ps1');
const GACHA_COLLECTION_FILE = join(GEMINI_DIR, 'antigravity', 'pokemon-collection.json');

const DEFAULT_GLOBAL_PROJECT_NAME = '全局会话';
const DEFAULT_GLOBAL_PROJECT_ID = 'global-sessions';

// Caches & live state maps
const transcriptCache = new Map();       // filePath -> { size, mtimeMs, entries } (bounded LRU)
const transcriptHeadCache = new Map();   // convId -> { workspacePath, firstPrompt } (bounded)
const subagentDirCache = new Map();      // convId -> { dirMtimeMs, childIds: string[], workspaceUri: string, entries: object[] }
const oldConvSubagentScanned = new Set(); // convIds whose old (>24h) subagent dir was already claimed
const idleStateTracker = new Map();      // agentId -> { lastState, sleepEnteredAtMs }
const hookUpdates = new Map();           // convId -> hook update object
const uiSyncWindows = new Map();         // windowId -> synced window state
const simulationOverrides = new Map();   // idOrName -> per-agent simulation override
const simulatedQueues = new Map();       // conversationId -> simulated queue spec
const speciesPreferences = new Map();    // idOrName -> pokemonSpecies (sticky)
const sseClients = new Set();
const activeWatchers = new Map();        // dirPath -> FSWatcher

let dbSummariesCache = new Map();        // convId -> summary row
let lastDbMtimeKey = '';
let lastScanAtMs = 0;
let scanDirty = true;
const SCAN_MIN_INTERVAL_MS = 350;
let currentLaunchAtMs = Date.now();    // Cutoff for "conversations active in this Antigravity launch"
const activatedThisLaunchConvIds = new Set(); // Conversations that had real activity since currentLaunchAtMs

function refreshHostLaunchTimestampSync() {
  if (process.platform !== 'win32' || ONCE_MODE) return;
  try {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$p=Get-Process -Name 'Antigravity','Antigravity IDE' -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if($p){[DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds()}"
      ],
      { windowsHide: true, timeout: 4000 },
      (err, stdout) => {
        const ms = Number(String(stdout || '').trim());
        if (!err && Number.isFinite(ms) && ms > 0) {
          currentLaunchAtMs = Math.min(currentLaunchAtMs, ms);
        }
      }
    );
  } catch {
    // keep default Date.now()
  }
}
refreshHostLaunchTimestampSync();

// v4.0 / v4.1 Global Theme, Focus-Session, & Summon-Overlay State
// IDE extension liveness (it polls `/api/agents?client=ide-extension` every ~0.8s) + open-stage requests.
let openStageRequestedAtMs = 0;
let openStageTarget = null;
// Visibility + lifecycle bound to Antigravity IDE windows (see bridge/ide-session.mjs).
const ideSession = createIdeSession({
  bindFromArgv: BIND_IDE,
  standalone: STANDALONE || ONCE_MODE,
  hostExes: HOST_EXES,
  onAllHostsGone: (reason) => shutdownWithIde(reason)
});
let shuttingDownWithIde = false;
function shutdownWithIde(reason) {
  if (shuttingDownWithIde) return;
  shuttingDownWithIde = true;
  console.log(`[pokemon-agent-monitor] Antigravity IDE closed (${reason}) -> shutting down.`);
  try {
    gacha.flush();
  } catch {
    // ignore
  }
  setTimeout(() => {
    trySwapStagedAppAsar();
    process.exit(0);
  }, 400);
}

const HOST_WATCH_INTERVAL_MS = 8000;
const AUTO_OVERLAY_COOLDOWN_MS = 15_000;
const IGNORED_HOST_WINDOW_TITLES = new Set([
  'n/a',
  '暂缺',
  'olemainthreadwndname',
  'default ime',
  'msctfime ui'
]);

let hostWatchInFlight = false;
let prevHadOpenHostWindow = false;
let wasHostOpenBeforeClose = false;
let consecutiveNoWindowChecks = 0;
let allWindowsClosedOnce = false;
let lastAutoOverlaySpawnMs = 0;

function decodeWindowsCliOutput(buf) {
  if (!buf || !buf.length) return '';
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return buf.toString('utf8');
    }
  }
}

function parseCsvRow(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

function queryHostExeTasklist(exeName) {
  return new Promise((resolveResult) => {
    execFile(
      'tasklist',
      ['/FO', 'CSV', '/NH', '/V', '/FI', `IMAGENAME eq ${exeName}`],
      { windowsHide: true, timeout: 3000, encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && (!stdout || !stdout.length)) {
          resolveResult({ ok: false, rows: [] });
          return;
        }
        const text = decodeWindowsCliOutput(stdout);
        const rows = [];
        for (const rawLine of text.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || !line.startsWith('"')) continue;
          const cols = parseCsvRow(line);
          if (cols.length < 9) continue;
          const image = String(cols[0] || '').trim().toLowerCase();
          if (image !== 'antigravity.exe' && image !== 'antigravity ide.exe') continue;
          const title = String(cols[cols.length - 1] || '').trim();
          rows.push({ image, title });
        }
        resolveResult({ ok: !err, rows });
      }
    );
  });
}

function isOverlayProcessAlive() {
  if (!existsSync(OVERLAY_STATE_FILE)) return false;
  try {
    const raw = readFileSync(OVERLAY_STATE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const state = JSON.parse(raw);
    const pid = Number(state?.pid);
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err?.code === 'EPERM';
    }
  } catch {
    return false;
  }
}

function shouldClearMuteOnReopen() {
  if (!existsSync(OVERLAY_MUTE_FILE)) return false;
  try {
    const raw = readFileSync(OVERLAY_MUTE_FILE, 'utf8').replace(/^\uFEFF/, '');
    const mute = JSON.parse(raw);
    return mute?.reason === 'user-closed' || mute?.reason === 'stop-pets';
  } catch {
    return false;
  }
}

function trySwapStagedAppAsar() {
  if (process.platform !== 'win32') return false;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return false;
  const resourcesDir = join(localAppData, 'Programs', 'antigravity', 'resources');
  const stagedPath = join(resourcesDir, 'app.asar.pokemon-new');
  const targetPath = join(resourcesDir, 'app.asar');
  const oldPath = join(resourcesDir, 'app.asar.pokemon-old');
  if (!existsSync(stagedPath)) return false;

  try {
    if (existsSync(oldPath)) {
      try {
        unlinkSync(oldPath);
      } catch {
        // ignore stale backup unlink failure
      }
    }
    if (existsSync(targetPath)) {
      renameSync(targetPath, oldPath);
    }
    renameSync(stagedPath, targetPath);
    try {
      if (existsSync(oldPath)) unlinkSync(oldPath);
    } catch {
      // best-effort cleanup
    }
    console.log('[pokemon-agent-monitor] Swapped staged app.asar.pokemon-new -> app.asar');
    return true;
  } catch (err) {
    try {
      if (!existsSync(targetPath) && existsSync(oldPath)) {
        renameSync(oldPath, targetPath);
      }
    } catch {
      // ignore rollback failure
    }
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      return false;
    }
    return false;
  }
}

async function tickHostWindowWatcher() {
  if (process.platform !== 'win32' || ONCE_MODE || hostWatchInFlight) return;
  hostWatchInFlight = true;
  try {
    const nowCheckMs = Date.now();
    const stagedAsarExists =
      existsSync(join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources', 'app.asar.pokemon-new'));
    const hasRecentUiHeartbeat =
      (agyAppSeenAtMs > 0 && nowCheckMs - agyAppSeenAtMs < 12000) ||
      Array.from(uiSyncWindows.values()).some((w) => w && Number(w.expiresAtMs || 0) > nowCheckMs);

    // Fast path: when UI heartbeat is fresh, overlay is alive, and no staged asar swap is waiting,
    // skip spawning two heavy `tasklist /V` child processes every cycle.
    if (hasRecentUiHeartbeat && !allWindowsClosedOnce && !stagedAsarExists && isOverlayProcessAlive()) {
      consecutiveNoWindowChecks = 0;
      wasHostOpenBeforeClose = true;
      prevHadOpenHostWindow = true;
      return;
    }

    const [agyRes, ideRes] = await Promise.all([
      queryHostExeTasklist('Antigravity.exe'),
      queryHostExeTasklist('Antigravity IDE.exe')
    ]);
    if (!agyRes.ok && !ideRes.ok) return;

    const allRows = [...agyRes.rows, ...ideRes.rows];
    const agyAppProcCount = agyRes.rows.filter((r) => r.image === 'antigravity.exe').length;
    const totalHostProcCount = allRows.length;
    void totalHostProcCount;

    if (agyRes.ok && agyAppProcCount === 0) {
      trySwapStagedAppAsar();
    }

    let hasOpenHostWindow = false;
    for (const row of allRows) {
      if (!row.title) continue;
      if (!IGNORED_HOST_WINDOW_TITLES.has(row.title.toLowerCase())) {
        hasOpenHostWindow = true;
        break;
      }
    }

    if (hasOpenHostWindow) {
      consecutiveNoWindowChecks = 0;
      wasHostOpenBeforeClose = true;

      if (allWindowsClosedOnce) {
        if (shouldClearMuteOnReopen()) {
          try {
            unlinkSync(OVERLAY_MUTE_FILE);
          } catch {
            // ignore if concurrently removed
          }
        }
        // Reset launch scope on fresh reopen after all host windows closed
        activatedThisLaunchConvIds.clear();
        currentLaunchAtMs = Date.now();
        allWindowsClosedOnce = false;
      }

      const overlayAlive = isOverlayProcessAlive();
      const isMuted = existsSync(OVERLAY_MUTE_FILE);
      const nowMs = Date.now();
      if (
        !overlayAlive &&
        !isMuted &&
        nowMs - lastAutoOverlaySpawnMs >= AUTO_OVERLAY_COOLDOWN_MS &&
        existsSync(SILENT_LAUNCH_VBS) &&
        existsSync(LAUNCH_DESKTOP_PET_PS1)
      ) {
        lastAutoOverlaySpawnMs = nowMs;
        execFile(
          'wscript.exe',
          [
            '//B',
            '//Nologo',
            SILENT_LAUNCH_VBS,
            'powershell.exe',
            '-STA',
            '-NoProfile',
            '-NonInteractive',
            '-WindowStyle',
            'Hidden',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            LAUNCH_DESKTOP_PET_PS1,
            '-BindToIde',
            '-FromWatchdog'
          ],
          { windowsHide: true, cwd: WORKSPACE_ROOT, timeout: 5000 },
          () => {}
        );
      }
    } else if (wasHostOpenBeforeClose || prevHadOpenHostWindow) {
      consecutiveNoWindowChecks += 1;
      if (consecutiveNoWindowChecks >= 2) {
        allWindowsClosedOnce = true;
      }
    }

    prevHadOpenHostWindow = hasOpenHostWindow;
  } catch {
    // keep host watcher resilient
  } finally {
    hostWatchInFlight = false;
  }
}

function startHostWindowWatcher() {
  if (process.platform !== 'win32' || ONCE_MODE) return;
  const hostWatchTimer = setInterval(() => {
    tickHostWindowWatcher().catch(() => {});
  }, HOST_WATCH_INTERVAL_MS);
  hostWatchTimer.unref?.();
  tickHostWindowWatcher().catch(() => {});
}

let activeTheme = process.env.POKEMON_THEME || 'mewtwo';
let activeThemeUpdatedAtMs = 0;
let activeThemeSource = 'default';
// Antigravity app (Antigravity.exe) liveness, from its sidecar / main-process hook `/health?client=agy-app` pings.
// Decides whether a double-click jump goes to the app or to the IDE.
const AGY_APP_ALIVE_MS = 45 * 1000;
let agyAppSeenAtMs = 0;
let agyAppMainPid = 0;
let focusRequestSeq = 0;
let lastFocusRequest = null;            // { requestId, requestedAt, expiresAtMs, ...target }
let summonRequestSeq = 0;
let lastSummonRequest = null;            // { requestId, summonSeq, requestedAt, expiresAtMs, ... }

const startedAtMs = Date.now();
let lastSnapshotSignature = '';
let cachedSnapshot = null;
let watchDebounceTimer = null;

function broadcastSseEvent(eventName, data) {
  if (sseClients.size === 0) return;
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// Pokémon gacha: every newly-seen agent draws a partner (persisted roster + Pokédex, rare shiny rolls)
const gacha = createGachaEngine({
  filePath: ONCE_MODE ? null : GACHA_COLLECTION_FILE,
  packs: petPacks,
  legacySpecies: (info) => assignPokemonSpecies(info.id, info.name, info.role, info.isLead),
  onReveal: (evt) => broadcastSseEvent('gacha', evt)
});

function applyGachaToVisibleQueues(items, nowMs) {
  const occupiedSpecies = new Set();
  for (const it of items) {
    for (const m of it.queue.members) {
      if (!m.gachaKey && m.pokemonSpecies && !occupiedSpecies.has(m.pokemonSpecies)) {
        occupiedSpecies.add(m.pokemonSpecies);
      }
    }
  }
  for (const it of items) {
    const q = it.queue;
    for (const m of q.members) {
      if (!m.gachaKey) {
        if (m.pokemonSpecies && occupiedSpecies.has(m.pokemonSpecies)) {
          // Even explicit/simulated entries must not collide on screen
          const g = gacha.resolve(
            {
              key: `uniq:${m.id}`,
              id: m.id,
              name: m.name,
              role: m.role,
              isLead: m.isLead,
              conversationId: q.conversationId,
              conversationTitle: q.conversationTitle,
              projectName: q.projectName,
              demo: false
            },
            nowMs,
            { excludeSpecies: occupiedSpecies }
          );
          if (g.species) m.pokemonSpecies = g.species;
        }
        if (m.pokemonSpecies) occupiedSpecies.add(m.pokemonSpecies);
        continue;
      }
      const g = gacha.resolve(
        {
          key: m.gachaKey,
          id: m.id,
          name: m.name,
          role: m.role,
          isLead: m.isLead,
          conversationId: q.conversationId,
          conversationTitle: q.conversationTitle,
          projectName: q.projectName,
          demo: m.source === 'simulated'
        },
        nowMs,
        { excludeSpecies: occupiedSpecies }
      );
      m.pokemonSpecies = g.species;
      m.shiny = g.shiny;
      m.rarity = g.rarity;
      m.gachaRevealSeq = g.revealSeq;
      if (m.pokemonSpecies) occupiedSpecies.add(m.pokemonSpecies);
    }
  }
}

function resolveGachaPartner(rawObj, isLead, queueInfo, nowMs) {
  if (rawObj._explicitSpecies && isPackSpecies(rawObj.pokemonSpecies)) {
    return { pokemonSpecies: rawObj.pokemonSpecies, shiny: Boolean(rawObj.shiny), rarity: null, gachaKey: null, gachaRevealSeq: 0 };
  }
  // Peek only: the actual draw happens in `applyGachaToVisibleQueues` once we know which queues are displayed.
  const g = gacha.peek(
    {
      id: rawObj.id,
      name: rawObj.name,
      role: rawObj.role,
      isLead,
      conversationId: queueInfo.conversationId,
      conversationTitle: queueInfo.conversationTitle,
      projectName: queueInfo.projectName,
      demo: rawObj.source === 'simulated'
    },
    nowMs
  );
  return {
    pokemonSpecies: g.species,
    shiny: g.shiny,
    rarity: g.rarity,
    gachaKey: g.key,
    gachaRevealSeq: g.revealSeq
  };
}

/**
 * Normalize theme ID (preserving the 6 official skin IDs `pikachu`, `gengar`, `charizard`, `umbreon`, `mewtwo`, `rotom-light`).
 */
export function normalizeThemeId(rawTheme = '') {
  const t = String(rawTheme || '').trim().toLowerCase();
  if (!t) return '';
  if (t === 'rotom') return 'rotom-light';
  return VALID_THEMES.has(t) ? t : '';
}

function setGlobalActiveTheme(rawTheme, source = 'api', nowMs = Date.now()) {
  const norm = normalizeThemeId(rawTheme);
  if (!norm) return false;
  const changed = norm !== activeTheme;
  activeTheme = norm;
  activeThemeUpdatedAtMs = nowMs;
  activeThemeSource = source;
  if (changed && sseClients.size > 0) {
    const evt = JSON.stringify({
      theme: activeTheme,
      source: activeThemeSource,
      updatedAt: new Date(nowMs).toISOString()
    });
    const payload = `event: theme-change\ndata: ${evt}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }
  return changed;
}

function getPublicFocusRequest(nowMs = Date.now()) {
  if (!lastFocusRequest) return null;
  if (Number(lastFocusRequest.expiresAtMs || 0) <= nowMs) {
    lastFocusRequest = null;
    return null;
  }
  const { expiresAtMs: _exp, ...pub } = lastFocusRequest;
  return pub;
}

// Ring buffer of focus-session execution reports posted back by injected windows (`POST /api/focus-ack`)
const FOCUS_ACK_LIMIT = 30;
const focusAcks = [];
function recordFocusAck(body = {}, nowMs = Date.now()) {
  const pick = (v, max = 300) => (v === undefined || v === null ? null : String(v).slice(0, max));
  const ack = {
    receivedAt: new Date(nowMs).toISOString(),
    requestId: pick(body.requestId, 120),
    conversationId: pick(body.conversationId, 120),
    windowId: pick(body.windowId, 120),
    appKind: pick(body.appKind, 40),
    docTitle: pick(body.docTitle, 200),
    phase: pick(body.phase, 40),
    handled: Boolean(body.handled),
    stage: pick(body.stage, 60),
    action: pick(body.action, 60),
    reason: pick(body.reason, 300),
    routerSource: pick(body.routerSource, 40),
    location: pick(body.location, 300)
  };
  focusAcks.push(ack);
  while (focusAcks.length > FOCUS_ACK_LIMIT) focusAcks.shift();
  return ack;
}

function getPublicSummonRequest(nowMs = Date.now()) {
  if (!lastSummonRequest) return null;
  if (Number(lastSummonRequest.expiresAtMs || 0) <= nowMs) {
    lastSummonRequest = null;
    return null;
  }
  const { expiresAtMs: _exp, ...pub } = lastSummonRequest;
  return pub;
}

/**
 * Format compact token count (`0`, `850`, `24.5k`, `197k`, `1M`) for crisp UI badges & tooltips.
 */
export function formatCompactTokens(tokens = 0) {
  const n = Math.max(0, Math.round(Number(tokens) || 0));
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M` : `${m.toFixed(1).replace(/\.0$/, '')}M`;
  }
  if (n >= 100_000) {
    return `${Math.round(n / 1000)}k`;
  }
  if (n >= 1_000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return String(n);
}

/**
 * Resolve model context window capacity (`maxTokens`) from model identifier, auto-scaling if actual usage exceeds nominal cap.
 */
export function resolveModelMaxTokens(modelName = '', usedTokens = 0) {
  const lower = String(modelName || '').toLowerCase();
  // Antigravity's model picker defaults every Gemini/Carbon model to a 256K window (512K / 900K are opt-in tiers).
  // The real per-conversation value is read from `conversations/<id>.db` (see `context-window.mjs`); this is only the fallback.
  let cap = ANTIGRAVITY_DEFAULT_CONTEXT_TOKENS;
  if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('haiku')) {
    cap = 200_000;
  } else if (lower.includes('gpt-5') || lower.includes('codex') || lower.includes('o3') || lower.includes('o4')) {
    cap = 400_000;
  } else if (lower.includes('pokemon-simulator')) {
    cap = 200_000;
  }
  if (usedTokens > cap) {
    cap = ANTIGRAVITY_CONTEXT_TIERS.find((t) => t >= usedTokens) || Math.ceil(usedTokens / 100_000) * 100_000;
  }
  return cap;
}

/**
 * Normalize & build the canonical `agent.context` object powering concentric circular progress rings:
 *   - 🔴 Outer Red Ring (`usedPct`): Used Context (`已用上下文` = `usedTokens / maxTokens`)
 *   - 🟢 Inner Green Ring (`cacheHitPct`): Prompt Cache Hit (`缓存命中` = `cachedTokens / promptTokens`)
 */
export function buildAgentContextMetrics(rawMetrics = null, modelName = '', nowMs = Date.now(), explicitOverride = null) {
  const base = rawMetrics && typeof rawMetrics === 'object' ? rawMetrics : {};
  const ovr = explicitOverride && typeof explicitOverride === 'object' ? explicitOverride : null;

  let maxTokens =
    ovr?.maxTokens !== undefined && Number(ovr.maxTokens) > 0
      ? Math.round(Number(ovr.maxTokens))
      : base.maxTokens !== undefined && Number(base.maxTokens) > 0
        ? Math.round(Number(base.maxTokens))
        : 0;

  let cachedTokens = Math.max(
    0,
    Math.round(Number(ovr?.cachedTokens ?? ovr?.cacheHitTokens ?? base.cachedTokens ?? 0) || 0)
  );
  let uncachedTokens = Math.max(
    0,
    Math.round(Number(ovr?.uncachedTokens ?? ovr?.inputTokens ?? base.uncachedTokens ?? 0) || 0)
  );
  let outputTokens = Math.max(
    0,
    Math.round(Number(ovr?.outputTokens ?? base.outputTokens ?? 0) || 0)
  );
  const extraPendingTokens = Math.max(0, Math.round(Number(base.extraPendingTokens ?? 0) || 0));

  let promptTokens =
    ovr?.promptTokens !== undefined && Number.isFinite(Number(ovr.promptTokens))
      ? Math.max(0, Math.round(Number(ovr.promptTokens)))
      : base.promptTokens !== undefined && Number.isFinite(Number(base.promptTokens))
        ? Math.max(0, Math.round(Number(base.promptTokens)))
        : cachedTokens + uncachedTokens;

  let usedTokens =
    ovr?.usedTokens !== undefined && Number.isFinite(Number(ovr.usedTokens))
      ? Math.max(0, Math.round(Number(ovr.usedTokens)))
      : ovr?.contextUsedTokens !== undefined && Number.isFinite(Number(ovr.contextUsedTokens))
        ? Math.max(0, Math.round(Number(ovr.contextUsedTokens)))
        : base.usedTokens !== undefined && Number.isFinite(Number(base.usedTokens))
          ? Math.max(0, Math.round(Number(base.usedTokens)))
          : promptTokens + outputTokens + extraPendingTokens;

  if (!maxTokens) {
    maxTokens = resolveModelMaxTokens(modelName, usedTokens);
  } else if (usedTokens > maxTokens && ovr?.maxTokens === undefined) {
    maxTokens = resolveModelMaxTokens(modelName, usedTokens);
  }

  let usedPct;
  if (ovr?.usedPct !== undefined && Number.isFinite(Number(ovr.usedPct))) {
    usedPct = Math.min(100, Math.max(0, Math.round(Number(ovr.usedPct) * 10) / 10));
    if (ovr.usedTokens === undefined && ovr.contextUsedTokens === undefined) {
      usedTokens = Math.round((usedPct / 100) * maxTokens);
    }
  } else if (ovr?.contextUsedPct !== undefined && Number.isFinite(Number(ovr.contextUsedPct))) {
    usedPct = Math.min(100, Math.max(0, Math.round(Number(ovr.contextUsedPct) * 10) / 10));
    if (ovr.usedTokens === undefined && ovr.contextUsedTokens === undefined) {
      usedTokens = Math.round((usedPct / 100) * maxTokens);
    }
  } else {
    usedPct =
      maxTokens > 0
        ? Math.min(100, Math.max(0, Math.round((usedTokens / maxTokens) * 1000) / 10))
        : 0;
  }

  if (promptTokens <= 0 && usedTokens > 0) {
    promptTokens = Math.max(cachedTokens, usedTokens - outputTokens);
  }

  let cacheHitPct;
  if (ovr?.cacheHitPct !== undefined && Number.isFinite(Number(ovr.cacheHitPct))) {
    cacheHitPct = Math.min(100, Math.max(0, Math.round(Number(ovr.cacheHitPct) * 10) / 10));
    if (ovr.cachedTokens === undefined && ovr.cacheHitTokens === undefined && promptTokens > 0) {
      cachedTokens = Math.round((cacheHitPct / 100) * promptTokens);
      uncachedTokens = Math.max(0, promptTokens - cachedTokens);
    }
  } else {
    cacheHitPct =
      promptTokens > 0
        ? Math.min(100, Math.max(0, Math.round((cachedTokens / promptTokens) * 1000) / 10))
        : 0;
  }

  // Real per-conversation ledger (all requests). The ring shows the cumulative ratio
  // Σcache_read / Σ(input + cache_read); the last request's ratio is kept for the tooltip.
  const stats = base.cacheStats && typeof base.cacheStats === 'object' ? base.cacheStats : null;
  const lastRequestHitPct = cacheHitPct;
  const hasOverride = ovr?.cacheHitPct !== undefined || ovr?.cachedTokens !== undefined || ovr?.cacheHitTokens !== undefined;
  let cacheKnown = hasOverride || base.source === 'simulated' || base.source === 'transcript-tokens';
  if (!hasOverride && stats && stats.requests > 0) {
    cacheHitPct = Math.min(100, Math.max(0, Number(stats.cumulativeHitPct) || 0));
    cacheKnown = true;
  } else if (!hasOverride && base.source === 'transcript-estimate') {
    cacheHitPct = 0;
    cacheKnown = false;
  }

  const lastTokenAtMs = Number(ovr?.lastTokenAtMs ?? stats?.lastRequestAtMs ?? base.lastTokenAtMs ?? nowMs);
  const cacheWarm =
    ovr?.cacheWarm !== undefined
      ? Boolean(ovr.cacheWarm)
      : cacheKnown && Math.max(0, nowMs - lastTokenAtMs) <= PROMPT_CACHE_WARM_TTL_MS;

  const usedTokensLabel = formatCompactTokens(usedTokens);
  const maxTokensLabel = formatCompactTokens(maxTokens);
  const cachedTokensLabel = formatCompactTokens(stats && stats.requests > 0 ? stats.sumCachedTokens : cachedTokens);
  const usedLabel = `${usedTokensLabel} / ${maxTokensLabel}`;
  const cacheShort = cacheKnown ? `${Math.round(cacheHitPct)}%` : '—';
  const badgeText = `🔴 ${Math.round(usedPct)}% · 🟢 ${cacheShort}`;
  let cacheDetail;
  if (!cacheKnown) {
    cacheDetail = '🟢 缓存命中: 暂无数据（首个模型回复完成后开始统计）';
  } else if (stats && stats.requests > 0) {
    cacheDetail =
      `🟢 缓存命中(本会话累计 ${stats.requests} 次请求): ${cacheHitPct}% · ${cachedTokensLabel} / ${formatCompactTokens(stats.sumPromptTokens)}` +
      ` | 最近一次 ${stats.lastHitPct}% · 近 5 次 ${stats.recentHitPct}%` +
      ` | 冷启动未命中 ${stats.coldMisses} 次 | 缓存${cacheWarm ? '仍有效' : '已过期(下次请求将重新计费)'}`;
  } else {
    cacheDetail = `🟢 缓存命中: ${cachedTokensLabel} (${cacheHitPct}%)`;
  }
  const tooltipText = `🔴 已用上下文: ${usedLabel} (${usedPct}%) | ${cacheDetail}`;

  return {
    usedTokens,
    remainingTokens: Math.max(0, maxTokens - usedTokens),
    maxTokens,
    usedPct,
    cachedTokens,
    uncachedTokens,
    promptTokens,
    outputTokens,
    cacheHitPct,
    cacheKnown,
    cacheScope: stats && stats.requests > 0 ? 'conversation-cumulative' : 'last-request',
    cacheLastRequestPct: stats && stats.requests > 0 ? stats.lastHitPct : lastRequestHitPct,
    cacheRecentPct: stats && stats.requests > 0 ? stats.recentHitPct : lastRequestHitPct,
    cacheRequests: stats ? stats.requests : 0,
    cacheColdMisses: stats ? stats.coldMisses : 0,
    cacheWarm,
    tps: Number.isFinite(Number(ovr?.tps ?? base.tps)) ? Number(ovr?.tps ?? base.tps) : null,
    avgTps: Number.isFinite(Number(ovr?.avgTps ?? base.avgTps)) ? Number(ovr?.avgTps ?? base.avgTps) : null,
    ttfpMs: Number.isFinite(Number(ovr?.ttfpMs ?? base.ttfpMs)) ? Number(ovr?.ttfpMs ?? base.ttfpMs) : null,
    lastTurnDurationMs: Number.isFinite(Number(ovr?.lastTurnDurationMs ?? base.lastTurnDurationMs))
      ? Number(ovr?.lastTurnDurationMs ?? base.lastTurnDurationMs)
      : null,
    totalOutputTokens: Number.isFinite(Number(ovr?.totalOutputTokens ?? base.totalOutputTokens))
      ? Number(ovr?.totalOutputTokens ?? base.totalOutputTokens)
      : outputTokens,
    usedTokensLabel,
    maxTokensLabel,
    usedLabel,
    badgeText,
    tooltipText,
    source: String(ovr?.source || base.source || 'default')
  };
}

function extractPerfTelemetry(entries) {
  let tps = null;
  let avgTps = null;
  let ttfpMs = null;
  let lastTurnDurationMs = null;
  let totalOutputTokens = 0;

  if (!Array.isArray(entries) || entries.length === 0) {
    return { tps, avgTps, ttfpMs, lastTurnDurationMs, totalOutputTokens };
  }

  let sumOut = 0;
  let sumSec = 0;
  let recentSamples = 0;
  let lastUserTs = NaN;
  let lastPlannerAfterUserTs = NaN;
  let latestPlannerTs = NaN;

  for (let i = 0; i < entries.length; i++) {
    const s = entries[i];
    if (!s) continue;
    const ts = s.created_at ? Date.parse(s.created_at) : NaN;
    if (s.type === 'USER_INPUT' && Number.isFinite(ts)) {
      lastUserTs = ts;
      lastPlannerAfterUserTs = NaN;
    } else if (s.type === 'PLANNER_RESPONSE') {
      const outTok = Math.max(0, Math.round(Number(s.output_tokens) || 0));
      totalOutputTokens += outTok;
      if (Number.isFinite(ts)) {
        latestPlannerTs = ts;
        if (Number.isFinite(lastUserTs) && !Number.isFinite(lastPlannerAfterUserTs)) {
          lastPlannerAfterUserTs = ts;
          ttfpMs = Math.max(400, Math.min(180_000, ts - lastUserTs));
        }
        if (outTok > 0 && i > 0) {
          let prevTs = NaN;
          for (let k = i - 1; k >= Math.max(0, i - 3); k--) {
            const pts = entries[k]?.created_at ? Date.parse(entries[k].created_at) : NaN;
            if (Number.isFinite(pts)) {
              prevTs = pts;
              break;
            }
          }
          if (Number.isFinite(prevTs)) {
            const dtMs = Math.max(1000, Math.min(120_000, ts - prevTs));
            const curTps = Math.round((outTok / (dtMs / 1000)) * 10) / 10;
            tps = curTps;
            if (i >= entries.length - 16) {
              sumOut += outTok;
              sumSec += dtMs / 1000;
              recentSamples++;
            }
          }
        }
      }
    }
  }

  if (recentSamples > 0 && sumSec > 0) {
    avgTps = Math.round((sumOut / sumSec) * 10) / 10;
  }
  if (Number.isFinite(lastUserTs) && Number.isFinite(latestPlannerTs) && latestPlannerTs >= lastUserTs) {
    lastTurnDurationMs = Math.max(500, Math.min(600_000, latestPlannerTs - lastUserTs));
  }

  return { tps, avgTps, ttfpMs, lastTurnDurationMs, totalOutputTokens };
}

/**
 * Extract live token & KV-cache telemetry directly from `transcript.jsonl` tail entries.
 * Antigravity records exact `input_tokens`, `cache_read_tokens`, and `output_tokens` on `PLANNER_RESPONSE` steps!
 */
function extractTranscriptContextMetrics(stat, entries, nowMs = Date.now()) {
  if (!stat) return null;

  const perf = extractPerfTelemetry(entries);
  let tokenStepIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const step = entries[i];
    if (
      step &&
      (Number.isFinite(Number(step.input_tokens)) || Number.isFinite(Number(step.cache_read_tokens)))
    ) {
      tokenStepIdx = i;
      break;
    }
  }

  if (tokenStepIdx !== -1) {
    const step = entries[tokenStepIdx];
    const uncachedTokens = Math.max(0, Math.round(Number(step.input_tokens) || 0));
    const cachedTokens = Math.max(0, Math.round(Number(step.cache_read_tokens) || 0));
    const outputTokens = Math.max(0, Math.round(Number(step.output_tokens) || 0));
    const promptTokens = uncachedTokens + cachedTokens;

    // Account for any new tool outputs or user prompts appended after `tokenStepIdx` while next turn is in-flight
    let extraChars = 0;
    for (let j = tokenStepIdx + 1; j < entries.length; j++) {
      const s = entries[j];
      if (!s) continue;
      if (typeof s.content === 'string') extraChars += s.content.length;
      if (typeof s.thinking === 'string') extraChars += s.thinking.length;
      if (Array.isArray(s.tool_calls)) {
        try {
          extraChars += JSON.stringify(s.tool_calls).length;
        } catch {
          // ignore
        }
      }
    }
    const extraPendingTokens = Math.min(32_000, Math.round(extraChars / 4));
    const usedTokens = promptTokens + outputTokens + extraPendingTokens;
    const stepTs = step.created_at ? Date.parse(step.created_at) : NaN;
    const lastTokenAtMs = Number.isFinite(stepTs) ? stepTs : stat.mtimeMs;

    return {
      usedTokens,
      cachedTokens,
      uncachedTokens,
      promptTokens,
      outputTokens,
      extraPendingTokens,
      lastTokenAtMs,
      ...perf,
      source: 'transcript-tokens'
    };
  }

  // Brand-new conversation before the first model response: estimate size only.
  // Cache hits are unknown here — never invent a ratio.
  const estUsed = stat.size > 0 ? Math.max(120, Math.round(stat.size / 4)) : 0;
  return {
    usedTokens: estUsed,
    cachedTokens: 0,
    uncachedTokens: estUsed,
    promptTokens: estUsed,
    outputTokens: 0,
    extraPendingTokens: 0,
    lastTokenAtMs: stat.mtimeMs,
    ...perf,
    source: 'transcript-estimate'
  };
}

/**
 * Strip UI wrapper prefixes like `"Swarm Worker (indent-researcher)"` or `"Subagent (explorer)"`.
 */
export function normalizeAgentName(rawName = '') {
  const trimmed = String(rawName || '').trim();
  if (!trimmed) return '';
  const m = trimmed.match(/^(?:Swarm\s+Worker|Subagent|Worker|Agent)\s*\(([^)]+)\)$/i);
  if (m && m[1]) return m[1].trim();
  return trimmed;
}

/**
 * Normalize a workspace URI (`file:///c%3A/Users/...`) or filesystem path into clean `{ workspacePath, projectName, projectId }`.
 */
export function parseWorkspaceIdentity(rawUriOrPath = '', explicitProjectName = '') {
  let raw = String(rawUriOrPath || '').trim();
  if (raw.startsWith('[')) {
    try {
      const arr = JSON.parse(raw);
      raw = Array.isArray(arr) && arr.length > 0 ? String(arr[0] || '') : '';
    } catch {
      raw = '';
    }
  }

  let cleanPath = '';
  if (raw) {
    if (/^file:\/\//i.test(raw)) {
      try {
        cleanPath = fileURLToPath(raw);
      } catch {
        cleanPath = decodeURIComponent(raw.replace(/^file:\/\/\/?/i, ''));
      }
    } else {
      try {
        cleanPath = decodeURIComponent(raw);
      } catch {
        cleanPath = raw;
      }
    }
    cleanPath = cleanPath.replace(/\\/g, '/').replace(/\/+$/, '').trim();
    if (/^[A-Za-z]:\//.test(cleanPath)) {
      cleanPath = cleanPath[0].toLowerCase() + cleanPath.slice(1);
    }
  }

  const cleanExplicitName = String(explicitProjectName || '')
    .replace(/[\\/]+$/, '')
    .trim();

  if (cleanPath) {
    const folderName =
      cleanExplicitName || cleanPath.split('/').filter(Boolean).pop() || DEFAULT_GLOBAL_PROJECT_NAME;
    return {
      workspacePath: cleanPath,
      projectName: folderName,
      projectId: cleanPath.toLowerCase()
    };
  }

  if (cleanExplicitName && cleanExplicitName !== 'Workspace' && cleanExplicitName !== 'Antigravity') {
    return {
      workspacePath: '',
      projectName: cleanExplicitName,
      projectId: `project:${cleanExplicitName.toLowerCase()}`
    };
  }

  return {
    workspacePath: '',
    projectName: DEFAULT_GLOBAL_PROJECT_NAME,
    projectId: DEFAULT_GLOBAL_PROJECT_ID
  };
}

/**
 * Clean up raw prompt / preview text into a crisp human-readable conversation title.
 */
function sanitizeConversationTitle(rawTitle = '') {
  let s = String(rawTitle || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/@\[[^\]]+\]/g, ' ')
    .replace(/^\/\S+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (
    !s ||
    /^(untitled conversation|new conversation|loading\.{0,3}|conversation|antigravity|antigravity ide)$/i.test(s)
  ) {
    return '';
  }
  if (s.length > 54) {
    s = s.slice(0, 52).trim() + '…';
  }
  return s;
}

/**
 * Deterministic & role-aware Pokémon species assignment so every agent gets an iconic partner.
 */
export function assignPokemonSpecies(id = '', name = '', role = '', isLead = false) {
  const cleanName = normalizeAgentName(name);
  for (const k of [id, cleanName, name]) {
    if (k && speciesPreferences.has(k) && isPackSpecies(speciesPreferences.get(k))) return speciesPreferences.get(k);
  }

  const pack = activePack();
  if (!pack) return '';
  return assignCreature(pack, { id, name: cleanName, role, isLead });
}

/**
 * Friendly Chinese + exact tool-name label for tool calls in status bubbles.
 */
function formatToolAction(toolCall) {
  if (!toolCall || typeof toolCall !== 'object') return '执行工具 (tool)';
  const name = String(toolCall.name || 'tool');
  const args = toolCall.args || {};

  const unquote = (val) => String(val ?? '').replace(/^"+|"+$/g, '').trim();
  const baseName = (p) => unquote(p).split(/[\\/]/).filter(Boolean).pop() || '';

  switch (name) {
    case 'run_command': {
      const summary = unquote(args.toolSummary || args.CommandLine);
      return summary ? `run_command · ${summary.slice(0, 24)}` : '执行终端指令 (run_command)';
    }
    case 'write_file':
    case 'write_to_file': {
      const file = baseName(args.Path || args.TargetFile);
      return file ? `${name} · 写入 ${file}` : `创建文件 (${name})`;
    }
    case 'edit_file':
    case 'replace_file_content':
    case 'multi_replace_file_content': {
      const file = baseName(args.Path || args.TargetFile);
      return file ? `${name} · 编辑 ${file}` : `修改代码 (${name})`;
    }
    case 'read_file':
    case 'view_file': {
      const file = baseName(args.Path || args.AbsolutePath);
      return file ? `${name} · 读取 ${file}` : `读取文件 (${name})`;
    }
    case 'grep_search':
    case 'find_by_name': {
      const q = unquote(args.Query || args.Pattern);
      return q ? `${name} · 检索 ${q.slice(0, 18)}` : `代码检索 (${name})`;
    }
    case 'invoke_subagent':
      return 'invoke_subagent · 调度子智能体';
    case 'post_message':
      return 'post_message · 发送战队电报';
    case 'read_board':
      return 'read_board · 读取留言板';
    case 'swarm':
      return `swarm · 编排战队 (${unquote(args.action) || 'action'})`;
    case 'search_web':
      return `search_web · 检索 ${unquote(args.query).slice(0, 18)}`;
    default:
      return `调用工具 (${name})`;
  }
}

/**
 * Sync conversation titles, workspace URIs, and parent-child links from `conversation_summaries.db` (read-only, zero lock retention).
 */
function syncConversationSummariesDb() {
  if (!DatabaseSyncClass || !existsSync(SUMMARIES_DB_PATH)) return dbSummariesCache;
  let mtimeKey = '';
  try {
    const dbSt = statSync(SUMMARIES_DB_PATH);
    const walPath = `${SUMMARIES_DB_PATH}-wal`;
    const walMtime = existsSync(walPath) ? statSync(walPath).mtimeMs : 0;
    const walSize = existsSync(walPath) ? statSync(walPath).size : 0;
    mtimeKey = `${dbSt.mtimeMs}|${dbSt.size}|${walMtime}|${walSize}`;
  } catch {
    return dbSummariesCache;
  }

  if (mtimeKey === lastDbMtimeKey && dbSummariesCache.size > 0) {
    return dbSummariesCache;
  }

  let db = null;
  try {
    db = new DatabaseSyncClass(SUMMARIES_DB_PATH, { open: true, readOnly: true });
    const rows = db
      .prepare(
        `SELECT conversation_id, title, substr(preview, 1, 140) AS preview, workspace_uris, status, project_id, agent_name, parent_conversation_id, killed, last_modified_time
         FROM conversation_summaries
         ORDER BY last_modified_time DESC
         LIMIT 300`
      )
      .all();
    const nextMap = new Map();
    for (const r of rows) {
      if (r?.conversation_id) {
        nextMap.set(String(r.conversation_id), r);
      }
    }
    dbSummariesCache = nextMap;
    lastDbMtimeKey = mtimeKey;
  } catch {
    // Graceful fallback if SQLite is momentarily busy
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }
  return dbSummariesCache;
}

/**
 * Read the first 24KB of `transcript.jsonl` once per conversation as a pure-JS fallback for workspace & initial user request.
 */
function readTranscriptHeadMetadata(convId, transcriptPath) {
  if (transcriptHeadCache.has(convId)) {
    return transcriptHeadCache.get(convId);
  }
  let fd = null;
  let workspacePath = '';
  let firstPrompt = '';
  try {
    const st = statSync(transcriptPath);
    if (st.isFile() && st.size > 0) {
      fd = openSync(transcriptPath, 'r');
      const len = Math.min(st.size, TRANSCRIPT_HEAD_BYTES);
      const buf = Buffer.alloc(len);
      const n = readSync(fd, buf, 0, len, 0);
      const raw = buf.toString('utf8', 0, n);

      const wsMatch =
        raw.match(/Active Workspaces:(?:\\r)?\\n-\s*([^\r\n"\\]+(?:[\\/][^\r\n"\\]+)*)/i) ||
        raw.match(/Active Workspaces:\r?\n-\s*([^\r\n]+)/i) ||
        raw.match(/Command Working Directory:\s*([^\r\n"\\]+(?:[\\/][^\r\n"\\]+)*)/i);
      if (wsMatch && wsMatch[1]) {
        workspacePath = wsMatch[1].replace(/\\\\/g, '/').replace(/\\/g, '/').trim();
      }

      const reqMatch = raw.match(/<USER_REQUEST>([\s\S]{1,300}?)(?:<\/USER_REQUEST>|$)/i);
      if (reqMatch && reqMatch[1]) {
        firstPrompt = sanitizeConversationTitle(reqMatch[1].replace(/\\n/g, ' '));
      }
    }
  } catch {
    // ignore
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  const meta = { workspacePath, firstPrompt };
  if (workspacePath || firstPrompt) {
    if (transcriptHeadCache.size > 300) {
      transcriptHeadCache.delete(transcriptHeadCache.keys().next().value);
    }
    transcriptHeadCache.set(convId, meta);
  }
  return meta;
}

/**
 * Read the tail of a JSONL file safely without loading multi-megabyte transcripts into memory.
 */
function readTailJsonLines(filePath, maxBytes = TRANSCRIPT_TAIL_BYTES) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    return { stat: null, entries: [] };
  }
  if (!stat.isFile() || stat.size === 0) {
    return { stat, entries: [] };
  }

  const cached = transcriptCache.get(filePath);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return { stat, entries: cached.entries };
  }

  let raw = '';
  let fd = null;
  try {
    fd = openSync(filePath, 'r');
    const startOffset = Math.max(0, stat.size - maxBytes);
    const length = stat.size - startOffset;
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, startOffset);
    raw = buf.toString('utf8', 0, bytesRead);
    if (startOffset > 0) {
      const firstNewline = raw.indexOf('\n');
      if (firstNewline !== -1) {
        raw = raw.slice(firstNewline + 1);
      }
    }
  } catch {
    return { stat, entries: [] };
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Skip incomplete trailing line if file is mid-write
    }
  }

  if (transcriptCache.has(filePath)) {
    transcriptCache.delete(filePath);
  } else if (transcriptCache.size >= 120) {
    transcriptCache.delete(transcriptCache.keys().next().value);
  }
  transcriptCache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, entries });
  return { stat, entries };
}

const transcriptParseCache = new Map(); // path -> { mtimeMs, size, entries, contextMetrics, contextAtMs }

/**
 * Analyze the tail of `transcript.jsonl` to determine real-time `thinking` vs `working` vs `sleeping` state.
 */
export function analyzeTranscript(transcriptPath, nowMs = Date.now(), isSwarmWorkerWorking = false) {
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return null;
  }

  let cached = transcriptParseCache.get(transcriptPath);
  let entries;
  let contextMetrics;
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    entries = cached.entries;
    if (cached.contextMetrics && nowMs - cached.contextAtMs < 4000) {
      contextMetrics = cached.contextMetrics;
    } else {
      contextMetrics = extractTranscriptContextMetrics(st, entries, nowMs);
      if (contextMetrics) {
        const realWindow = readConversationContextWindow(cascadeIdFromTranscriptPath(transcriptPath), nowMs);
        if (realWindow) {
          contextMetrics.maxTokens = realWindow;
          contextMetrics.maxTokensSource = 'conversation-db';
        }
        contextMetrics.cacheStats = readCacheLedger(transcriptPath);
      }
      cached.contextMetrics = contextMetrics;
      cached.contextAtMs = nowMs;
    }
  } else {
    const tailRes = readTailJsonLines(transcriptPath);
    if (!tailRes.stat) return null;
    entries = tailRes.entries;
    contextMetrics = extractTranscriptContextMetrics(tailRes.stat, entries, nowMs);
    if (contextMetrics) {
      const realWindow = readConversationContextWindow(cascadeIdFromTranscriptPath(transcriptPath), nowMs);
      if (realWindow) {
        contextMetrics.maxTokens = realWindow;
        contextMetrics.maxTokensSource = 'conversation-db';
      }
      // Real cumulative prompt-cache totals over every request in this conversation.
      contextMetrics.cacheStats = readCacheLedger(transcriptPath);
    }
    if (transcriptParseCache.size > 200) transcriptParseCache.clear();
    transcriptParseCache.set(transcriptPath, {
      mtimeMs: st.mtimeMs,
      size: st.size,
      entries,
      contextMetrics,
      contextAtMs: nowMs
    });
  }

  const mtimeMs = st.mtimeMs;
  const withCtx = (obj) => ({ ...obj, contextMetrics });

  if (entries.length === 0) {
    const ageMs = Math.max(0, nowMs - mtimeMs);
    return withCtx({
      state: ageMs <= IDLE_SLEEP_THRESHOLD_MS ? 'thinking' : 'sleeping',
      statusText: ageMs <= IDLE_SLEEP_THRESHOLD_MS ? '💭 会话初始化推理中...' : '💤 待命休眠中',
      lastActiveAtMs: mtimeMs,
      lastStepType: null,
      hasPendingTools: false,
      parkedOnWait: false,
      turnCompleted: false
    });
  }

  const lastStep = entries[entries.length - 1];
  const stepCreatedMs = lastStep?.created_at ? Date.parse(lastStep.created_at) : NaN;
  const lastActiveAtMs = Number.isFinite(stepCreatedMs) ? Math.max(mtimeMs, stepCreatedMs) : mtimeMs;
  const ageMs = Math.max(0, nowMs - lastActiveAtMs);

  let lastPlannerIdx = -1;
  let lastUserIdx = -1;
  let lastUserPrompt = '';
  for (let i = entries.length - 1; i >= 0; i--) {
    const step = entries[i];
    if (lastPlannerIdx === -1 && step?.type === 'PLANNER_RESPONSE') {
      lastPlannerIdx = i;
    }
    if (lastUserIdx === -1 && (step?.type === 'USER_INPUT' || step?.type === 'SYSTEM_MESSAGE')) {
      lastUserIdx = i;
      if (typeof step?.content === 'string') {
        lastUserPrompt = step.content
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 26);
      }
    }
  }

  // 1. Error check
  if (lastStep?.status === 'ERROR') {
    return withCtx({
      state: ageMs <= 45_000 ? 'error' : 'sleeping',
      statusText: ageMs <= 45_000 ? '💧 步骤执行异常，等待恢复' : '💤 待命休眠中',
      lastActiveAtMs,
      lastStepType: lastStep.type,
      hasPendingTools: false,
      parkedOnWait: false,
      turnCompleted: false
    });
  }

  // 2. Step actively in-flight (status !== 'DONE')
  if (lastStep?.status && lastStep.status !== 'DONE') {
    const toolCalls = Array.isArray(lastStep?.tool_calls) ? lastStep.tool_calls : [];
    const activeNonWaitTools = toolCalls.filter((tc) => tc?.name !== 'swarm_wait');
    if (activeNonWaitTools.length > 0) {
      return withCtx({
        state: 'working',
        statusText: `⚡ ${formatToolAction(activeNonWaitTools[0])}`,
        lastActiveAtMs,
        lastStepType: lastStep.type,
        hasPendingTools: true,
        parkedOnWait: false,
        turnCompleted: false
      });
    }
    return withCtx({
      state: 'thinking',
      statusText: '💭 正在深度思考推理中...',
      lastActiveAtMs,
      lastStepType: lastStep.type,
      hasPendingTools: false,
      parkedOnWait: false,
      turnCompleted: false
    });
  }

  // 3. A newer USER_INPUT / SYSTEM_MESSAGE arrived after the last PLANNER_RESPONSE -> Model is inferring!
  if (lastUserIdx > lastPlannerIdx) {
    if (ageMs <= STALE_WORKING_GUARD_MS) {
      return withCtx({
        state: 'thinking',
        statusText: lastUserPrompt ? `💭 思考中: ${lastUserPrompt}` : '💭 收到新任务，正在思考推理...',
        lastActiveAtMs,
        lastStepType: lastStep.type,
        hasPendingTools: false,
        parkedOnWait: false,
        turnCompleted: false
      });
    }
    return withCtx({
      state: 'sleeping',
      statusText: '💤 会话静置待命中',
      lastActiveAtMs,
      lastStepType: lastStep.type,
      hasPendingTools: false,
      parkedOnWait: false,
      turnCompleted: true
    });
  }

  // 4. Inspect latest PLANNER_RESPONSE + tool call lifecycle
  if (lastPlannerIdx !== -1) {
    const plannerStep = entries[lastPlannerIdx];
    const toolCalls = Array.isArray(plannerStep?.tool_calls) ? plannerStep.tool_calls : [];
    const parkedOnWait =
      toolCalls.some((tc) => tc?.name === 'swarm_wait') ||
      (lastStep?.type === 'GENERIC' &&
        typeof lastStep?.content === 'string' &&
        lastStep.content.includes('Waiting for a message'));

    if (parkedOnWait) {
      return withCtx({
        state: 'sleeping',
        statusText: '💤 留言板待命中 (swarm_wait)',
        lastActiveAtMs,
        lastStepType: lastStep?.type,
        hasPendingTools: false,
        parkedOnWait: true,
        turnCompleted: true
      });
    }

    if (toolCalls.length > 0) {
      let genericAfter = 0;
      for (let j = lastPlannerIdx + 1; j < entries.length; j++) {
        if (entries[j]?.type === 'GENERIC') genericAfter++;
      }

      const scheduledTimerOnly =
        toolCalls.every((tc) => tc?.name === 'schedule') && genericAfter >= toolCalls.length;
      if (scheduledTimerOnly && ageMs > 5_000) {
        return withCtx({
          state: 'sleeping',
          statusText: '💤 定时巡检待命中 (schedule)',
          lastActiveAtMs,
          lastStepType: lastStep?.type,
          hasPendingTools: false,
          parkedOnWait: true,
          turnCompleted: true
        });
      }

      if (genericAfter < toolCalls.length) {
        if (ageMs <= 180_000) {
          const activeTool = toolCalls[Math.min(genericAfter, toolCalls.length - 1)];
          return withCtx({
            state: 'working',
            statusText: `⚡ ${formatToolAction(activeTool)}`,
            lastActiveAtMs,
            lastStepType: lastStep?.type,
            hasPendingTools: true,
            parkedOnWait: false,
            turnCompleted: false
          });
        }
      } else {
        if (ageMs <= POST_TOOL_FLASH_MS) {
          const lastTool = toolCalls[toolCalls.length - 1];
          return withCtx({
            state: 'working',
            statusText: `⚡ ${formatToolAction(lastTool)}`,
            lastActiveAtMs,
            lastStepType: lastStep?.type,
            hasPendingTools: false,
            parkedOnWait: false,
            turnCompleted: false
          });
        }
        const activeWindow = isSwarmWorkerWorking ? STALE_WORKING_GUARD_MS : 60_000;
        if (ageMs <= activeWindow) {
          const lastTool = toolCalls[toolCalls.length - 1];
          return withCtx({
            state: 'thinking',
            statusText: `💭 思考推理下一步 (${lastTool?.name || 'tool'})...`,
            lastActiveAtMs,
            lastStepType: lastStep?.type,
            hasPendingTools: false,
            parkedOnWait: false,
            turnCompleted: false
          });
        }
      }

      return withCtx({
        state: 'sleeping',
        statusText: '💤 任务静置休眠中',
        lastActiveAtMs,
        lastStepType: lastStep?.type,
        hasPendingTools: false,
        parkedOnWait: false,
        turnCompleted: true
      });
    }

    // PLANNER_RESPONSE DONE with NO tool_calls
    if (!isSwarmWorkerWorking && ageMs <= CELEBRATE_WINDOW_MS) {
      return withCtx({
        state: 'celebrating',
        statusText: '✨ 回合任务完成！',
        lastActiveAtMs,
        lastStepType: lastStep?.type,
        hasPendingTools: false,
        parkedOnWait: false,
        turnCompleted: true
      });
    }
    return withCtx({
      state: 'sleeping',
      statusText: '💤 待命中 · 回合已完成',
      lastActiveAtMs,
      lastStepType: lastStep?.type,
      hasPendingTools: false,
      parkedOnWait: false,
      turnCompleted: true
    });
  }

  return withCtx({
    state: ageMs <= IDLE_SLEEP_THRESHOLD_MS ? 'thinking' : 'sleeping',
    statusText: ageMs <= IDLE_SLEEP_THRESHOLD_MS ? '💭 智能体思考中...' : '💤 休眠待命中',
    lastActiveAtMs,
    lastStepType: lastStep?.type || null,
    hasPendingTools: false,
    parkedOnWait: false,
    turnCompleted: ageMs > IDLE_SLEEP_THRESHOLD_MS
  });
}

/**
 * Compute exact `idleMs` & `idleSince` for an agent, honoring explicit simulation/UI overrides
 * and tracking live transitions from active -> `sleeping`.
 */
function resolveAgentIdleTiming(agentKey, state, lastActiveAtMs, nowMs, explicitIdleMs, explicitIdleSince) {
  if (state !== 'sleeping') {
    idleStateTracker.set(agentKey, { lastState: state, sleepEnteredAtMs: null });
    return { idleMs: 0, idleSince: null };
  }

  if (explicitIdleMs !== undefined && explicitIdleMs !== null && Number.isFinite(Number(explicitIdleMs))) {
    const ms = Math.max(0, Math.round(Number(explicitIdleMs)));
    return {
      idleMs: ms,
      idleSince: new Date(nowMs - ms).toISOString()
    };
  }

  if (explicitIdleSince) {
    const parsed = Date.parse(explicitIdleSince);
    if (Number.isFinite(parsed)) {
      const ms = Math.max(0, Math.round(nowMs - parsed));
      return {
        idleMs: ms,
        idleSince: new Date(parsed).toISOString()
      };
    }
  }

  const prev = idleStateTracker.get(agentKey);
  let sleepEnteredAtMs;
  if (prev && prev.lastState !== 'sleeping') {
    sleepEnteredAtMs = Math.max(lastActiveAtMs || nowMs, nowMs);
  } else if (prev && prev.lastState === 'sleeping' && prev.sleepEnteredAtMs) {
    sleepEnteredAtMs = Math.max(prev.sleepEnteredAtMs, lastActiveAtMs || 0);
  } else {
    sleepEnteredAtMs = Number.isFinite(lastActiveAtMs) && lastActiveAtMs > 0 ? lastActiveAtMs : nowMs;
  }

  idleStateTracker.set(agentKey, { lastState: 'sleeping', sleepEnteredAtMs });
  const idleMs = Math.max(0, Math.round(nowMs - sleepEnteredAtMs));
  return {
    idleMs,
    idleSince: new Date(sleepEnteredAtMs).toISOString()
  };
}

/**
 * Load hook fallback file into memory if updated on disk.
 */
let lastHookFileMtime = 0;
function syncHookFallbackFile(nowMs) {
  try {
    if (!existsSync(HOOK_STATE_FILE)) return;
    const st = statSync(HOOK_STATE_FILE);
    if (st.mtimeMs <= lastHookFileMtime) return;
    lastHookFileMtime = st.mtimeMs;
    const parsed = JSON.parse(readFileSync(HOOK_STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      for (const [id, entry] of Object.entries(parsed)) {
        if (entry && typeof entry === 'object' && Number(entry.expiresAtMs || 0) > nowMs) {
          const cur = hookUpdates.get(id);
          if (!cur || Date.parse(entry.updatedAt || 0) >= Date.parse(cur.updatedAt || 0)) {
            hookUpdates.set(id, entry);
          }
        }
      }
    }
  } catch {
    // ignore transient read errors
  }
}

function findTranscriptPathById(convId) {
  if (!convId || /[\\/]/.test(convId)) return null;
  for (const root of BRAIN_ROOTS) {
    const p = join(root, convId, '.system_generated', 'logs', 'transcript.jsonl');
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * Manage dynamic non-blocking `fs.watch` listeners so `transcript.jsonl` / `members.json` updates broadcast via SSE within ~60ms.
 */
function scheduleWatchBroadcast() {
  scanDirty = true;
  if (watchDebounceTimer) return;
  watchDebounceTimer = setTimeout(() => {
    watchDebounceTimer = null;
    try {
      broadcastSnapshotIfChanged(false);
    } catch {
      // ignore
    }
  }, FS_WATCH_DEBOUNCE_MS);
  watchDebounceTimer.unref?.();
}

function syncDirectoryWatchers(desiredDirs) {
  if (ONCE_MODE) return;
  const keep = new Set(desiredDirs.filter((d) => d && existsSync(d)));

  for (const [dir, watcher] of activeWatchers.entries()) {
    if (!keep.has(dir)) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
      activeWatchers.delete(dir);
    }
  }

  for (const dir of keep) {
    if (activeWatchers.has(dir) || activeWatchers.size >= 40) continue;
    try {
      const w = watch(dir, { persistent: false }, (_eventType, filename) => {
        if (!filename || filename.endsWith('.jsonl') || filename.endsWith('.json') || filename.endsWith('.db-wal')) {
          scheduleWatchBroadcast();
        }
      });
      w.on('error', () => {
        try {
          w.close();
        } catch {
          // ignore
        }
        activeWatchers.delete(dir);
      });
      activeWatchers.set(dir, w);
    } catch {
      // ignore unsupported/locked directories
    }
  }
}

/**
 * Apply sticky species preferences & per-agent simulation/hook overrides onto a single agent object.
 */
function applyAgentOverrides(agent, nowMs) {
  const hook = hookUpdates.get(agent.id);
  if (hook && Number(hook.expiresAtMs || 0) > nowMs) {
    agent.state = VALID_STATES.has(hook.state) ? hook.state : agent.state;
    agent.statusText = hook.statusText || agent.statusText;
    agent.lastActiveAt = hook.updatedAt || agent.lastActiveAt;
    if (hook.model && hook.model !== 'auto') agent.model = hook.model;
    agent.source = 'hook';
    agent._lastActiveMs = Math.max(agent._lastActiveMs || 0, Date.parse(hook.updatedAt) || nowMs);
  }

  if (speciesPreferences.has(agent.id)) {
    agent.pokemonSpecies = speciesPreferences.get(agent.id);
    agent._explicitSpecies = true;
  } else if (speciesPreferences.has(agent.name)) {
    agent.pokemonSpecies = speciesPreferences.get(agent.name);
    agent._explicitSpecies = true;
  }

  let sim = simulationOverrides.get(agent.id) || simulationOverrides.get(agent.name) || null;
  if (!sim) {
    for (const candidate of simulationOverrides.values()) {
      if (candidate.id === agent.id || (candidate.name && candidate.name === agent.name)) {
        sim = candidate;
        break;
      }
    }
  }
  if (sim) {
    if (sim.state && VALID_STATES.has(sim.state)) agent.state = sim.state;
    if (sim.statusText) agent.statusText = sim.statusText;
    if (sim.pokemonSpecies && isPackSpecies(sim.pokemonSpecies)) {
      agent.pokemonSpecies = sim.pokemonSpecies;
      agent._explicitSpecies = true;
    }
    if (sim.role) agent.role = sim.role;
    if (sim.model) agent.model = sim.model;
    if (sim.idleMs !== undefined) agent._explicitIdleMs = sim.idleMs;
    if (sim.idleSince !== undefined) agent._explicitIdleSince = sim.idleSince;
    if (sim.context && typeof sim.context === 'object') {
      agent._explicitContext = { ...(agent._explicitContext || {}), ...sim.context, source: 'simulated' };
    }
    agent.lastActiveAt = sim.updatedAt || new Date(nowMs).toISOString();
    agent.source = 'simulated';
  }
}

/**
 * Enforce Core Rules 3, 4, 5, and 6 on a raw session queue, plus v4.0 window metadata & v4.1 `context` ring metrics.
 */
function finalizeSessionQueue(rawQueue, nowMs) {
  const {
    conversationId,
    conversationTitle,
    headerTitle = null,
    swarmTitle = null,
    projectId,
    projectName,
    workspacePath,
    windowId = null,
    windowTitle = null,
    appKind = null,
    pid = null,
    isFocusedUi = false,
    isUiSynced = false,
    leadRaw,
    subagentsRaw = []
  } = rawQueue;

  applyAgentOverrides(leadRaw, nowMs);
  const leadIdle = resolveAgentIdleTiming(
    leadRaw.id,
    leadRaw.state,
    leadRaw._lastActiveMs,
    nowMs,
    leadRaw._explicitIdleMs,
    leadRaw._explicitIdleSince
  );

  const keptSubagents = [];
  for (const sub of subagentsRaw) {
    applyAgentOverrides(sub, nowMs);
    const subIdle = resolveAgentIdleTiming(
      sub.id,
      sub.state,
      sub._lastActiveMs,
      nowMs,
      sub._explicitIdleMs,
      sub._explicitIdleSince
    );

    // Core Rule 4: Sleeping subagents with `idleMs > 60000` (> 1 min) are AUTOMATICALLY REMOVED!
    if (sub.state === 'sleeping' && subIdle.idleMs > SUBAGENT_IDLE_TTL_MS) {
      continue;
    }

    keptSubagents.push({
      ...sub,
      isLead: false,
      idleMs: subIdle.idleMs,
      idleSince: subIdle.idleSince,
      remainingTtlMs: sub.state === 'sleeping' ? Math.max(0, SUBAGENT_IDLE_TTL_MS - subIdle.idleMs) : null
    });
  }

  keptSubagents.sort((a, b) => {
    const aActive = a.state !== 'sleeping' ? 0 : 1;
    const bActive = b.state !== 'sleeping' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return a.name.localeCompare(b.name);
  });

  const hasActiveSubagent = keptSubagents.some((s) => s.state !== 'sleeping');
  const leadIsActive = leadRaw.state !== 'sleeping';

  // Core Rule 5: Keep queue & leadAgent alive if ANY subagent is active (`hasActiveSubagent`),
  // OR any <=60s resting subagent is still in the row, OR leadAgent itself is active or <=60s idle,
  // OR this conversation is an actively focused UI window!
  const shouldKeepAlive =
    hasActiveSubagent ||
    keptSubagents.length > 0 ||
    leadIsActive ||
    leadIdle.idleMs <= INACTIVE_QUEUE_RETIRE_MS ||
    isFocusedUi ||
    isUiSynced;

  const cleanPublicFields = (rawObj, queueIndex, isLead, idleInfo, remainingTtlMs = null) => {
    const resolvedModel = rawObj.model || 'gemini-auto';
    let fallbackRawCtx = rawObj._contextMetrics || null;
    if (!fallbackRawCtx && rawObj.source === 'simulated' && !rawObj._explicitContext) {
      // Deterministic realistic defaults for simulated agents when caller omits explicit `context`
      fallbackRawCtx = isLead
        ? {
            usedTokens: 42_000,
            cachedTokens: 37_800,
            uncachedTokens: 4_200,
            promptTokens: 42_000,
            outputTokens: 1_200,
            lastTokenAtMs: nowMs,
            source: 'simulated'
          }
        : {
            usedTokens: 28_000,
            cachedTokens: 23_800,
            uncachedTokens: 4_200,
            promptTokens: 28_000,
            outputTokens: 900,
            lastTokenAtMs: nowMs,
            source: 'simulated'
          };
    }
    const context = buildAgentContextMetrics(
      fallbackRawCtx,
      resolvedModel,
      nowMs,
      rawObj._explicitContext || null
    );
    return {
      id: rawObj.id,
      name: rawObj.name,
      role: rawObj.role,
      isLead,
      queueIndex,
      conversationId,
      conversationTitle,
      headerTitle: headerTitle || conversationTitle,
      projectId,
      projectName,
      workspacePath,
      windowId,
      windowTitle,
      appKind,
      pid,
      model: resolvedModel,
      state: rawObj.state,
      statusText: rawObj.statusText,
      idleMs: idleInfo.idleMs,
      idleSince: idleInfo.idleSince,
      remainingTtlMs,
      lastActiveAt: rawObj.lastActiveAt || new Date(rawObj._lastActiveMs || nowMs).toISOString(),
      ...resolveGachaPartner(rawObj, isLead, {
        conversationId,
        conversationTitle,
        projectName
      }, nowMs),
      source: rawObj.source || 'transcript',
      context
    };
  };

  const leadAgent = cleanPublicFields(leadRaw, 0, true, leadIdle, null);
  const subagents = keptSubagents.map((s, idx) =>
    cleanPublicFields(s, idx + 1, false, { idleMs: s.idleMs, idleSince: s.idleSince }, s.remainingTtlMs)
  );
  const members = [leadAgent, ...subagents];

  let latestActivityMs = leadRaw._lastActiveMs || 0;
  for (const s of keptSubagents) {
    if ((s._lastActiveMs || 0) > latestActivityMs) latestActivityMs = s._lastActiveMs;
  }

  return {
    shouldKeepAlive,
    latestActivityMs,
    queue: {
      conversationId,
      conversationTitle,
      headerTitle: headerTitle || conversationTitle,
      swarmTitle,
      projectId,
      projectName,
      workspacePath,
      windowId,
      windowTitle,
      appKind,
      pid,
      hasActiveSubagent,
      isActiveQueue: hasActiveSubagent || leadIsActive,
      isFocusedUi,
      isUiSynced,
      totalPets: members.length,
      updatedAt: new Date(latestActivityMs || nowMs).toISOString(),
      leadAgent,
      subagents,
      members
    }
  };
}

/**
 * Scan all brain roots + `conversation_summaries.db` + multi-window `ui-sync` + simulations,
 * returning the complete v4.0 `projects -> queues -> [leadAgent, ...subagents]` hierarchy + `activeTheme` + `lastFocusRequest`.
 */
export function scanAllAgents(nowMs = Date.now(), options = {}) {
  syncHookFallbackFile(nowMs);
  const dbSummaries = syncConversationSummariesDb();

  // Clean up expired UI sync windows (> 8s TTL) & expired simulations
  for (const [wId, win] of uiSyncWindows.entries()) {
    if (!win || Number(win.expiresAtMs || 0) <= nowMs) {
      uiSyncWindows.delete(wId);
    }
  }
  for (const [simKey, sim] of simulationOverrides.entries()) {
    if (sim.expiresAtMs && sim.expiresAtMs > 0 && sim.expiresAtMs <= nowMs) {
      simulationOverrides.delete(simKey);
    }
  }
  for (const [qId, sq] of simulatedQueues.entries()) {
    if (sq.expiresAtMs && sq.expiresAtMs > 0 && sq.expiresAtMs <= nowMs) {
      simulatedQueues.delete(qId);
    }
  }

  const rawQueuesByConvId = new Map(); // convId -> rawQueue
  const childToParentConv = new Map(); // subagentConvId -> parentConvId
  const diskAgentById = new Map();     // agentId -> rawAgent
  const diskAgentsByName = new Map();  // lowerName -> rawAgent[]
  const claimedChildIds = new Set();   // worker/subagent convIds (never form standalone queues)
  const dirsToWatch = [...BRAIN_ROOTS, dirname(SUMMARIES_DB_PATH)];

  for (const [cid, row] of dbSummaries.entries()) {
    if (row.parent_conversation_id) {
      childToParentConv.set(cid, String(row.parent_conversation_id));
      claimedChildIds.add(cid);
    }
  }

  const registerDiskAgent = (agent, parentConvId) => {
    diskAgentById.set(agent.id, agent);
    if (parentConvId && agent.id !== parentConvId) {
      childToParentConv.set(agent.id, parentConvId);
    }
    const key = agent.name.toLowerCase();
    const arr = diskAgentsByName.get(key) || [];
    arr.push(agent);
    arr.sort((a, b) => (b._lastActiveMs || 0) - (a._lastActiveMs || 0));
    diskAgentsByName.set(key, arr);
  };

  let mostRecentFallbackRawQueue = null;

  // Build one `invoke_subagent` child agent (`.system_generated/subagents/<id>.json`) for its parent queue.
  const buildInvokedSubagent = (brainRoot, entry, parentConvId, sessionWatchDirs) => {
    const { subConvId, sj, subLogsDir, subTranscript, subMtime } = entry;
    const subT = existsSync(subTranscript) ? analyzeTranscript(subTranscript, nowMs, true) : null;
    const rawRole = String(sj?.subagentDescriptor?.role || sj?.subagentDescriptor?.typeName || 'subagent');
    const subName = normalizeAgentName(rawRole).slice(0, 28) || `sub-${subConvId.slice(0, 6)}`;
    const activeMs = subT?.lastActiveAtMs || subMtime;
    const subState = subT?.state || 'sleeping';
    if (subState !== 'sleeping') sessionWatchDirs.push(subLogsDir);
    const subObj = {
      id: subConvId,
      name: subName,
      role: 'subagent',
      model: 'gemini-auto',
      state: subState,
      statusText: subT?.statusText || '💤 子智能体待命中',
      lastActiveAt: new Date(activeMs).toISOString(),
      pokemonSpecies: assignPokemonSpecies(subConvId, subName, 'subagent', false),
      source: 'subagent',
      _lastActiveMs: activeMs,
      _contextMetrics: subT?.contextMetrics || null
    };
    registerDiskAgent(subObj, parentConvId);
    return subObj;
  };

  for (const brainRoot of BRAIN_ROOTS) {
    if (!existsSync(brainRoot)) continue;

    let convDirs = [];
    try {
      convDirs = readdirSync(brainRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }

    // Pass 0: claim every `invoke_subagent` child up front (with mtime caching to avoid re-parsing 400+ dirs).
    const subEntriesByConv = new Map(); // parentConvId -> { entries: [...alive], workspaceUri }
    for (const dirEnt of convDirs) {
      const convId = dirEnt.name;
      if (oldConvSubagentScanned.has(convId)) {
        const cachedOld = subagentDirCache.get(convId);
        if (cachedOld) {
          for (const cid of cachedOld.childIds) {
            claimedChildIds.add(cid);
            if (!childToParentConv.has(cid)) childToParentConv.set(cid, convId);
          }
        }
        continue;
      }
      const subagentsDir = join(brainRoot, convId, '.system_generated', 'subagents');
      let dirSt;
      try {
        dirSt = statSync(subagentsDir);
      } catch {
        oldConvSubagentScanned.add(convId);
        continue;
      }
      const cachedSub = subagentDirCache.get(convId);
      if (cachedSub && cachedSub.dirMtimeMs === dirSt.mtimeMs) {
        for (const cid of cachedSub.childIds) {
          claimedChildIds.add(cid);
          childToParentConv.set(cid, convId);
        }
        if (cachedSub.entries.length > 0) {
          for (const e of cachedSub.entries) {
            try {
              if (existsSync(e.subTranscript)) e.subMtime = statSync(e.subTranscript).mtimeMs;
            } catch {
              // ignore
            }
          }
          subEntriesByConv.set(convId, { entries: cachedSub.entries, workspaceUri: cachedSub.workspaceUri });
        }
        continue;
      }

      let files;
      try {
        if (nowMs - dirSt.mtimeMs > CANDIDATE_SCAN_WINDOW_MS * 4) {
          // Old fan-out: claim once and remember so subsequent ticks skip stat/readdir completely.
          files = readdirSync(subagentsDir);
          const childIds = [];
          for (const sf of files) {
            if (sf.endsWith('.json')) {
              const cid = sf.slice(0, -5);
              childIds.push(cid);
              claimedChildIds.add(cid);
              if (!childToParentConv.has(cid)) childToParentConv.set(cid, convId);
            }
          }
          subagentDirCache.set(convId, { dirMtimeMs: dirSt.mtimeMs, childIds, workspaceUri: '', entries: [] });
          oldConvSubagentScanned.add(convId);
          continue;
        }
        files = readdirSync(subagentsDir);
      } catch {
        continue;
      }
      const info = { entries: [], workspaceUri: '' };
      const childIds = [];
      for (const sf of files) {
        if (!sf.endsWith('.json')) continue;
        let sj;
        try {
          sj = JSON.parse(readFileSync(join(subagentsDir, sf), 'utf8'));
        } catch {
          continue;
        }
        const subConvId = String(sj?.conversationId || sf.slice(0, -5));
        childIds.push(subConvId);
        claimedChildIds.add(subConvId);
        childToParentConv.set(subConvId, convId);
        if (!info.workspaceUri && Array.isArray(sj?.workspaceUris) && sj.workspaceUris[0]) {
          info.workspaceUri = sj.workspaceUris[0];
        }
        if (sj?.state !== 'SUBAGENT_STATE_ALIVE') continue;
        const subLogsDir = join(brainRoot, subConvId, '.system_generated', 'logs');
        const subTranscript = join(subLogsDir, 'transcript.jsonl');
        let subMtime = 0;
        try {
          if (existsSync(subTranscript)) subMtime = statSync(subTranscript).mtimeMs;
        } catch {
          // ignore
        }
        info.entries.push({ subConvId, sj, subLogsDir, subTranscript, subMtime });
      }
      if (subagentDirCache.size > 500) {
        subagentDirCache.delete(subagentDirCache.keys().next().value);
      }
      subagentDirCache.set(convId, {
        dirMtimeMs: dirSt.mtimeMs,
        childIds,
        workspaceUri: info.workspaceUri,
        entries: info.entries
      });
      subEntriesByConv.set(convId, info);
    }

    // Pass 1: Discover all Native Swarms (`members.json` + `board.jsonl` + worker `transcript.jsonl`)
    for (const dirEnt of convDirs) {
      const convId = dirEnt.name;
      const convPath = join(brainRoot, convId);
      const swarmDir = join(convPath, '.system_generated', 'swarm');
      const membersPath = join(swarmDir, 'members.json');
      if (!existsSync(membersPath)) continue;

      let swarmData;
      let membersStat;
      try {
        membersStat = statSync(membersPath);
        swarmData = JSON.parse(readFileSync(membersPath, 'utf8'));
      } catch {
        continue;
      }

      const members = swarmData?.members || {};
      let latestActivityMs = membersStat.mtimeMs;
      const subInfo = subEntriesByConv.get(convId);
      const subagentWorkspaceUri = subInfo?.workspaceUri || '';
      // `invoke_subagent` children of a swarm coordinator (e.g. image generators) that are not swarm members.
      const memberConvIds = new Set(
        Object.entries(members).map(([mName, mInfo]) => mInfo?.conversation_id || `${convId}:${mName}`)
      );
      const extraSubEntries = (subInfo?.entries || []).filter((e) => !memberConvIds.has(e.subConvId));
      for (const e of extraSubEntries) {
        if (e.subMtime > latestActivityMs) latestActivityMs = e.subMtime;
      }

      for (const [mName, mInfo] of Object.entries(members)) {
        const mConvId = mInfo?.conversation_id || `${convId}:${mName}`;
        if (mConvId !== convId) {
          claimedChildIds.add(mConvId);
          childToParentConv.set(mConvId, convId);
        }
        if (!mInfo || mInfo.killed) continue;
        const mTranscript = join(brainRoot, mConvId, '.system_generated', 'logs', 'transcript.jsonl');
        try {
          if (existsSync(mTranscript)) {
            const st = statSync(mTranscript);
            if (st.mtimeMs > latestActivityMs) latestActivityMs = st.mtimeMs;
          }
        } catch {
          // ignore
        }
      }

      const boardPath = join(swarmDir, 'board.jsonl');
      const latestPostByAgent = new Map();
      if (existsSync(boardPath)) {
        try {
          const { stat: bStat, entries: boardMsgs } = readTailJsonLines(boardPath, 32768);
          if (bStat && bStat.mtimeMs > latestActivityMs) latestActivityMs = bStat.mtimeMs;
          for (const msg of boardMsgs) {
            if (msg?.agent && msg?.kind !== 'brief') {
              latestPostByAgent.set(msg.agent, msg);
            }
          }
        } catch {
          // ignore
        }
      }

      if (nowMs - latestActivityMs > CANDIDATE_SCAN_WINDOW_MS) continue;

      const dbRow = dbSummaries.get(convId);
      const coordTranscript = join(convPath, '.system_generated', 'logs', 'transcript.jsonl');
      const headMeta =
        !dbRow?.workspace_uris && !subagentWorkspaceUri && existsSync(coordTranscript)
          ? readTranscriptHeadMetadata(convId, coordTranscript)
          : { workspacePath: '', firstPrompt: '' };

      const wsIdentity = parseWorkspaceIdentity(
        dbRow?.workspace_uris || subagentWorkspaceUri || headMeta.workspacePath
      );
      const swarmTitle = sanitizeConversationTitle(swarmData?.title);
      const headerTitle = sanitizeConversationTitle(dbRow?.title);
      const previewTitle = sanitizeConversationTitle(dbRow?.preview || headMeta.firstPrompt);
      const conversationTitle = swarmTitle || headerTitle || previewTitle || '智能体协作战队会话';

      let leadRaw = null;
      const subagentsRaw = [];
      const sessionWatchDirs = [swarmDir];

      for (const [memberName, info] of Object.entries(members)) {
        if (!info || info.killed) continue;
        const memberConvId = info.conversation_id || `${convId}:${memberName}`;
        const memberLogsDir = join(brainRoot, memberConvId, '.system_generated', 'logs');
        const memberTranscriptPath = join(memberLogsDir, 'transcript.jsonl');

        const wakeMode = String(info.wake_mode || '').toLowerCase();
        const phase = String(info.phase || info.desired_state || 'RUNNING').toUpperCase();
        const isCoordinator =
          memberName === 'coordinator' || String(info.role || '').toLowerCase() === 'coordinator';
        const role = isCoordinator ? 'coordinator' : String(info.role || 'worker');
        const model = String(info.applied_model || info.model || info.desired_model || 'gemini-auto');
        const isWakeWorking = wakeMode === 'working' && phase !== 'STOPPED' && info.desired_state !== 'STOPPED';

        const effectiveTranscriptPath = existsSync(memberTranscriptPath)
          ? memberTranscriptPath
          : isCoordinator && existsSync(coordTranscript)
            ? coordTranscript
            : null;
        const tInfo = effectiveTranscriptPath
          ? analyzeTranscript(effectiveTranscriptPath, nowMs, isWakeWorking)
          : null;

        let state = 'sleeping';
        let statusText = '💤 休眠待命中';
        const lastPost = latestPostByAgent.get(memberName);
        const postTimeMs = lastPost?.time ? Date.parse(lastPost.time) : NaN;
        const staleFallbackMs = Math.max(0, membersStat.mtimeMs - INACTIVE_QUEUE_RETIRE_MS - 5000);
        const lastActiveAtMs =
          tInfo?.lastActiveAtMs || (Number.isFinite(postTimeMs) ? postTimeMs : staleFallbackMs);

        if (phase === 'STOPPED' || info.desired_state === 'STOPPED') {
          state = 'sleeping';
          statusText = '💤 已暂停待命';
        } else if (wakeMode === 'mentions' || wakeMode === 'all') {
          if (tInfo && nowMs - tInfo.lastActiveAtMs <= CELEBRATE_WINDOW_MS && tInfo.state === 'celebrating') {
            state = 'celebrating';
            statusText = '✨ 阶段工作已提交！';
          } else {
            state = 'sleeping';
            statusText = isCoordinator
              ? '💤 领队统筹中 · 单击看会话/双击弹起'
              : `💤 留言板待命中 (#${info.last_read_seq ?? 0})`;
          }
        } else if (wakeMode === 'working') {
          if (tInfo) {
            if (tInfo.parkedOnWait || tInfo.state === 'sleeping') {
              state = 'sleeping';
              statusText =
                memberName === 'monitor' ? '💤 定时巡检待命中' : tInfo.statusText || '💤 待命中';
            } else {
              state = tInfo.state;
              statusText = tInfo.statusText;
            }
          } else if (nowMs - membersStat.mtimeMs <= 30_000 && memberName !== 'monitor') {
            state = 'thinking';
            statusText = '💭 刚刚唤醒，正在初始化推理...';
          } else {
            state = 'sleeping';
            statusText = '💤 待命休眠中';
          }
        } else if (tInfo) {
          state = tInfo.state;
          statusText = tInfo.statusText;
        }

        if (state !== 'sleeping') {
          sessionWatchDirs.push(memberLogsDir);
        }

        if (state === 'sleeping' && lastPost?.seq && !isCoordinator) {
          statusText = `💤 待命中 · 最新发言 #${lastPost.seq}`;
        }

        const rawAgent = {
          id: memberConvId,
          name: memberName,
          role,
          model,
          state,
          statusText,
          lastActiveAt: new Date(lastActiveAtMs).toISOString(),
          pokemonSpecies: assignPokemonSpecies(memberConvId, memberName, role, isCoordinator),
          source: 'swarm',
          _lastActiveMs: lastActiveAtMs,
          _contextMetrics: tInfo?.contextMetrics || null
        };

        registerDiskAgent(rawAgent, convId);
        if (isCoordinator && !leadRaw) {
          leadRaw = rawAgent;
        } else {
          subagentsRaw.push(rawAgent);
        }
      }

      if (!leadRaw) {
        const cInfo = existsSync(coordTranscript) ? analyzeTranscript(coordTranscript, nowMs, false) : null;
        const cActiveMs = cInfo?.lastActiveAtMs || latestActivityMs;
        leadRaw = {
          id: convId,
          name: 'coordinator',
          role: 'coordinator',
          model: 'gemini-auto',
          state: cInfo?.state || 'sleeping',
          statusText: cInfo?.statusText || '💤 领队统筹中 · 单击看会话/双击弹起',
          lastActiveAt: new Date(cActiveMs).toISOString(),
          pokemonSpecies: assignPokemonSpecies(convId, 'coordinator', 'coordinator', true),
          source: 'swarm',
          _lastActiveMs: cActiveMs,
          _contextMetrics: cInfo?.contextMetrics || null
        };
        registerDiskAgent(leadRaw, convId);
      }

      for (const e of extraSubEntries) {
        subagentsRaw.push(buildInvokedSubagent(brainRoot, { ...e, subMtime: e.subMtime || membersStat.mtimeMs }, convId, sessionWatchDirs));
      }

      const rawQ = {
        conversationId: convId,
        conversationTitle,
        headerTitle: headerTitle || conversationTitle,
        swarmTitle: swarmTitle || null,
        ...wsIdentity,
        leadRaw,
        subagentsRaw,
        watchDirs: sessionWatchDirs,
        latestActivityMs
      };
      rawQueuesByConvId.set(convId, rawQ);
      if (!mostRecentFallbackRawQueue || latestActivityMs > mostRecentFallbackRawQueue.latestActivityMs) {
        mostRecentFallbackRawQueue = rawQ;
      }
    }

    // Pass 2: Discover Standalone Conversations & their `invoke_subagent` subagents
    for (const dirEnt of convDirs) {
      const convId = dirEnt.name;
      if (convId === 'tempmediaStorage') continue;
      if (rawQueuesByConvId.has(convId) || claimedChildIds.has(convId)) continue;

      const convPath = join(brainRoot, convId);
      const logsDir = join(convPath, '.system_generated', 'logs');
      const transcriptPath = join(logsDir, 'transcript.jsonl');
      if (!existsSync(transcriptPath)) continue;

      let tStat;
      try {
        tStat = statSync(transcriptPath);
      } catch {
        continue;
      }

      let latestActivityMs = tStat.mtimeMs;
      const subInfo = subEntriesByConv.get(convId);
      const subWorkspaceUri = subInfo?.workspaceUri || '';
      const subEntries = (subInfo?.entries || []).map((e) => ({ ...e, subMtime: e.subMtime || tStat.mtimeMs }));
      for (const e of subEntries) {
        if (e.subMtime > latestActivityMs) latestActivityMs = e.subMtime;
      }

      const dbRow = dbSummaries.get(convId);
      if (dbRow?.killed) continue;

      const buildStandaloneRawQueue = () => {
        const tInfo = analyzeTranscript(transcriptPath, nowMs, false);
        if (!tInfo) return null;

        const headMeta =
          (!dbRow?.workspace_uris && !subWorkspaceUri) || (!dbRow?.title && !dbRow?.preview)
            ? readTranscriptHeadMetadata(convId, transcriptPath)
            : { workspacePath: '', firstPrompt: '' };

        const wsIdentity = parseWorkspaceIdentity(
          dbRow?.workspace_uris || subWorkspaceUri || headMeta.workspacePath
        );
        const headerTitle = sanitizeConversationTitle(dbRow?.title);
        const previewTitle = sanitizeConversationTitle(dbRow?.preview || headMeta.firstPrompt);
        const conversationTitle = headerTitle || previewTitle || '主智能体对话';

        const leadRaw = {
          id: convId,
          name: 'lead-agent',
          role: 'main-agent',
          model: 'gemini-auto',
          state: tInfo.state,
          statusText:
            tInfo.state === 'sleeping'
              ? '💤 主智能体待命中 · 单击看会话/双击弹起'
              : tInfo.statusText,
          lastActiveAt: new Date(tInfo.lastActiveAtMs).toISOString(),
          pokemonSpecies: assignPokemonSpecies(convId, 'lead-agent', 'main-agent', true),
          source: 'transcript',
          _lastActiveMs: tInfo.lastActiveAtMs,
          _contextMetrics: tInfo.contextMetrics || null
        };
        registerDiskAgent(leadRaw, convId);

        const sessionWatchDirs = [logsDir];
        const subagentsRaw = subEntries.map((e) => buildInvokedSubagent(brainRoot, e, convId, sessionWatchDirs));

        return {
          conversationId: convId,
          conversationTitle,
          headerTitle: headerTitle || conversationTitle,
          swarmTitle: null,
          ...wsIdentity,
          leadRaw,
          subagentsRaw,
          watchDirs: sessionWatchDirs,
          latestActivityMs
        };
      };

      if (!mostRecentFallbackRawQueue || latestActivityMs > mostRecentFallbackRawQueue.latestActivityMs) {
        const candidateFallback = buildStandaloneRawQueue();
        if (candidateFallback) mostRecentFallbackRawQueue = candidateFallback;
      }

      if (nowMs - latestActivityMs > CANDIDATE_SCAN_WINDOW_MS) continue;
      const built =
        mostRecentFallbackRawQueue?.conversationId === convId
          ? mostRecentFallbackRawQueue
          : buildStandaloneRawQueue();
      if (built) {
        rawQueuesByConvId.set(convId, built);
      }
    }
  }

  // A conversation claimed as somebody's child (swarm member / invoke_subagent / DB parent) never stands alone.
  for (const convId of [...rawQueuesByConvId.keys()]) {
    if (claimedChildIds.has(convId)) rawQueuesByConvId.delete(convId);
  }
  if (mostRecentFallbackRawQueue && claimedChildIds.has(mostRecentFallbackRawQueue.conversationId)) {
    mostRecentFallbackRawQueue = null;
  }

  // Pass 3: Merge Multi-Window Live UI DOM Sync (`POST /api/ui-sync`, 8s TTL)
  for (const uiWin of uiSyncWindows.values()) {
    let resolvedConvId = uiWin.conversationId || '';
    // If UI reported a worker/subagent conversationId directly, resolve to parent session queue
    if (resolvedConvId && childToParentConv.has(resolvedConvId)) {
      resolvedConvId = childToParentConv.get(resolvedConvId);
    }
    if (!resolvedConvId) {
      for (const sa of uiWin.subagents) {
        if (sa.id && childToParentConv.has(sa.id)) {
          resolvedConvId = childToParentConv.get(sa.id);
          break;
        }
        const byName = (diskAgentsByName.get(sa.name.toLowerCase()) || [])[0];
        if (byName && childToParentConv.has(byName.id)) {
          resolvedConvId = childToParentConv.get(byName.id);
          break;
        }
      }
    }
    if (!resolvedConvId && (uiWin.conversationTitle || uiWin.projectName)) {
      const cleanUiTitle = sanitizeConversationTitle(uiWin.conversationTitle).toLowerCase();
      const cleanUiProj = String(uiWin.projectName || '').trim().toLowerCase();
      for (const rq of rawQueuesByConvId.values()) {
        const titleMatches =
          cleanUiTitle &&
          (rq.conversationTitle.toLowerCase() === cleanUiTitle ||
            (rq.headerTitle && rq.headerTitle.toLowerCase() === cleanUiTitle) ||
            (rq.swarmTitle && rq.swarmTitle.toLowerCase() === cleanUiTitle));
        const projMatches = !cleanUiProj || rq.projectName.toLowerCase() === cleanUiProj;
        if (titleMatches && projMatches) {
          resolvedConvId = rq.conversationId;
          break;
        }
      }
    }
    if (!resolvedConvId) {
      resolvedConvId = `ui-session-${uiWin.windowId}`;
    }
    uiWin._resolvedConvId = resolvedConvId;

    const existingQueue = rawQueuesByConvId.get(resolvedConvId);
    const dbRow = dbSummaries.get(resolvedConvId);
    const uiCleanTitle = sanitizeConversationTitle(uiWin.conversationTitle);

    if (existingQueue) {
      existingQueue.isUiSynced = true;
      if (uiWin.focused || !existingQueue.windowId) {
        existingQueue.windowId = uiWin.windowId;
        existingQueue.windowTitle = uiWin.windowTitle || existingQueue.windowTitle || null;
        existingQueue.appKind = uiWin.appKind || existingQueue.appKind || null;
        existingQueue.pid = uiWin.pid || existingQueue.pid || null;
      }
      if (uiWin.focused) existingQueue.isFocusedUi = true;
      if (uiCleanTitle) {
        existingQueue.headerTitle = uiCleanTitle;
        if (!existingQueue.swarmTitle) {
          existingQueue.conversationTitle = uiCleanTitle;
        }
      }
      if (uiWin.workspacePath || (uiWin.projectName && existingQueue.projectId === DEFAULT_GLOBAL_PROJECT_ID)) {
        const wsId = parseWorkspaceIdentity(
          uiWin.workspacePath || existingQueue.workspacePath,
          uiWin.projectName || existingQueue.projectName
        );
        existingQueue.workspacePath = wsId.workspacePath;
        existingQueue.projectName = wsId.projectName;
        existingQueue.projectId = wsId.projectId;
      }

      if (uiWin.leadAgent) {
        const uiLead = uiWin.leadAgent;
        if (
          (uiLead.state === 'working' || uiLead.state === 'thinking' || uiLead.state === 'error') &&
          existingQueue.leadRaw.state === 'sleeping'
        ) {
          existingQueue.leadRaw.state = uiLead.state;
          existingQueue.leadRaw.statusText =
            uiLead.statusText && !/^(working|thinking|idle)\.{0,3}$/i.test(uiLead.statusText)
              ? uiLead.statusText
              : uiLead.state === 'thinking'
                ? '💭 领队正在思考推理中...'
                : '⚡ 领队正在执行任务...';
          existingQueue.leadRaw._lastActiveMs = Math.max(existingQueue.leadRaw._lastActiveMs || 0, uiWin.updatedAtMs);
        }
        if (uiLead.idleMs !== undefined) existingQueue.leadRaw._explicitIdleMs = uiLead.idleMs;
      }

      for (const uiSub of uiWin.subagents) {
        if (!uiSub.name) continue;
        let match = existingQueue.subagentsRaw.find(
          (s) => (uiSub.id && s.id === uiSub.id) || s.name.toLowerCase() === uiSub.name.toLowerCase()
        );
        if (!match && uiSub.id) {
          const tp = findTranscriptPathById(uiSub.id);
          const tInfo = tp ? analyzeTranscript(tp, nowMs, uiSub.state !== 'sleeping') : null;
          match = {
            id: uiSub.id,
            name: uiSub.name,
            role: uiSub.role || 'worker',
            model: uiSub.model || 'gemini-auto',
            state: tInfo?.state || uiSub.state || 'working',
            statusText: tInfo?.statusText || uiSub.statusText || '⚡ 正在执行任务...',
            lastActiveAt: new Date(tInfo?.lastActiveAtMs || uiWin.updatedAtMs).toISOString(),
            pokemonSpecies: assignPokemonSpecies(uiSub.id, uiSub.name, uiSub.role || 'worker', false),
            source: tp ? 'transcript' : 'ui-sync',
            _lastActiveMs: tInfo?.lastActiveAtMs || uiWin.updatedAtMs,
            _contextMetrics: tInfo?.contextMetrics || null,
            _explicitContext: uiSub.context || null
          };
          existingQueue.subagentsRaw.push(match);
        } else if (!match) {
          match = {
            id: `ui-${resolvedConvId}-${uiSub.name}`,
            name: uiSub.name,
            role: uiSub.role || 'worker',
            model: uiSub.model || 'gemini-auto',
            state: uiSub.state || 'working',
            statusText:
              uiSub.statusText && !/^(working|thinking)\.{0,3}$/i.test(uiSub.statusText)
                ? uiSub.statusText
                : uiSub.state === 'thinking'
                  ? '💭 正在思考推理中...'
                  : '⚡ 正在执行任务...',
            lastActiveAt: new Date(uiWin.updatedAtMs).toISOString(),
            pokemonSpecies: assignPokemonSpecies(uiSub.name, uiSub.name, uiSub.role || 'worker', false),
            source: 'ui-sync',
            _lastActiveMs: uiWin.updatedAtMs,
            _explicitContext: uiSub.context || null
          };
          existingQueue.subagentsRaw.push(match);
        } else {
          if ((uiSub.state === 'working' || uiSub.state === 'thinking') && match.state === 'sleeping') {
            match.state = uiSub.state;
            match.statusText = uiSub.state === 'thinking' ? '💭 正在思考推理中...' : '⚡ 正在执行任务...';
            match._lastActiveMs = Math.max(match._lastActiveMs || 0, uiWin.updatedAtMs);
          } else if (uiSub.state === 'thinking' && match.state !== 'working') {
            match.state = 'thinking';
          }
          if (uiSub.context) {
            match._explicitContext = { ...(match._explicitContext || {}), ...uiSub.context, source: 'ui-sync' };
          }
        }
        if (uiSub.idleMs !== undefined) match._explicitIdleMs = uiSub.idleMs;
        if (uiSub.idleSince !== undefined) match._explicitIdleSince = uiSub.idleSince;
      }
    } else if (uiWin.leadAgent || uiWin.subagents.length > 0) {
      const uiLeadState = uiWin.leadAgent?.state || 'sleeping';
      const hasActiveUiMember =
        uiLeadState !== 'sleeping' || uiWin.subagents.some((s) => s.state && s.state !== 'sleeping');
      const alreadyActivated = activatedThisLaunchConvIds.has(resolvedConvId);
      if (!hasActiveUiMember && !alreadyActivated) {
        // Ignore sleeping historical conversations merely viewed in the sidebar without any turn in this launch
        continue;
      }
      const wsIdentity = parseWorkspaceIdentity(
        uiWin.workspacePath || dbRow?.workspace_uris || '',
        uiWin.projectName || ''
      );
      const conversationTitle =
        uiCleanTitle ||
        sanitizeConversationTitle(dbRow?.title || dbRow?.preview) ||
        '当前窗口活跃会话';

      const uiLead = uiWin.leadAgent || {
        id: `${resolvedConvId}:lead`,
        name: uiWin.subagents.length > 0 ? 'coordinator' : 'lead-agent',
        role: uiWin.subagents.length > 0 ? 'coordinator' : 'main-agent',
        state: 'sleeping',
        statusText: '💤 领队统筹中 · 单击看会话/双击弹起'
      };
      const leadRaw = {
        id: uiLead.id || `${resolvedConvId}:lead`,
        name: normalizeAgentName(uiLead.name || 'lead-agent') || 'lead-agent',
        role: uiLead.role || 'main-agent',
        model: uiLead.model || 'gemini-auto',
        state: VALID_STATES.has(uiLead.state) ? uiLead.state : 'sleeping',
        statusText: uiLead.statusText || '💤 领队统筹中 · 单击看会话/双击弹起',
        lastActiveAt: new Date(uiWin.updatedAtMs).toISOString(),
        pokemonSpecies: assignPokemonSpecies(uiLead.id, uiLead.name || 'lead-agent', uiLead.role || 'main-agent', true),
        source: 'ui-sync',
        _lastActiveMs: uiWin.updatedAtMs,
        _explicitIdleMs: uiLead.idleMs,
        _explicitIdleSince: uiLead.idleSince,
        _explicitContext: uiLead.context || null
      };

      const subagentsRaw = uiWin.subagents.map((s) => {
        const tp = s.id ? findTranscriptPathById(s.id) : null;
        const tInfo = tp ? analyzeTranscript(tp, nowMs, s.state !== 'sleeping') : null;
        const st =
          tInfo && tInfo.state !== 'sleeping' ? tInfo.state : VALID_STATES.has(s.state) ? s.state : 'working';
        const stText =
          tInfo && tInfo.state !== 'sleeping'
            ? tInfo.statusText
            : s.statusText && !/^(working|thinking)\.{0,3}$/i.test(s.statusText)
              ? s.statusText
              : st === 'thinking'
                ? '💭 正在思考推理中...'
                : st === 'working'
                  ? '⚡ 正在执行任务...'
                  : '💤 子智能体待命中';
        return {
          id: s.id || `ui-${resolvedConvId}-${s.name}`,
          name: s.name,
          role: s.role || 'worker',
          model: s.model || 'gemini-auto',
          state: st,
          statusText: stText,
          lastActiveAt: new Date(tInfo?.lastActiveAtMs || uiWin.updatedAtMs).toISOString(),
          pokemonSpecies: assignPokemonSpecies(s.id || s.name, s.name, s.role || 'worker', false),
          source: tp ? 'transcript' : 'ui-sync',
          _lastActiveMs: tInfo?.lastActiveAtMs || uiWin.updatedAtMs,
          _contextMetrics: tInfo?.contextMetrics || null,
          _explicitIdleMs: s.idleMs,
          _explicitIdleSince: s.idleSince,
          _explicitContext: s.context || null
        };
      });

      rawQueuesByConvId.set(resolvedConvId, {
        conversationId: resolvedConvId,
        conversationTitle,
        headerTitle: conversationTitle,
        swarmTitle: null,
        ...wsIdentity,
        windowId: uiWin.windowId,
        windowTitle: uiWin.windowTitle || null,
        appKind: uiWin.appKind || null,
        pid: uiWin.pid || null,
        isFocusedUi: Boolean(uiWin.focused),
        isUiSynced: true,
        leadRaw,
        subagentsRaw,
        watchDirs: [],
        latestActivityMs: uiWin.updatedAtMs
      });
    }
  }

  // Pass 3b: Also associate project-matching open windows (`windowId`/`windowTitle`/`appKind`/`pid`) onto disk queues
  // whose workspacePath or projectName matches an open UI window (even if that window is viewing another tab in the same project)
  for (const rq of rawQueuesByConvId.values()) {
    if (rq.windowId) continue;
    for (const uiWin of uiSyncWindows.values()) {
      const wsMatches =
        rq.workspacePath &&
        uiWin.workspacePath &&
        parseWorkspaceIdentity(uiWin.workspacePath).projectId === rq.projectId;
      const projMatches =
        rq.projectName &&
        rq.projectName !== DEFAULT_GLOBAL_PROJECT_NAME &&
        uiWin.projectName &&
        uiWin.projectName.toLowerCase() === rq.projectName.toLowerCase();
      if (wsMatches || projMatches) {
        rq.windowId = uiWin.windowId;
        rq.windowTitle = uiWin.windowTitle || null;
        rq.appKind = uiWin.appKind || null;
        rq.pid = uiWin.pid || null;
        if (uiWin.focused) break;
      }
    }
  }

  // Pass 4: Merge Simulated Queues (`POST /api/simulate` queue-mode) & Standalone Simulated Agents
  for (const [simConvId, sq] of simulatedQueues.entries()) {
    const wsIdentity = parseWorkspaceIdentity(sq.workspacePath || '', sq.projectName || '模拟训练项目');
    const leadSpec = sq.leadAgent || { name: 'coordinator', role: 'coordinator', state: 'sleeping' };
    const leadId = String(leadSpec.id || `${simConvId}:lead`);
    const leadName = normalizeAgentName(leadSpec.name || 'coordinator') || 'coordinator';
    const leadRole = String(leadSpec.role || 'coordinator');
    const leadState = VALID_STATES.has(leadSpec.state) ? leadSpec.state : 'sleeping';

    const leadRaw = {
      id: leadId,
      name: leadName,
      role: leadRole,
      model: leadSpec.model || 'pokemon-simulator',
      state: leadState,
      statusText: leadSpec.statusText || (leadState === 'sleeping' ? '💤 模拟领队待命中' : '⚡ 模拟领队指挥中'),
      lastActiveAt: sq.updatedAt || new Date(nowMs).toISOString(),
      pokemonSpecies:
        leadSpec.pokemonSpecies && isPackSpecies(leadSpec.pokemonSpecies)
          ? leadSpec.pokemonSpecies
          : assignPokemonSpecies(leadId, leadName, leadRole, true),
      _explicitSpecies: Boolean(leadSpec.pokemonSpecies && isPackSpecies(leadSpec.pokemonSpecies)),
      source: 'simulated',
      _lastActiveMs: nowMs,
      _explicitIdleMs: leadSpec.idleMs,
      _explicitIdleSince: leadSpec.idleSince,
      _explicitContext: leadSpec.context ? { ...leadSpec.context, source: 'simulated' } : null
    };

    const subagentsRaw = (Array.isArray(sq.subagents) ? sq.subagents : []).map((s, idx) => {
      const sId = String(s.id || `${simConvId}:sub-${idx + 1}`);
      const sName = normalizeAgentName(s.name || sId);
      const sRole = String(s.role || 'worker');
      const sState = VALID_STATES.has(s.state) ? s.state : 'working';
      return {
        id: sId,
        name: sName,
        role: sRole,
        model: s.model || 'pokemon-simulator',
        state: sState,
        statusText: s.statusText || (sState === 'sleeping' ? '💤 模拟队员待命中' : '⚡ 模拟队员行动中'),
        lastActiveAt: sq.updatedAt || new Date(nowMs).toISOString(),
        pokemonSpecies:
          s.pokemonSpecies && isPackSpecies(s.pokemonSpecies)
            ? s.pokemonSpecies
            : assignPokemonSpecies(sId, sName, sRole, false),
        _explicitSpecies: Boolean(s.pokemonSpecies && isPackSpecies(s.pokemonSpecies)),
        source: 'simulated',
        _lastActiveMs: nowMs,
        _explicitIdleMs: s.idleMs,
        _explicitIdleSince: s.idleSince,
        _explicitContext: s.context ? { ...s.context, source: 'simulated' } : null
      };
    });

    rawQueuesByConvId.set(simConvId, {
      conversationId: simConvId,
      conversationTitle: sanitizeConversationTitle(sq.conversationTitle) || '桌宠列队模拟会话',
      headerTitle: sanitizeConversationTitle(sq.conversationTitle) || '桌宠列队模拟会话',
      swarmTitle: null,
      ...wsIdentity,
      windowId: sq.windowId || null,
      windowTitle: sq.windowTitle || null,
      appKind: sq.appKind || null,
      pid: sq.pid || null,
      isFocusedUi: Boolean(sq.focused),
      isUiSynced: false,
      isSimulatedQueue: true,
      leadRaw,
      subagentsRaw,
      watchDirs: [],
      latestActivityMs: nowMs
    });
  }

  const allKnownAgentIds = new Set();
  const allKnownAgentNames = new Set();
  for (const rq of rawQueuesByConvId.values()) {
    allKnownAgentIds.add(rq.leadRaw.id);
    allKnownAgentNames.add(rq.leadRaw.name);
    for (const s of rq.subagentsRaw) {
      allKnownAgentIds.add(s.id);
      allKnownAgentNames.add(s.name);
    }
  }
  for (const [simKey, sim] of simulationOverrides.entries()) {
    if (allKnownAgentIds.has(sim.id) || allKnownAgentNames.has(sim.name) || allKnownAgentIds.has(simKey)) {
      continue;
    }
    const targetConvId = sim.conversationId || 'simulated-training-session';
    let targetQ = rawQueuesByConvId.get(targetConvId);
    if (!targetQ) {
      const wsIdentity = parseWorkspaceIdentity(sim.workspacePath || '', sim.projectName || '模拟训练场');
      const simIsLead = Boolean(sim.isLead || sim.role === 'coordinator' || sim.role === 'main-agent');
      const leadRaw = simIsLead
        ? {
            id: sim.id || simKey,
            name: sim.name || simKey,
            role: sim.role || 'main-agent',
            model: sim.model || 'pokemon-simulator',
            state: VALID_STATES.has(sim.state) ? sim.state : 'working',
            statusText: sim.statusText || '✨ 模拟训练模式运行中',
            lastActiveAt: sim.updatedAt || new Date(nowMs).toISOString(),
            pokemonSpecies: sim.pokemonSpecies || assignPokemonSpecies(sim.id, sim.name, sim.role, true),
            _explicitSpecies: Boolean(sim.pokemonSpecies),
            source: 'simulated',
            _lastActiveMs: nowMs,
            _explicitIdleMs: sim.idleMs,
            _explicitIdleSince: sim.idleSince
          }
        : {
            id: `${targetConvId}:lead`,
            name: 'coordinator',
            role: 'coordinator',
            model: 'pokemon-simulator',
            state: 'sleeping',
            statusText: '💤 模拟领队统筹中 · 单击看会话/双击弹起',
            lastActiveAt: sim.updatedAt || new Date(nowMs).toISOString(),
            pokemonSpecies: 'rotom',
            source: 'simulated',
            _lastActiveMs: nowMs
          };
      targetQ = {
        conversationId: targetConvId,
        conversationTitle: sanitizeConversationTitle(sim.conversationTitle) || '桌宠模拟会话',
        headerTitle: sanitizeConversationTitle(sim.conversationTitle) || '桌宠模拟会话',
        swarmTitle: null,
        ...wsIdentity,
        isSimulatedQueue: true,
        leadRaw,
        subagentsRaw: [],
        watchDirs: [],
        latestActivityMs: nowMs
      };
      rawQueuesByConvId.set(targetConvId, targetQ);
      if (simIsLead) continue;
    }
    targetQ.subagentsRaw.push({
      id: sim.id || simKey,
      name: sim.name || simKey,
      role: sim.role || 'simulated',
      model: sim.model || 'pokemon-simulator',
      state: VALID_STATES.has(sim.state) ? sim.state : 'working',
      statusText: sim.statusText || '✨ 模拟训练模式运行中',
      lastActiveAt: sim.updatedAt || new Date(nowMs).toISOString(),
      pokemonSpecies: sim.pokemonSpecies || assignPokemonSpecies(sim.id, sim.name, sim.role, false),
      _explicitSpecies: Boolean(sim.pokemonSpecies),
      source: 'simulated',
      _lastActiveMs: nowMs,
      _explicitIdleMs: sim.idleMs,
      _explicitIdleSince: sim.idleSince
    });
  }

  // Pass 5: Finalize every queue (enforce 60s subagent idle pruning + leadAgent keep-alive)
  const requestedConvId = options.convId ? String(options.convId).trim() : '';
  const requestedWindowId = options.windowId ? String(options.windowId).trim() : '';
  const requestedProject = options.project ? String(options.project).trim().toLowerCase() : '';
  const targetWindowConvId =
    requestedWindowId && uiSyncWindows.has(requestedWindowId)
      ? uiSyncWindows.get(requestedWindowId)._resolvedConvId
      : '';

  const survivingQueues = [];
  let fallbackFinalizedQueue = null;
  // IDE-bound visibility: only conversations active in project windows opened during this IDE launch,
  // pinned (lead never retires) until the window closes. Legacy 60s rules when no IDE window is connected.
  const ideScoped = !options.all && ideSession.isActive(nowMs);
  const ideCandidates = [];

  for (const rq of rawQueuesByConvId.values()) {
    const hasActiveMember =
      rq.leadRaw?.state !== 'sleeping' ||
      (Array.isArray(rq.subagentsRaw) && rq.subagentsRaw.some((s) => s.state && s.state !== 'sleeping'));
    const explicitlyRequested =
      (requestedConvId &&
        (rq.conversationId === requestedConvId ||
          rq.leadRaw?.id === requestedConvId ||
          (Array.isArray(rq.subagentsRaw) && rq.subagentsRaw.some((m) => m.id === requestedConvId)))) ||
      (targetWindowConvId && rq.conversationId === targetWindowConvId);
    const activeInThisLaunch =
      ONCE_MODE ||
      Boolean(options.all) ||
      Boolean(rq.isSimulatedQueue) ||
      hasActiveMember ||
      explicitlyRequested ||
      activatedThisLaunchConvIds.has(rq.conversationId) ||
      (Number(rq.latestActivityMs || 0) >= currentLaunchAtMs);

    if (!activeInThisLaunch) {
      continue;
    }
    if (hasActiveMember || Number(rq.latestActivityMs || 0) >= currentLaunchAtMs) {
      activatedThisLaunchConvIds.add(rq.conversationId);
    }

    const finalized = finalizeSessionQueue(rq, nowMs);
    const fbRank = (q) => (q.queue?.isFocusedUi ? 2 : q.queue?.isUiSynced ? 1 : 0);
    if (
      !fallbackFinalizedQueue ||
      fbRank(finalized) > fbRank(fallbackFinalizedQueue) ||
      (fbRank(finalized) === fbRank(fallbackFinalizedQueue) &&
        finalized.latestActivityMs > fallbackFinalizedQueue.latestActivityMs)
    ) {
      fallbackFinalizedQueue = finalized;
    }

    if (ideScoped && !explicitlyRequested) {
      ideCandidates.push({ ...finalized, isSimulated: Boolean(rq.isSimulatedQueue), watchDirs: rq.watchDirs || [] });
      continue;
    }
    if (finalized.shouldKeepAlive || explicitlyRequested || options.all || activatedThisLaunchConvIds.has(rq.conversationId)) {
      survivingQueues.push({ ...finalized, watchDirs: rq.watchDirs || [] });
    }
  }
  if (ideScoped) {
    for (const it of ideSession.selectVisible(ideCandidates, nowMs)) survivingQueues.push(it);
  }

  // Only show historical fallback in `--once` CLI probe mode; live launches only show sessions active in this launch.
  if (survivingQueues.length === 0 && !ideScoped && ONCE_MODE) {
    if (fallbackFinalizedQueue) {
      survivingQueues.push({ ...fallbackFinalizedQueue, watchDirs: [] });
    } else if (mostRecentFallbackRawQueue) {
      const fb = finalizeSessionQueue(mostRecentFallbackRawQueue, nowMs);
      survivingQueues.push({ ...fb, watchDirs: mostRecentFallbackRawQueue.watchDirs || [] });
    }
  }

  let filteredItems = survivingQueues;
  if (requestedConvId) {
    filteredItems = filteredItems.filter(
      (it) =>
        it.queue.conversationId === requestedConvId ||
        it.queue.members.some((m) => m.id === requestedConvId)
    );
  }
  if (targetWindowConvId) {
    filteredItems = filteredItems.filter((it) => it.queue.conversationId === targetWindowConvId);
  }
  if (requestedProject) {
    filteredItems = filteredItems.filter(
      (it) =>
        it.queue.projectName.toLowerCase() === requestedProject ||
        it.queue.projectId.toLowerCase() === requestedProject
    );
  }

  applyGachaToVisibleQueues(filteredItems, nowMs);

  // Group queues by `projectId` (`根据项目分类`)
  const projectsMap = new Map();
  for (const item of filteredItems) {
    const q = item.queue;
    for (const wd of item.watchDirs) dirsToWatch.push(wd);

    let proj = projectsMap.get(q.projectId);
    if (!proj) {
      proj = {
        projectId: q.projectId,
        projectName: q.projectName,
        workspacePath: q.workspacePath,
        hasActiveQueue: false,
        isFocusedProject: false,
        _latestActivityMs: 0,
        queues: []
      };
      projectsMap.set(q.projectId, proj);
    }
    proj.queues.push({ queue: q, latestActivityMs: item.latestActivityMs });
    if (q.isActiveQueue) proj.hasActiveQueue = true;
    if (q.isFocusedUi) proj.isFocusedProject = true;
    if (item.latestActivityMs > proj._latestActivityMs) {
      proj._latestActivityMs = item.latestActivityMs;
    }
  }

  const projects = Array.from(projectsMap.values())
    .map((proj) => {
      proj.queues.sort((a, b) => {
        if (a.queue.isFocusedUi !== b.queue.isFocusedUi) return a.queue.isFocusedUi ? -1 : 1;
        if (a.queue.isActiveQueue !== b.queue.isActiveQueue) return a.queue.isActiveQueue ? -1 : 1;
        if (a.queue.isActiveQueue && b.queue.isActiveQueue) {
          return a.queue.conversationId.localeCompare(b.queue.conversationId);
        }
        return b.latestActivityMs - a.latestActivityMs;
      });
      const orderedQueues = proj.queues.map((x) => x.queue);
      return {
        projectId: proj.projectId,
        projectName: proj.projectName,
        workspacePath: proj.workspacePath,
        hasActiveQueue: proj.hasActiveQueue,
        isFocusedProject: proj.isFocusedProject,
        queueCount: orderedQueues.length,
        _latestActivityMs: proj._latestActivityMs,
        queues: orderedQueues
      };
    })
    .sort((a, b) => {
      if (a.isFocusedProject !== b.isFocusedProject) return a.isFocusedProject ? -1 : 1;
      if (a.hasActiveQueue !== b.hasActiveQueue) return a.hasActiveQueue ? -1 : 1;
      if (a.hasActiveQueue && b.hasActiveQueue) {
        return a.projectName.localeCompare(b.projectName);
      }
      return b._latestActivityMs - a._latestActivityMs;
    })
    .map(({ _latestActivityMs, ...publicProj }) => publicProj);

  if (!requestedConvId && !requestedWindowId && !requestedProject && !options.all) {
    syncDirectoryWatchers(dirsToWatch);
  }

  const queues = [];
  const agents = [];
  let rowIndex = 0;
  for (const proj of projects) {
    for (const q of proj.queues) {
      const enrichedQueue = {
        ...q,
        rowIndex
      };
      queues.push(enrichedQueue);
      for (const m of q.members) {
        agents.push({
          ...m,
          rowIndex
        });
      }
      rowIndex++;
    }
  }

  const connectedWindows = Array.from(uiSyncWindows.values()).map((w) => ({
    windowId: w.windowId,
    appKind: w.appKind || null,
    windowTitle: w.windowTitle || null,
    pid: w.pid || null,
    workspacePath: w.workspacePath || null,
    projectName: w.projectName || null,
    conversationId: w.conversationId || null,
    resolvedConversationId: w._resolvedConvId || w.conversationId || null,
    conversationTitle: w.conversationTitle || null,
    focused: Boolean(w.focused),
    theme: w.theme || activeTheme,
    updatedAt: new Date(w.updatedAtMs).toISOString()
  }));

  const summary = {
    projectCount: projects.length,
    queueCount: queues.length,
    total: agents.length,
    leadCount: queues.length,
    subagentCount: Math.max(0, agents.length - queues.length),
    windowCount: connectedWindows.length,
    thinking: 0,
    working: 0,
    sleeping: 0,
    celebrating: 0,
    error: 0
  };
  for (const a of agents) {
    if (summary[a.state] !== undefined) summary[a.state]++;
  }

  const primaryQueue = queues[0] || null;
  const pubFocusReq = getPublicFocusRequest(nowMs);
  if (gacha.isBootstrapping && !requestedConvId && !requestedWindowId && !requestedProject) {
    gacha.finishBootstrap();
  }
  const recentGacha = gacha.getRecent(nowMs);
  const gachaSettings = gacha.settings;
  const pubSummonReq = getPublicSummonRequest(nowMs);

  return {
    ok: true,
    version: '4.1.0',
    mode: 'single-shared-overlay',
    updatedAt: new Date(nowMs).toISOString(),
    activeTheme,
    subagentIdleTtlMs: SUBAGENT_IDLE_TTL_MS,
    activeSessionId: primaryQueue?.conversationId || null,
    swarmTitle: primaryQueue?.conversationTitle || null,
    uiSynced: connectedWindows.length > 0,
    connectedWindows,
    summonRequestedAt: pubSummonReq?.requestedAt || null,
    lastSummonRequest: pubSummonReq,
    lastFocusRequest: pubFocusReq,
    latestFocusCommand: pubFocusReq,
    summary,
    recentGacha,
    gacha: {
      enabled: gachaSettings.gachaEnabled,
      revealAnimation: gachaSettings.revealAnimation,
      shinyRate: gachaSettings.shinyRate,
      latestSeq: recentGacha.length ? recentGacha[recentGacha.length - 1].seq : 0
    },
    // Clients refetch `/api/pack` when `pack.id` / `pack.version` changes.
    pack: (() => {
      const p = activePack();
      return p ? { id: p.id, name: p.name, version: p.version, baseUrl: `/packs/${p.id}/` } : null;
    })(),
    projects,
    queues,
    agents
  };
}

/**
 * Resolve full session + window target metadata for `POST /api/focus-session` when the user
 * double-clicks a `👑 leadAgent` in the single shared floating overlay (or Web/Sidecar arena).
 */
export function resolveFocusSessionTarget(body = {}, nowMs = Date.now()) {
  const dbSummaries = syncConversationSummariesDb();
  const fullSnap = scanAllAgents(nowMs, { all: true });

  let reqConvId = String(body.conversationId || body.cascadeId || body.id || '').trim();
  // Strip synthetic `:lead` suffix if caller passed `leadAgent.id` on a UI/simulated session
  if (reqConvId.endsWith(':lead')) {
    reqConvId = reqConvId.slice(0, -5);
  }
  // If caller passed a subagent/worker conversationId, map up to its parent conversation queue
  const directDbRow = reqConvId ? dbSummaries.get(reqConvId) : null;
  if (directDbRow?.parent_conversation_id) {
    reqConvId = String(directDbRow.parent_conversation_id);
  }

  let matchedQueue = null;
  if (reqConvId) {
    matchedQueue =
      fullSnap.queues.find(
        (q) => q.conversationId === reqConvId || q.members.some((m) => m.id === reqConvId)
      ) || null;
    if (matchedQueue) reqConvId = matchedQueue.conversationId;
  }

  const reqTitleClean = sanitizeConversationTitle(body.conversationTitle || body.headerTitle || body.title || '');
  const reqProjClean = String(body.projectName || '').trim();
  const reqWsIdentity = parseWorkspaceIdentity(body.workspacePath || '', reqProjClean);

  if (!matchedQueue && (reqTitleClean || reqProjClean)) {
    matchedQueue =
      fullSnap.queues.find((q) => {
        const titleHit =
          reqTitleClean &&
          (q.conversationTitle.toLowerCase() === reqTitleClean.toLowerCase() ||
            (q.headerTitle && q.headerTitle.toLowerCase() === reqTitleClean.toLowerCase()));
        const projHit = !reqProjClean || q.projectName.toLowerCase() === reqProjClean.toLowerCase();
        return Boolean(titleHit && projHit);
      }) || null;
    if (matchedQueue && !reqConvId) {
      reqConvId = matchedQueue.conversationId;
    }
  }

  const dbRow = reqConvId ? dbSummaries.get(reqConvId) : null;
  const dbHeaderTitle = sanitizeConversationTitle(dbRow?.title);
  const dbPreviewTitle = sanitizeConversationTitle(dbRow?.preview);
  const dbWsIdentity = parseWorkspaceIdentity(dbRow?.workspace_uris || '');

  // Also check `transcript.jsonl` head metadata if workspacePath is still empty
  let headWsIdentity = { workspacePath: '', projectName: DEFAULT_GLOBAL_PROJECT_NAME, projectId: DEFAULT_GLOBAL_PROJECT_ID };
  if (!matchedQueue?.workspacePath && !reqWsIdentity.workspacePath && !dbWsIdentity.workspacePath && reqConvId) {
    const tp = findTranscriptPathById(reqConvId);
    if (tp) {
      const hm = readTranscriptHeadMetadata(reqConvId, tp);
      if (hm.workspacePath) headWsIdentity = parseWorkspaceIdentity(hm.workspacePath);
    }
  }

  const workspacePath =
    matchedQueue?.workspacePath ||
    reqWsIdentity.workspacePath ||
    dbWsIdentity.workspacePath ||
    headWsIdentity.workspacePath ||
    '';

  const projectName =
    (matchedQueue?.projectName && matchedQueue.projectName !== DEFAULT_GLOBAL_PROJECT_NAME
      ? matchedQueue.projectName
      : '') ||
    (reqProjClean && reqProjClean !== DEFAULT_GLOBAL_PROJECT_NAME ? reqProjClean : '') ||
    (dbWsIdentity.projectName !== DEFAULT_GLOBAL_PROJECT_NAME ? dbWsIdentity.projectName : '') ||
    (headWsIdentity.projectName !== DEFAULT_GLOBAL_PROJECT_NAME ? headWsIdentity.projectName : '') ||
    matchedQueue?.projectName ||
    reqProjClean ||
    DEFAULT_GLOBAL_PROJECT_NAME;

  const conversationTitle =
    matchedQueue?.conversationTitle ||
    reqTitleClean ||
    dbHeaderTitle ||
    dbPreviewTitle ||
    '当前智能体会话';

  const headerTitle =
    dbHeaderTitle ||
    matchedQueue?.headerTitle ||
    sanitizeConversationTitle(body.headerTitle) ||
    conversationTitle;

  const swarmTitle = matchedQueue?.swarmTitle || null;
  const targetProjectId = workspacePath ? workspacePath.toLowerCase() : `project:${projectName.toLowerCase()}`;

  // Score all open UI windows in `uiSyncWindows` to find the exact BrowserWindow hosting this conversation/project
  let bestWin = null;
  let bestScore = 0;
  const explicitWinId = String(body.windowId || '').trim();

  for (const w of uiSyncWindows.values()) {
    if (!w || Number(w.expiresAtMs || 0) <= nowMs) continue;
    let score = 0;
    if (explicitWinId && w.windowId === explicitWinId) score += 1000;
    if (reqConvId && (w._resolvedConvId === reqConvId || w.conversationId === reqConvId)) score += 500;
    if (workspacePath && w.workspacePath) {
      const wId = parseWorkspaceIdentity(w.workspacePath).projectId;
      if (wId === targetProjectId) score += 260;
    }
    if (
      projectName &&
      projectName !== DEFAULT_GLOBAL_PROJECT_NAME &&
      w.projectName &&
      w.projectName.toLowerCase() === projectName.toLowerCase()
    ) {
      score += 160;
    }
    if (w.windowTitle) {
      const lowerWT = w.windowTitle.toLowerCase();
      if (headerTitle && lowerWT.includes(headerTitle.toLowerCase())) score += 90;
      else if (conversationTitle && lowerWT.includes(conversationTitle.toLowerCase())) score += 80;
      else if (
        projectName &&
        projectName !== DEFAULT_GLOBAL_PROJECT_NAME &&
        lowerWT.includes(projectName.toLowerCase())
      ) {
        score += 70;
      }
    }
    if (score > 0) {
      if (w.focused) score += 20;
      score += Math.min(15, Math.max(0, 15 - Math.floor((nowMs - w.updatedAtMs) / 1000)));
      if (score > bestScore) {
        bestScore = score;
        bestWin = w;
      }
    }
  }

  const candidateWindowTitles = Array.from(
    new Set(
      [
        bestWin?.windowTitle,
        matchedQueue?.windowTitle,
        headerTitle,
        conversationTitle,
        projectName !== DEFAULT_GLOBAL_PROJECT_NAME ? projectName : null
      ].filter(Boolean)
    )
  );

  // Which program should open the conversation: a UI window that reported it wins; otherwise the
  // Antigravity app (it lists every conversation) while it runs, else the IDE.
  const winAppKind = String(bestWin?.appKind || matchedQueue?.appKind || '').toLowerCase();
  const appAlive = nowMs - agyAppSeenAtMs <= AGY_APP_ALIVE_MS;
  let host;
  if (bestWin && winAppKind) host = winAppKind === 'hub' ? 'app' : 'ide';
  else host = appAlive ? 'app' : 'ide';

  return {
    requestId: `focus-${nowMs}-${++focusRequestSeq}`,
    requestedAt: new Date(nowMs).toISOString(),
    source: String(body.source || 'desktop-overlay'),
    host,
    appPid: host === 'app' && appAlive && agyAppMainPid ? agyAppMainPid : null,
    conversationId: reqConvId || null,
    conversationTitle,
    headerTitle,
    swarmTitle,
    projectName,
    workspacePath,
    windowId: bestWin?.windowId || matchedQueue?.windowId || (explicitWinId || null),
    windowTitle: bestWin?.windowTitle || matchedQueue?.windowTitle || null,
    appKind: bestWin?.appKind || matchedQueue?.appKind || null,
    pid: bestWin?.pid || matchedQueue?.pid || (body.pid ? Number(body.pid) : null),
    matchedUiWindow: Boolean(bestWin),
    candidateWindowTitles
  };
}

/**
 * Compute compact signature of queues, theme, & focus request for SSE change detection.
 */
function computeSignature(snapshot) {
  return JSON.stringify([
    snapshot.activeTheme,
    snapshot.lastFocusRequest?.requestId || null,
    snapshot.lastSummonRequest?.requestId || null,
    snapshot.gacha?.latestSeq || 0,
    snapshot.queues.map((q) => [
      q.projectId,
      q.projectName,
      q.conversationId,
      q.conversationTitle,
      q.windowId,
      q.hasActiveSubagent,
      q.members.map((m) => [
        m.id,
        m.name,
        m.isLead,
        m.queueIndex,
        m.state,
        m.statusText,
        m.pokemonSpecies,
        m.shiny ? 1 : 0,
        Math.round(m.context?.usedPct || 0),
        Math.round(m.context?.cacheHitPct || 0),
        m.state === 'sleeping' && !m.isLead ? Math.floor((m.idleMs || 0) / 5000) : 0
      ])
    ])
  ]);
}

let lastSnapshotHash = '';

function hashSignatureFast(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function broadcastSnapshotIfChanged(force = false) {
  const nowMs = Date.now();
  if (!force && !scanDirty && cachedSnapshot && nowMs - lastScanAtMs < SCAN_MIN_INTERVAL_MS) {
    return cachedSnapshot;
  }
  scanDirty = false;
  lastScanAtMs = nowMs;
  const snapshot = scanAllAgents(nowMs);
  cachedSnapshot = snapshot;
  const sig = computeSignature(snapshot);
  if (!force && sig === lastSnapshotSignature) {
    return snapshot;
  }
  lastSnapshotSignature = sig;
  lastSnapshotHash = hashSignatureFast(sig);

  if (sseClients.size > 0) {
    const payload = `event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch {
        sseClients.delete(res);
      }
    }
  }
  return snapshot;
}

const httpGuard = createHttpGuard({ port: PORT, extraOrigins: EXTRA_ALLOWED_ORIGINS });

// CORS is echoed only for allow-listed origins (set per request by the guard); never `*`.
function setCorsHeaders(res) {
  res.setHeader('Vary', 'Origin');
  if (!res._corsOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', res._corsOrigin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Cache-Control, Accept, X-Window-Id'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
}

function sendJson(res, statusCode, body, extraHeaders = null) {
  setCorsHeaders(res);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  };
  if (extraHeaders) {
    Object.assign(headers, extraHeaders);
  }
  res.writeHead(statusCode, headers);
  res.end(JSON.stringify(body));
}

function readRequestBody(req, maxBytes = 131072) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
};

/**
 * Apply queue-level or agent-level simulation instructions from `POST /api/simulate`.
 */
function applySimulationQueue(qItem, nowMs = Date.now()) {
  if (!qItem || typeof qItem !== 'object') return null;
  const convId = String(
    qItem.conversationId || `sim-queue-${Math.random().toString(36).slice(2, 8)}`
  ).trim();
  const action = String(qItem.action || '').toLowerCase();
  if (action === 'reset' || action === 'clear' || action === 'delete') {
    simulatedQueues.delete(convId);
    return { resetQueue: convId };
  }

  const ttlMs = qItem.ttlMs === undefined ? 120_000 : Number(qItem.ttlMs);
  const entry = {
    conversationId: convId,
    projectName: qItem.projectName ? String(qItem.projectName).trim() : '模拟项目',
    workspacePath: qItem.workspacePath ? String(qItem.workspacePath).trim() : '',
    conversationTitle: qItem.conversationTitle
      ? String(qItem.conversationTitle).trim()
      : '桌宠列队模拟会话',
    windowId: qItem.windowId ? String(qItem.windowId).trim() : null,
    windowTitle: qItem.windowTitle ? String(qItem.windowTitle).trim() : null,
    appKind: qItem.appKind ? String(qItem.appKind).trim() : null,
    pid: qItem.pid ? Number(qItem.pid) : null,
    focused: Boolean(qItem.focused),
    leadAgent: qItem.leadAgent || { name: 'coordinator', role: 'coordinator', state: 'sleeping' },
    subagents: Array.isArray(qItem.subagents) ? qItem.subagents : [],
    updatedAt: new Date(nowMs).toISOString(),
    expiresAtMs: ttlMs > 0 ? nowMs + ttlMs : 0
  };
  simulatedQueues.set(convId, entry);
  return { simulatedQueue: convId, projectName: entry.projectName, conversationTitle: entry.conversationTitle };
}

function applySimulationItem(item, nowMs = Date.now()) {
  if (!item || typeof item !== 'object') return null;

  if (item.theme) {
    setGlobalActiveTheme(item.theme, 'simulate', nowMs);
    if (!item.id && !item.name && !item.state && !item.leadAgent && !item.subagents && !item.action) {
      return { activeTheme };
    }
  }

  if (item.leadAgent || Array.isArray(item.subagents)) {
    return applySimulationQueue(item, nowMs);
  }

  const action = String(item.action || '').toLowerCase();
  const targetKey = normalizeAgentName(item.id || item.name || '');

  if ((action === 'reset' || action === 'clear') && !targetKey && !item.conversationId) {
    simulationOverrides.clear();
    simulatedQueues.clear();
    if (item.resetSpecies) speciesPreferences.clear();
    return { reset: 'all' };
  }

  if ((action === 'reset' || action === 'clear') && item.conversationId && !targetKey) {
    simulatedQueues.delete(String(item.conversationId).trim());
    return { resetQueue: item.conversationId };
  }

  if (targetKey && (action === 'reset' || action === 'auto' || action === 'sync' || item.state === 'auto')) {
    simulationOverrides.delete(targetKey);
    for (const [k, v] of simulationOverrides.entries()) {
      if (v.id === targetKey || v.name === targetKey) simulationOverrides.delete(k);
    }
    if (item.resetSpecies) {
      speciesPreferences.delete(targetKey);
    }
    if (item.pokemonSpecies && isPackSpecies(item.pokemonSpecies)) {
      speciesPreferences.set(targetKey, item.pokemonSpecies);
    }
    return { reset: targetKey };
  }

  const id = String(item.id || targetKey || `sim-${Math.random().toString(36).slice(2, 8)}`).trim();
  const name = normalizeAgentName(item.name || targetKey || id);
  const species =
    item.pokemonSpecies && isPackSpecies(String(item.pokemonSpecies).toLowerCase())
      ? String(item.pokemonSpecies).toLowerCase()
      : null;

  if (species) {
    speciesPreferences.set(id, species);
    speciesPreferences.set(name, species);
  }

  if (
    !item.state &&
    !item.statusText &&
    item.idleMs === undefined &&
    species &&
    item.keepAutoState !== false &&
    simulationOverrides.get(id) === undefined &&
    item.spawn !== true
  ) {
    const liveSnap = cachedSnapshot || scanAllAgents(nowMs);
    const existsLive = liveSnap.agents.some((a) => a.id === id || a.name === name);
    if (existsLive) {
      return { id, name, pokemonSpecies: species, mode: 'species-only' };
    }
  }

  const state = VALID_STATES.has(item.state) ? item.state : 'working';
  const defaultLabels = {
    thinking: '💭 模拟思考中：推演最佳战术...',
    working: '⚡ 模拟工作中：全力以赴！',
    sleeping: '💤 模拟休眠中：Zzz 恢复体力...',
    celebrating: '✨ 庆祝时刻：任务圆满大成功！',
    error: '💧 模拟异常：招式未命中 (@_@)'
  };

  const ttlMs = item.ttlMs === undefined ? 120_000 : Number(item.ttlMs);
  const expiresAtMs = ttlMs > 0 ? nowMs + ttlMs : 0;

  const explicitCtx =
    item.context && typeof item.context === 'object'
      ? { ...item.context }
      : item.usedPct !== undefined ||
          item.cacheHitPct !== undefined ||
          item.usedTokens !== undefined ||
          item.cachedTokens !== undefined ||
          item.maxTokens !== undefined
        ? {
            usedPct: item.usedPct,
            cacheHitPct: item.cacheHitPct,
            usedTokens: item.usedTokens,
            cachedTokens: item.cachedTokens,
            maxTokens: item.maxTokens
          }
        : undefined;

  const entry = {
    id,
    name,
    role: item.role ? String(item.role) : undefined,
    isLead: item.isLead !== undefined ? Boolean(item.isLead) : undefined,
    conversationId: item.conversationId ? String(item.conversationId).trim() : undefined,
    conversationTitle: item.conversationTitle ? String(item.conversationTitle).trim() : undefined,
    projectName: item.projectName ? String(item.projectName).trim() : undefined,
    workspacePath: item.workspacePath ? String(item.workspacePath).trim() : undefined,
    model: item.model ? String(item.model) : undefined,
    state,
    statusText: item.statusText ? String(item.statusText) : defaultLabels[state],
    idleMs: item.idleMs !== undefined ? Number(item.idleMs) : undefined,
    idleSince: item.idleSince ? String(item.idleSince) : undefined,
    context: explicitCtx,
    pokemonSpecies: species || undefined,
    updatedAt: new Date(nowMs).toISOString(),
    expiresAtMs
  };

  simulationOverrides.set(id, entry);
  return entry;
}

/**
 * HTTP Request Router
 */
async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
  } catch {
    sendJson(res, 400, { ok: false, error: 'Bad request URL' });
    return;
  }
  const pathname = url.pathname;

  // Security gate (see bridge/http-guard.mjs): loopback Host, allow-listed Origin, no cross-site requests.
  const verdict = httpGuard.check(req, pathname);
  res._corsOrigin = verdict.corsOrigin;
  setCorsHeaders(res);
  if (req.method === 'OPTIONS') {
    res.writeHead(verdict.corsOrigin ? 204 : 403);
    res.end();
    return;
  }
  if (!verdict.ok) {
    sendJson(res, 403, { ok: false, error: 'Forbidden', reason: verdict.reason });
    return;
  }

  // 1. Health check
  if (req.method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
    const nowMs = Date.now();
    // The Antigravity app's pet-arena sidecar pings with `client=agy-app`: keep a bound bridge alive while the app runs.
    if (url.searchParams.get('client') === 'agy-app') {
      ideSession.addHostExe('antigravity.exe');
      // The app's main-process hook reports its Hub page origin so the global skin there may call us.
      // Only native callers (no Origin / Sec-Fetch-Site) can register; browser pages never qualify.
      const hubOrigin = url.searchParams.get('hubOrigin');
      if (hubOrigin && verdict.reason === 'native-client') httpGuard.registerHubOrigin(hubOrigin);
      if (verdict.reason === 'native-client') {
        agyAppSeenAtMs = nowMs;
        const appPid = Number(url.searchParams.get('pid'));
        if (Number.isInteger(appPid) && appPid > 4) agyAppMainPid = appPid;
      }
    }
    const pubSummon = getPublicSummonRequest(nowMs);
    sendJson(res, 200, {
      ok: true,
      service: 'pokemon-agent-monitor',
      version: '4.1.0',
      mode: 'single-shared-overlay',
      host: HOST,
      port: PORT,
      activeTheme,
      summonRequestedAt: pubSummon?.requestedAt || null,
      lastSummonRequest: pubSummon,
      overlayMuted: existsSync(OVERLAY_MUTE_FILE),
      pollIntervalMs: POLL_INTERVAL_MS,
      uiSyncTtlMs: UI_SYNC_TTL_MS,
      subagentIdleTtlMs: SUBAGENT_IDLE_TTL_MS,
      sqliteSummariesEnabled: Boolean(DatabaseSyncClass && existsSync(SUMMARIES_DB_PATH)),
      connectedWindowCount: uiSyncWindows.size,
      activeWatchers: activeWatchers.size,
      uptimeSec: Math.round((nowMs - startedAtMs) / 1000),
      workspaceRoot: WORKSPACE_ROOT,
      species: activeSpeciesIds(),
      pack: activePack() ? { id: activePack().id, name: activePack().name } : null,
      packProblems: petPacks.problems,
      themes: ['pikachu', 'gengar', 'charizard', 'umbreon', 'mewtwo', 'rotom-light'],
      security: httpGuard.publicState()
    });
    return;
  }

  // 2. Live Project-Grouped Queues & Agents Snapshot (`?conv=`, `?windowId=`, `?project=`, `?all=1`)
  if (req.method === 'GET' && (pathname === '/api/agents' || pathname === '/agents' || pathname === '/api/queues')) {
    const convId =
      url.searchParams.get('conv') ||
      url.searchParams.get('conversationId') ||
      url.searchParams.get('cascadeId') ||
      '';
    const windowId = url.searchParams.get('windowId') || '';
    const project = url.searchParams.get('project') || '';
    const all = url.searchParams.get('all') === '1' || url.searchParams.get('all') === 'true';
    if (url.searchParams.get('client') === 'ide-extension') {
      ideSession.registerPoll(url.searchParams, Date.now());
    }

    if (convId || windowId || project || all) {
      const scoped = scanAllAgents(Date.now(), { convId, windowId, project, all });
      sendJson(res, 200, scoped);
      return;
    }

    const snapshot = broadcastSnapshotIfChanged(false);
    const etag = `"${lastSnapshotHash}-${openStageRequestedAtMs || 0}"`;
    if (req.headers['if-none-match'] === etag) {
      setCorsHeaders(res);
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    sendJson(res, 200, {
      ...snapshot,
      openStageRequestedAt: openStageRequestedAtMs || null,
      openStageTarget,
      ideSession: ideSession.publicState()
    }, { ETag: etag });
    return;
  }

  // 2b. Ask the Antigravity IDE extension to open the stage as an editor tab.
  //     `ideConnected` tells the caller (desktop overlay) whether to fall back to a browser window.
  if (req.method === 'POST' && pathname === '/api/open-stage') {
    try {
      await readRequestBody(req);
    } catch {
      // body is optional
    }
    const nowMs = Date.now();
    const target = ideSession.pickOpenStageTarget(nowMs);
    const ideConnected = Boolean(target);
    if (ideConnected) {
      openStageRequestedAtMs = nowMs;
      openStageTarget = target.inst;
    }
    sendJson(res, 200, {
      ok: true,
      ideConnected,
      requestedAt: ideConnected ? nowMs : null,
      target: ideConnected ? openStageTarget : null,
      workspaceName: ideConnected ? target.workspaceName || '' : ''
    });
    return;
  }

  // 3. SSE Live Event Stream (`snapshot`, `focus-session`, `theme-change`)
  if (req.method === 'GET' && (pathname === '/api/events' || pathname === '/events')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const initial = cachedSnapshot || broadcastSnapshotIfChanged(true);
    res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);
    sseClients.add(res);
    req.on('close', () => {
      sseClients.delete(res);
    });
    return;
  }

  // 3b. v4.1 Explicit Silent Summon of Single Shared Overlay (`/api/summon-overlay` & `/api/summon-desktop-pet`)
  if (pathname === '/api/summon-overlay' || pathname === '/api/summon-desktop-pet') {
    const nowMs = Date.now();
    if (req.method === 'GET') {
      const cur = getPublicSummonRequest(nowMs);
      sendJson(res, 200, {
        ok: true,
        summonRequestedAt: cur?.requestedAt || null,
        lastSummonRequest: cur,
        overlayMuted: existsSync(OVERLAY_MUTE_FILE)
      });
      return;
    }

    if (req.method === 'DELETE') {
      lastSummonRequest = null;
      const snapshot = broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true, cleared: true, ...snapshot });
      return;
    }

    if (req.method === 'POST') {
      let body = {};
      try {
        const raw = await readRequestBody(req);
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
        return;
      }

      // Immediately clear user `[×]` mute marker so `WinSta0\Default` watchers can launch the shared overlay
      let unmuted = false;
      if (existsSync(OVERLAY_MUTE_FILE)) {
        try {
          unlinkSync(OVERLAY_MUTE_FILE);
          unmuted = true;
        } catch {
          // ignore if concurrently removed
        }
      }

      const normTheme = normalizeThemeId(body.theme || '');
      if (normTheme) {
        setGlobalActiveTheme(normTheme, String(body.source || 'summon-overlay'), nowMs);
      }

      const summonCmd = {
        requestId: `summon-${nowMs}-${++summonRequestSeq}`,
        summonSeq: summonRequestSeq,
        requestedAt: new Date(nowMs).toISOString(),
        source: String(body.source || 'ui-summon'),
        theme: activeTheme,
        spriteStyle: body.spriteStyle === 'pixel' ? 'pixel' : 'showdown',
        forceRestart: Boolean(body.forceRestart)
      };

      lastSummonRequest = {
        ...summonCmd,
        expiresAtMs: nowMs + SUMMON_REQUEST_TTL_MS
      };

      if (sseClients.size > 0) {
        const summonPayload = `event: summon-overlay\ndata: ${JSON.stringify(summonCmd)}\n\n`;
        for (const client of sseClients) {
          try {
            client.write(summonPayload);
          } catch {
            sseClients.delete(client);
          }
        }
      }

      const snapshot = broadcastSnapshotIfChanged(true);
      sendJson(res, 200, {
        ok: true,
        unmuted,
        summon: summonCmd,
        summonRequestedAt: summonCmd.requestedAt,
        lastSummonRequest: summonCmd,
        activeTheme: snapshot.activeTheme,
        connectedWindows: snapshot.connectedWindows
      });
      return;
    }
  }

  // 4a. Execution reports from injected windows (diagnostics for double-click -> conversation switch)
  if (pathname === '/api/focus-ack') {
    if (req.method === 'GET') {
      sendJson(res, 200, { ok: true, acks: focusAcks.slice().reverse() });
      return;
    }
    if (req.method === 'POST') {
      let body = {};
      try {
        const raw = await readRequestBody(req, 16384);
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
        return;
      }
      const ack = recordFocusAck(body);
      console.log(`[focus-ack] ${ack.requestId || '-'} win=${ack.windowId || '-'} phase=${ack.phase || '-'} handled=${ack.handled} stage=${ack.stage || '-'} action=${ack.action || '-'} reason=${ack.reason || '-'}`);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  // 4. v4.0 Double-Click `leadAgent` -> Pop Up Corresponding Project & Conversation (`/api/focus-session`)
  if (pathname === '/api/focus-session') {
    const nowMs = Date.now();
    if (req.method === 'GET') {
      const cur = getPublicFocusRequest(nowMs);
      sendJson(res, 200, {
        ok: true,
        lastFocusRequest: cur,
        latestFocusCommand: cur,
        recentAcks: focusAcks.slice(-10).reverse()
      });
      return;
    }

    if (req.method === 'DELETE') {
      lastFocusRequest = null;
      const snapshot = broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true, cleared: true, ...snapshot });
      return;
    }

    if (req.method === 'POST') {
      let body = {};
      try {
        const raw = await readRequestBody(req);
        body = raw.trim() ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
        return;
      }

      const target = resolveFocusSessionTarget(body, nowMs);
      console.log(`[focus-session] ${target.requestId} conv=${target.conversationId || '-'} win=${target.windowId || '-'} matchedUiWindow=${target.matchedUiWindow} host=${target.host} sse=${sseClients.size} src=${target.source}`);
      lastFocusRequest = {
        ...target,
        expiresAtMs: nowMs + FOCUS_REQUEST_TTL_MS
      };

      // Broadcast dedicated SSE `event: focus-session` immediately for sub-10ms response
      if (sseClients.size > 0) {
        const focusPayload = `event: focus-session\ndata: ${JSON.stringify(target)}\n\n`;
        for (const client of sseClients) {
          try {
            client.write(focusPayload);
          } catch {
            sseClients.delete(client);
          }
        }
      }

      const snapshot = broadcastSnapshotIfChanged(true);
      sendJson(res, 200, {
        ok: true,
        target,
        focusCommand: target,
        lastFocusRequest: target,
        latestFocusCommand: target,
        activeTheme: snapshot.activeTheme,
        connectedWindows: snapshot.connectedWindows
      });
      return;
    }
  }

  // 5. v4.0 Global Theme Sync Endpoint (`GET /api/theme` & `POST /api/theme`)
  if ((req.method === 'GET' || req.method === 'POST') && pathname === '/api/theme') {
    const nowMs = Date.now();
    if (req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        activeTheme,
        source: activeThemeSource,
        updatedAt: activeThemeUpdatedAtMs ? new Date(activeThemeUpdatedAtMs).toISOString() : null
      });
      return;
    }

    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
      return;
    }

    const norm = normalizeThemeId(body.theme || body.activeTheme || '');
    if (!norm) {
      sendJson(res, 400, { ok: false, error: 'Invalid or missing theme ID' });
      return;
    }

    setGlobalActiveTheme(norm, String(body.source || 'theme-api'), nowMs);
    const snapshot = broadcastSnapshotIfChanged(true);
    sendJson(res, 200, {
      ok: true,
      activeTheme,
      ...snapshot
    });
    return;
  }

  // 5b. Pokémon gacha collection: Pokédex, roster, settings, manual pulls
  if (pathname === '/stage' || pathname === '/stage/') {
    res.writeHead(302, { Location: '/static/desktop-pet/overlay.html' });
    res.end();
    return;
  }
  // 5a. Skin packs: active pack descriptor, pack list, pack assets (`/packs/<id>/<path>`)
  if (req.method === 'GET' && pathname === '/api/pack') {
    const wanted = url.searchParams.get('id');
    const p = wanted ? petPacks.get(wanted) : activePack();
    if (!p) {
      sendJson(res, 404, { ok: false, error: wanted ? `Unknown pack ${wanted}` : 'No skin pack installed', problems: petPacks.problems });
      return;
    }
    // Absolute folders only for native clients (WPF overlay); browser callers get URLs.
    const native = !req.headers.origin && url.searchParams.get('paths') === '1';
    sendJson(res, 200, {
      ok: true,
      active: p.id === activePack()?.id,
      ...describePack(p, { withPaths: native, rarityMeta: RARITY_META })
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/packs') {
    const activeId = activePack()?.id || null;
    sendJson(res, 200, {
      ok: true,
      active: activeId,
      packs: petPacks.list().map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        author: p.author,
        license: p.license,
        description: p.description,
        private: p.private,
        source: p.source,
        creatureCount: p.creatures.length,
        styles: Object.keys(p.styles),
        active: p.id === activeId
      })),
      problems: petPacks.problems
    });
    return;
  }
  if (req.method === 'GET' && pathname.startsWith('/packs/')) {
    let parts;
    try {
      parts = decodeURIComponent(pathname.slice('/packs/'.length)).split('/');
    } catch {
      sendJson(res, 400, { ok: false, error: 'Bad path' });
      return;
    }
    const p = petPacks.get(parts.shift());
    const ext = extname(parts[parts.length - 1] || '').toLowerCase();
    const abs = p ? safePackPath(p.rootDir, parts.join('/')) : null;
    // Packs only serve media (+ pack.json); never scripts or pages from a third-party pack.
    const PACK_MEDIA = { '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };
    if (!abs || !PACK_MEDIA[ext]) {
      sendJson(res, 403, { ok: false, error: 'Forbidden path' });
      return;
    }
    try {
      if (!statSync(abs).isFile()) throw new Error('not a file');
      const headers = {
        'Content-Type': PACK_MEDIA[ext],
        'Cache-Control': 'max-age=300',
        'X-Content-Type-Options': 'nosniff',
        // Cross-origin readable so the IDE skin can fetch() sprites into blob: URLs (img-src there has no http:).
        'Cross-Origin-Resource-Policy': 'cross-origin'
      };
      if (ext === '.svg') headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
      res.writeHead(200, headers);
      res.end(readFileSync(abs));
    } catch {
      sendJson(res, 404, { ok: false, error: 'File not found' });
    }
    return;
  }

  if (pathname.startsWith('/api/collection') || pathname === '/api/gacha/pull') {
    if (req.method === 'GET' && pathname === '/api/collection') {
      sendJson(res, 200, gacha.getPublicState());
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }
    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
      return;
    }
    if (pathname === '/api/collection/settings') {
      const { packChanged, ...settings } = gacha.updateSettings(body || {});
      if (packChanged) {
        const p = activePack();
        broadcastSseEvent('pack-change', { id: p?.id || null, name: p?.name || null, version: p?.version || null });
      }
      broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true, settings, packChanged });
      return;
    }
    if (pathname === '/api/collection/assign') {
      const result = gacha.assign(String(body.key || ''), String(body.species || '').toLowerCase(), Boolean(body.shiny));
      if (result.ok) broadcastSnapshotIfChanged(true);
      sendJson(res, result.ok ? 200 : 400, result);
      return;
    }
    if (pathname === '/api/gacha/pull' || pathname === '/api/collection/pull') {
      const evt = gacha.demoPull();
      if (!evt) {
        sendJson(res, 409, { ok: false, error: 'No skin pack installed' });
        return;
      }
      broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true, draw: evt });
      return;
    }
    if (pathname === '/api/collection/reset') {
      if (body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: 'Pass {"confirm": true} to wipe the collection and roster.' });
        return;
      }
      gacha.resetCollection();
      broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true });
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Unknown collection endpoint' });
    return;
  }

  // 6. Multi-Window Live UI DOM + Registry + Theme Sync (`POST /api/ui-sync` & `DELETE /api/ui-sync`, 8s TTL)
  if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/ui-sync') {
    if (req.method === 'DELETE') {
      const targetWin = url.searchParams.get('windowId');
      if (targetWin) {
        uiSyncWindows.delete(targetWin);
      } else {
        uiSyncWindows.clear();
      }
      const snapshot = broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true, cleared: targetWin || 'all', ...snapshot });
      return;
    }

    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
      return;
    }

    const nowMs = Date.now();
    const windowId = String(body.windowId || req.headers['x-window-id'] || 'default-window').trim();
    const action = String(body.action || '').toLowerCase();

    if (action === 'clear' || action === 'reset') {
      uiSyncWindows.delete(windowId);
      const snapshot = broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true, windowId, cleared: true, ...snapshot });
      return;
    }

    // Smart multi-window `activeTheme` sync (prevents background windows from clobbering a freshly clicked theme!)
    const prevWin = uiSyncWindows.get(windowId);
    const incomingTheme = normalizeThemeId(body.theme || body.activeTheme || '');
    if (incomingTheme) {
      const userSwitchedInThisWindow =
        body.themeChanged === true || (prevWin && prevWin.theme && prevWin.theme !== incomingTheme);
      const initialThemeSeed =
        activeThemeUpdatedAtMs === 0 ||
        (!prevWin && body.focused !== false && nowMs - activeThemeUpdatedAtMs > 3000);
      if (userSwitchedInThisWindow || initialThemeSeed) {
        setGlobalActiveTheme(incomingTheme, `ui-sync:${windowId}`, nowMs);
      }
    }

    let rawLead = body.leadAgent && typeof body.leadAgent === 'object' ? body.leadAgent : null;
    let rawSubs = Array.isArray(body.subagents) ? body.subagents : null;

    if (!rawSubs && Array.isArray(body.agents)) {
      rawSubs = [];
      for (const a of body.agents) {
        if (!a || typeof a !== 'object') continue;
        const isLeadCandidate =
          a.isLead === true ||
          a.role === 'coordinator' ||
          a.role === 'main-agent' ||
          normalizeAgentName(a.name).toLowerCase() === 'coordinator' ||
          normalizeAgentName(a.name).toLowerCase() === 'main-agent' ||
          normalizeAgentName(a.name).toLowerCase() === 'lead-agent';
        if (isLeadCandidate && !rawLead) {
          rawLead = a;
        } else {
          rawSubs.push(a);
        }
      }
    }
    rawSubs = rawSubs || [];

    const hasMetadataOrAgents =
      Boolean(rawLead) ||
      rawSubs.length > 0 ||
      Boolean(
        body.conversationId ||
          body.cascadeId ||
          body.conversationTitle ||
          body.projectName ||
          body.workspacePath ||
          body.windowTitle
      );

    if (!hasMetadataOrAgents) {
      uiSyncWindows.delete(windowId);
      const snapshot = broadcastSnapshotIfChanged(false);
      sendJson(res, 200, {
        ok: true,
        windowId,
        ttlMs: UI_SYNC_TTL_MS,
        windowAgents: snapshot.agents,
        ...snapshot
      });
      return;
    }

    const ttlMs =
      body.ttlMs !== undefined
        ? Math.min(30_000, Math.max(1_000, Number(body.ttlMs) || UI_SYNC_TTL_MS))
        : UI_SYNC_TTL_MS;

    const sanitizeSyncAgent = (a, defaultRole = 'worker') => ({
      id: a?.id ? String(a.id).trim() : undefined,
      name: normalizeAgentName(a?.name || a?.id || ''),
      role: a?.role ? String(a.role).trim() : defaultRole,
      model: a?.model ? String(a.model).trim() : undefined,
      state: VALID_STATES.has(a?.state) ? a.state : 'working',
      statusText: a?.statusText ? String(a.statusText).slice(0, 100) : '',
      idleMs: a?.idleMs !== undefined ? Number(a.idleMs) : undefined,
      idleSince: a?.idleSince ? String(a.idleSince) : undefined,
      context: a?.context && typeof a.context === 'object' ? a.context : undefined
    });

    uiSyncWindows.set(windowId, {
      windowId,
      appKind: body.appKind ? String(body.appKind).trim().slice(0, 40) : prevWin?.appKind || null,
      windowTitle: body.windowTitle
        ? String(body.windowTitle).trim().slice(0, 180)
        : prevWin?.windowTitle || null,
      pid: body.pid && Number.isFinite(Number(body.pid)) ? Number(body.pid) : prevWin?.pid || null,
      conversationId: String(body.conversationId || body.cascadeId || '').trim() || null,
      projectName: body.projectName ? String(body.projectName).trim().slice(0, 80) : null,
      workspacePath: body.workspacePath ? String(body.workspacePath).trim() : null,
      conversationTitle: String(body.conversationTitle || body.title || '').trim().slice(0, 140) || null,
      focused: body.focused !== false,
      theme: incomingTheme || prevWin?.theme || activeTheme,
      leadAgent: rawLead ? sanitizeSyncAgent(rawLead, 'main-agent') : null,
      subagents: rawSubs
        .slice(0, 24)
        .map((s) => sanitizeSyncAgent(s, 'worker'))
        .filter((s) => Boolean(s.name)),
      updatedAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs
    });

    const snapshot = broadcastSnapshotIfChanged(false);
    const resolvedConvId = uiSyncWindows.get(windowId)?._resolvedConvId || null;
    const windowQueue =
      snapshot.queues.find((q) => q.conversationId === resolvedConvId) || snapshot.queues[0] || null;

    sendJson(res, 200, {
      ok: true,
      windowId,
      ttlMs,
      windowQueue,
      windowAgents: windowQueue ? windowQueue.members : snapshot.agents,
      ...snapshot
    });
    return;
  }

  // 7. Simulation & Multi-Queue TTL Testing API (`POST /api/simulate` & `DELETE /api/simulate`)
  if ((req.method === 'POST' || req.method === 'DELETE') && pathname === '/api/simulate') {
    if (req.method === 'DELETE') {
      simulationOverrides.clear();
      simulatedQueues.clear();
      const snapshot = broadcastSnapshotIfChanged(true);
      sendJson(res, 200, { ok: true, reset: 'all', ...snapshot });
      return;
    }

    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `Invalid JSON body: ${err.message}` });
      return;
    }

    const nowMs = Date.now();
    if (body.theme) {
      setGlobalActiveTheme(body.theme, 'simulate', nowMs);
    }

    const applied = [];
    if (Array.isArray(body.queues)) {
      for (const qItem of body.queues) {
        applied.push(applySimulationQueue(qItem, nowMs));
      }
    } else if (body.queue && typeof body.queue === 'object') {
      applied.push(applySimulationQueue(body.queue, nowMs));
    } else if (Array.isArray(body.simulations)) {
      for (const item of body.simulations) {
        applied.push(applySimulationItem(item, nowMs));
      }
    } else {
      applied.push(applySimulationItem(body, nowMs));
    }

    const snapshot = broadcastSnapshotIfChanged(true);
    const targetId = normalizeAgentName(body.id || body.name || '');
    const matchedAgent = targetId
      ? snapshot.agents.find((a) => a.id === targetId || a.name === targetId || a.id === body.id) || null
      : null;

    sendJson(res, 200, {
      ok: true,
      applied,
      agent: matchedAgent,
      ...snapshot
    });
    return;
  }

  // 8. Fast-path Hook Receiver (`hook-handler.mjs`)
  if (req.method === 'POST' && pathname === '/api/hook') {
    let body = {};
    try {
      const raw = await readRequestBody(req);
      body = raw.trim() ? JSON.parse(raw) : {};
    } catch (err) {
      sendJson(res, 400, { ok: false, error: `Invalid hook JSON: ${err.message}` });
      return;
    }

    const id = String(body.id || body.conversationId || '').trim();
    if (id) {
      hookUpdates.set(id, {
        ...body,
        id,
        updatedAt: body.updatedAt || new Date().toISOString(),
        expiresAtMs: Number(body.expiresAtMs) || Date.now() + 45_000
      });
      broadcastSnapshotIfChanged(true);
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  // 9. Safe Read-Only Workspace Static Assets (`/static/*`)
  if (req.method === 'GET' && pathname.startsWith('/static/')) {
    let relPath = '';
    try {
      relPath = decodeURIComponent(pathname.slice('/static/'.length));
    } catch {
      sendJson(res, 400, { ok: false, error: 'Bad path' });
      return;
    }
    const safeTarget = resolve(WORKSPACE_ROOT, normalize(relPath));
    // Only the UI folders are public; source, configs and dot-folders stay private.
    // (`relative()` instead of `startsWith()` so a sibling like "<root>-evil" can't slip through.)
    const rel = relative(WORKSPACE_ROOT, safeTarget).replace(/\\/g, '/');
    const topDir = rel.split('/')[0];
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || !STATIC_ALLOWED_DIRS.includes(topDir) || rel.split('/').some((seg) => seg.startsWith('.'))) {
      sendJson(res, 403, { ok: false, error: 'Forbidden path' });
      return;
    }
    try {
      const st = statSync(safeTarget);
      if (!st.isFile()) {
        sendJson(res, 404, { ok: false, error: 'File not found' });
        return;
      }
      const ext = extname(safeTarget).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      const headers = {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff'
      };
      // Pages (the stage) may only be framed by the bridge itself or the IDE (webview tab) — no clickjacking.
      if (ext === '.html' || ext === '.htm') {
        headers['Content-Security-Policy'] = "frame-ancestors 'self' vscode-webview: vscode-file:";
      }
      res.writeHead(200, headers);
      res.end(readFileSync(safeTarget));
      return;
    } catch {
      sendJson(res, 404, { ok: false, error: 'File not found' });
      return;
    }
  }

  // Root overview
  if (req.method === 'GET' && pathname === '/') {
    const pubSummon = getPublicSummonRequest(Date.now());
    sendJson(res, 200, {
      ok: true,
      service: 'pokemon-agent-monitor',
      version: '4.1.0',
      mode: 'single-shared-overlay',
      activeTheme,
      summonRequestedAt: pubSummon?.requestedAt || null,
      endpoints: [
        'GET    /health',
        'GET    /api/agents',
        'GET    /api/queues',
        'GET    /api/events',
        'POST   /api/summon-overlay',
        'GET    /api/summon-overlay',
        'DELETE /api/summon-overlay',
        'POST   /api/focus-session',
        'GET    /api/focus-session',
        'DELETE /api/focus-session',
        'POST   /api/theme',
        'GET    /api/theme',
        'POST   /api/ui-sync',
        'DELETE /api/ui-sync',
        'POST   /api/simulate',
        'DELETE /api/simulate',
        'POST   /api/hook',
        'GET    /static/<workspace-relative-path>'
      ]
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: `Unknown route: ${req.method} ${pathname}` });
}

// `--once` mode: print live snapshot JSON and exit immediately
if (ONCE_MODE) {
  const snap = scanAllAgents(Date.now());
  process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
  process.exit(0);
}

// Start HTTP Server
const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    sendJson(res, 500, { ok: false, error: err?.message || 'Internal server error' });
  });
});

// High-frequency 400ms background polling + fs.watch triggers + SSE keepalive
const pollInterval = setInterval(() => {
  try {
    broadcastSnapshotIfChanged(false);
  } catch {
    // ignore transient filesystem scan error
  }
}, POLL_INTERVAL_MS);
pollInterval.unref?.();

const keepaliveInterval = setInterval(() => {
  for (const res of sseClients) {
    try {
      res.write(': keepalive\n\n');
    } catch {
      sseClients.delete(res);
    }
  }
}, 15_000);
keepaliveInterval.unref?.();

server.on('error', async (err) => {
  if (err && err.code === 'EADDRINUSE' && !STRICT_PORT) {
    try {
      const resp = await fetch(`http://${HOST}:${PORT}/health`, {
        signal: AbortSignal.timeout(1000)
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data?.service === 'pokemon-agent-monitor') {
          console.log(
            `[pokemon-agent-monitor] Already running at http://${HOST}:${PORT} (v${data.version || '1.0'}, uptime ${data.uptimeSec}s).`
          );
          process.exit(0);
        }
      }
    } catch {
      // Fall through and report port conflict
    }
  }
  console.error(`[pokemon-agent-monitor] Failed to bind http://${HOST}:${PORT}:`, err?.message || err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  ideSession.start(); // watch Antigravity IDE processes; exit with the IDE once bound
  startHostWindowWatcher(); // Windows host-window auto-follow & staged app.asar swap
  const initial = broadcastSnapshotIfChanged(true);
  console.log(
    `⚡ [pokemon-agent-monitor v4.1] Listening on http://${HOST}:${PORT} (${POLL_INTERVAL_MS}ms + fs.watch) — ${initial.summary.projectCount} project(s), ${initial.summary.queueCount} queue(s), ${initial.summary.total} pet(s), theme=${initial.activeTheme}`
  );
});
