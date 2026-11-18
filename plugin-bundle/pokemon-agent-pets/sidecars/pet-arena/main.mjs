/**
 * Antigravity 2.0 Sidecar Backend — Pokémon Live Authentic Agent Pet Arena (`pet-arena`)
 * Serves the interactive Authentic Pokémon Agent Pet Arena + Theme Skin Switcher inside
 * Antigravity's right-hand Auxiliary Pane (`SIDECAR_UI_ENTRYPOINT_AUX_PANE`),
 * auto-starts the live agent monitor bridge + IDE-bound Windows floating pets on startup,
 * and provides backend RPCs to summon/stop/switch authentic Pokémon desktop pets.
 */

import { SidecarApp, Response } from 'sidecar_sdk';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..', '..');
const HTML_PATH = join(__dirname, 'index.html');
const BRIDGE_URL = process.env.POKEMON_BRIDGE_URL || 'http://127.0.0.1:17580';
const BRIDGE_WATCHDOG_MS = 10_000;
const WSCRIPT_EXE = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
const OVERLAY_STATE_FILE = join(tmpdir(), 'antigravity-pokemon-desktop-overlay-state.json');
const OVERLAY_MUTE_FILE = join(tmpdir(), 'antigravity-pokemon-desktop-overlay-muted.json');
// While the app runs, a desktop overlay that went away on its own (e.g. it was bound to an IDE that closed)
// is brought back at most once per this interval. "收回" (the mute file) always wins.
const OVERLAY_REVIVE_MIN_GAP_MS = 30_000;
const LS_CHECK_MS = 15_000;
const LS_MAX_FAILURES = 3;
let lastBridgeSpawnAt = 0;
let hasAutoLaunchedOverlayOnce = false;
let lastOverlayAutoLaunchAt = 0;
let initializedSummonWatermark = false;
let lastHandledSummonAt = 0;

/**
 * The app starts this sidecar through `cmd /c agy-node.cmd`; when the app (its language server) exits, nothing
 * stops us, so orphaned copies piled up and each one answered every summon. Exit once the language server
 * that launched us stops accepting connections.
 */
function parseLsAddress(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`);
    const port = Number(u.port);
    if (!u.hostname || !Number.isInteger(port) || port <= 0) return null;
    return { host: u.hostname.replace(/^\[|\]$/g, ''), port };
  } catch {
    return null;
  }
}

function probeTcp({ host, port }, timeoutMs = 2000) {
  return new Promise((resolveProbe) => {
    const sock = connect({ host, port });
    const done = (ok) => {
      sock.removeAllListeners();
      sock.destroy();
      resolveProbe(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

function startHostLivenessWatch() {
  const ls = parseLsAddress(process.env.ANTIGRAVITY_LS_ADDRESS);
  if (!ls) {
    console.log(`[pet-arena] no usable ANTIGRAVITY_LS_ADDRESS (${process.env.ANTIGRAVITY_LS_ADDRESS || 'unset'}); orphan watch off`);
    return;
  }
  console.log(`[pet-arena] orphan watch on language server ${ls.host}:${ls.port}`);
  let failures = 0;
  // `localhost` may resolve to ::1 while the language server only listens on 127.0.0.1: accept either.
  const targets = ls.host === 'localhost'
    ? [{ host: '127.0.0.1', port: ls.port }, { host: '::1', port: ls.port }]
    : [ls];
  const probeAny = async () => {
    for (const t of targets) {
      if (await probeTcp(t)) return true;
    }
    return false;
  };
  const timer = setInterval(async () => {
    const ok = await probeAny();
    failures = ok ? 0 : failures + 1;
    if (failures >= LS_MAX_FAILURES) {
      console.log(`[pet-arena] language server ${ls.host}:${ls.port} is gone; exiting orphaned sidecar`);
      process.exit(0);
    }
  }, LS_CHECK_MS);
  timer.unref?.();
}

/**
 * Resolve workspace root whether running directly inside `<workspace>/plugin-bundle/...`
 * or after syncing to `~/.gemini/config/plugins/pokemon-agent-pets/`.
 */
function resolveWorkspaceRoot() {
  const cfgPath = join(PLUGIN_ROOT, 'workspace-config.json');
  if (existsSync(cfgPath)) {
    try {
      const rawCfg = readFileSync(cfgPath, 'utf-8').replace(/^\uFEFF/, '');
      const cfg = JSON.parse(rawCfg);
      if (cfg.workspaceRoot && existsSync(cfg.workspaceRoot)) {
        return cfg.workspaceRoot;
      }
    } catch {}
  }
  return resolve(PLUGIN_ROOT, '..', '..');
}

/**
 * `autoShowDesktopPet` switch in the plugin's `workspace-config.json` (written by sync-plugin.ps1, which keeps the
 * user's value on re-sync). Default on. Off = the app never pops / revives the desktop overlay by itself; explicit
 * summons still work. Read on every use, so editing the file takes effect without restarting the app.
 */
function isAutoShowDesktopPetEnabled() {
  try {
    const cfg = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'workspace-config.json'), 'utf-8').replace(/^\uFEFF/, ''));
    return cfg?.autoShowDesktopPet !== false;
  } catch {
    return true;
  }
}

/** Start time (ms) of the oldest running `Antigravity.exe`, i.e. when this app run began; 0 if unknown. */
function getAppRunStartMs() {
  return new Promise((resolveStart) => {
    if (process.platform !== 'win32') return resolveStart(0);
    const ps = "$p = Get-Process -Name Antigravity -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { $p.StartTime.ToUniversalTime().ToString('o') }";
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 8000, windowsHide: true }, (err, stdout) => {
        const ms = err ? 0 : Date.parse(String(stdout || '').trim());
        resolveStart(Number.isFinite(ms) ? ms : 0);
      });
    } catch {
      resolveStart(0);
    }
  });
}

/**
 * The mute file (written when the user clicks the overlay's [×] / "收回") outlives the app. A mute from an EARLIER
 * app run must not keep the pet hidden forever, so it is dropped here; a mute from THIS run is kept and honored.
 */
async function clearStaleOverlayMute() {
  if (!existsSync(OVERLAY_MUTE_FILE)) return;
  let mutedAt = 0;
  try {
    const st = JSON.parse(readFileSync(OVERLAY_MUTE_FILE, 'utf-8').replace(/^\uFEFF/, ''));
    mutedAt = Date.parse(String(st?.mutedAt || '')) || 0;
  } catch {}
  if (!mutedAt) {
    try { mutedAt = statSync(OVERLAY_MUTE_FILE).mtimeMs || 0; } catch {}
  }
  const appStart = (await getAppRunStartMs()) || (Date.now() - process.uptime() * 1000);
  if (mutedAt && mutedAt < appStart - 2000) {
    try { unlinkSync(OVERLAY_MUTE_FILE); } catch {}
    console.log('[pet-arena] dropped desktop-overlay mute left over from a previous app run');
  }
}

/**
 * Read a shared asset (`assets/*` or `theme-css/*`) from either the bundled
 * `vendor/` mirror inside the plugin or the workspace root.
 */
function readSharedAsset(relSegments) {
  const vendorCandidate = join(PLUGIN_ROOT, 'vendor', ...relSegments);
  if (existsSync(vendorCandidate)) {
    return readFileSync(vendorCandidate, 'utf-8');
  }
  const wsRoot = resolveWorkspaceRoot();
  const wsCandidate = join(wsRoot, ...relSegments);
  if (existsSync(wsCandidate)) {
    return readFileSync(wsCandidate, 'utf-8');
  }
  return '';
}

function resolveSilentVbsPath() {
  const wsRoot = resolveWorkspaceRoot();
  const wsVbs = join(wsRoot, 'desktop-pet', 'silent-launch.vbs');
  if (existsSync(wsVbs)) return wsVbs;
  const vendorVbs = join(PLUGIN_ROOT, 'vendor', 'silent-launch.vbs');
  if (existsSync(vendorVbs)) return vendorVbs;
  return wsVbs;
}

/**
 * Zero-console silent process launcher via GUI-subsystem `wscript.exe //B //Nologo`.
 * Prevents console host or Windows Terminal popups on Windows 10/11.
 */
function runSilentVbs(targetArgs) {
  if (process.platform !== 'win32') return false;
  const vbsPath = resolveSilentVbsPath();
  if (!existsSync(vbsPath)) return false;
  try {
    execFile(
      WSCRIPT_EXE,
      ['//B', '//Nologo', vbsPath, ...targetArgs],
      { timeout: 5000, windowsHide: true },
      () => {}
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve real Node binary (bypassing `~/.nvmd/bin` wrapper shim).
 */
function resolveRealNodeExe() {
  const home = homedir();
  const nvmdDef = join(home, '.nvmd', 'default');
  if (existsSync(nvmdDef)) {
    try {
      const ver = readFileSync(nvmdDef, 'utf-8').trim();
      if (ver) {
        const cand = join(home, '.nvmd', 'versions', ver, 'node.exe');
        if (existsSync(cand)) return cand;
      }
    } catch {}
  }
  const versDir = join(home, '.nvmd', 'versions');
  if (existsSync(versDir)) {
    try {
      const dirs = readdirSync(versDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
        .reverse();
      for (const d of dirs) {
        const cand = join(versDir, d, 'node.exe');
        if (existsSync(cand)) return cand;
      }
    } catch {}
  }
  if (process.execPath && !process.execPath.toLowerCase().includes('\\.nvmd\\bin\\')) {
    if (process.execPath.toLowerCase().endsWith('node.exe') && existsSync(process.execPath)) {
      return process.execPath;
    }
  }
  const pfNode = join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
  if (existsSync(pfNode)) return pfNode;
  return 'node.exe';
}

function ensureBridgeStarted() {
  const now = Date.now();
  if (now - lastBridgeSpawnAt < 12_000) return false;
  const wsRoot = resolveWorkspaceRoot();
  const bridgeScript = join(wsRoot, 'bridge', 'agent-monitor.mjs');
  if (!existsSync(bridgeScript)) return false;
  lastBridgeSpawnAt = now;
  return runSilentVbs([resolveRealNodeExe(), bridgeScript]);
}

function isOverlayProcessAlive() {
  if (!existsSync(OVERLAY_STATE_FILE)) return false;
  try {
    const raw = readFileSync(OVERLAY_STATE_FILE, 'utf-8').replace(/^\uFEFF/, '');
    const st = JSON.parse(raw);
    const pid = Number(st && st.pid);
    if (!Number.isInteger(pid) || pid <= 4) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 10s Bridge Health & Explicit Summon Watchdog (NO 10s blind overlay respawn loop!):
 * 1) Revives `bridge/agent-monitor.mjs` silently via `wscript.exe //B` if offline.
 * 2) Honors explicit `summonRequestedAt` from `POST /api/summon-overlay` so clicking
 *    `🪟 召唤/显示置顶浮窗` in any UI immediately wakes the floating overlay on `WinSta0\Default`.
 */
async function checkAndReviveBridge() {
  try {
    // `client=agy-app` tells the bridge the Antigravity app is a host too, so a bridge bound to the IDE
    // keeps running while the app is open (it still exits once both are closed).
    const res = await fetch(`${BRIDGE_URL}/health?client=agy-app`, {
      signal: AbortSignal.timeout(1200)
    });
    if (res.ok) {
      const health = await res.json().catch(() => null);
      const rawSummon = health?.summonRequestedAt;
      const summonTs = typeof rawSummon === 'number'
        ? rawSummon
        : (rawSummon ? Date.parse(String(rawSummon)) || 0 : 0);
      if (!initializedSummonWatermark) {
        initializedSummonWatermark = true;
        if (summonTs > 0 && (Date.now() - summonTs) < 8_000) {
          lastHandledSummonAt = summonTs;
          invokeDesktopPetLauncher({ bindToIde: true, forceRestart: true });
        } else {
          lastHandledSummonAt = summonTs;
        }
      } else if (summonTs > lastHandledSummonAt) {
        lastHandledSummonAt = summonTs;
        invokeDesktopPetLauncher({ bindToIde: true, forceRestart: true });
      } else {
        reviveOverlayIfGone();
      }
      return true;
    }
  } catch {}
  ensureBridgeStarted();
  return false;
}

function startBridgeWatchdog() {
  setTimeout(() => { void checkAndReviveBridge(); }, 1500).unref?.();
  const timer = setInterval(() => {
    void checkAndReviveBridge();
  }, BRIDGE_WATCHDOG_MS);
  timer.unref?.();
}

/**
 * Launch or stop the v4.1 Single Shared Windows Floating Pokemon Overlay silently via `wscript.exe //B`.
 */
function invokeDesktopPetLauncher({
  theme = '',
  spriteStyle = 'showdown',
  stop = false,
  bindToIde = true,
  forceRestart = false,
  fromWatchdog = false
} = {}) {
  const wsRoot = resolveWorkspaceRoot();
  const launcher = join(wsRoot, 'desktop-pet', 'launch-desktop-pet.ps1');
  const overlay = join(wsRoot, 'desktop-pet', 'pokemon-desktop-overlay.ps1');
  let cleanTheme = String(theme || '').replace(/[^a-z-]/gi, '');
  if (cleanTheme === 'rotom-light') cleanTheme = 'pokedex-light';
  const cleanStyle = spriteStyle === 'pixel' ? 'pixel' : 'showdown';

  ensureBridgeStarted();

  if (!stop && !fromWatchdog) {
    try {
      if (existsSync(OVERLAY_MUTE_FILE)) unlinkSync(OVERLAY_MUTE_FILE);
    } catch {}
  }

  const targetScript = existsSync(launcher) ? launcher : overlay;
  if (!existsSync(targetScript)) {
    return { ok: false, error: `Desktop pet script not found at ${targetScript}` };
  }

  const args = [
    'powershell.exe',
    '-STA',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    targetScript,
    '-SpriteStyle',
    cleanStyle
  ];
  if (cleanTheme) args.push('-Theme', cleanTheme);
  if (targetScript === launcher && stop) {
    args.push('-StopPets');
  } else {
    if (bindToIde) args.push('-BindToIde');
    if (forceRestart) args.push('-ForceRestart');
    if (targetScript === launcher && fromWatchdog) args.push('-FromWatchdog');
  }

  const launched = runSilentVbs(args);
  return {
    ok: launched,
    action: stop ? 'stopped' : 'launched',
    launcher: 'wscript-vbs',
    theme: cleanTheme || 'auto',
    spriteStyle: cleanStyle,
    bindToIde
  };
}

function healGlobalSkinIfUpdated() {
  if (process.platform !== 'win32') return;
  try {
    const skinStateFile = join(homedir(), '.gemini', 'antigravity', 'pokemon-skin-state.json');
    if (!existsSync(skinStateFile)) return;
    const state = JSON.parse(readFileSync(skinStateFile, 'utf8'));
    if (!state || state.enabled !== true) return;
    const wsRoot = resolveWorkspaceRoot();
    const patchEngine = join(wsRoot, 'vscode-pokemon-theme', 'full-app-skin', 'patch-engine.mjs');
    if (!existsSync(patchEngine)) return;
    const nodeBin = resolveNodeExe();
    execFile(nodeBin, [patchEngine, 'heal', '--spawn-swap-watcher'], { windowsHide: true, timeout: 25_000 }, () => {});
  } catch {
    // Non-fatal
  }
}

/**
 * Auto-launch Bridge + IDE-bound Shared Floating Overlay AT MOST ONCE per Sidecar startup (= app start):
 * a [×] mute left over from a previous app run is dropped first, a mute from this run is honored, and the
 * launcher's single-instance check (`launch-desktop-pet.ps1` + overlay mutex) prevents a second window.
 */
async function autoStartWithAntigravityHost() {
  ensureBridgeStarted();
  if (process.platform !== 'win32') return;
  healGlobalSkinIfUpdated();
  if (hasAutoLaunchedOverlayOnce) return;
  hasAutoLaunchedOverlayOnce = true;
  if (!isAutoShowDesktopPetEnabled()) return;
  await clearStaleOverlayMute();
  reviveOverlayIfGone();
}

/** Start the shared overlay when it is not running and the user has not put it away ("收回"). Throttled. */
function reviveOverlayIfGone() {
  if (process.platform !== 'win32') return;
  if (!isAutoShowDesktopPetEnabled()) return;
  if (existsSync(OVERLAY_MUTE_FILE)) return;
  if (isOverlayProcessAlive()) return;
  const now = Date.now();
  if (now - lastOverlayAutoLaunchAt < OVERLAY_REVIVE_MIN_GAP_MS) return;
  lastOverlayAutoLaunchAt = now;
  invokeDesktopPetLauncher({
    bindToIde: true,
    forceRestart: false,
    fromWatchdog: true,
    spriteStyle: 'showdown'
  });
}

startHostLivenessWatch();
void autoStartWithAntigravityHost();
startBridgeWatchdog();

const app = new SidecarApp();

// 1. Serve Main Auxiliary Pane HTML & Shared `@sprites` + `@theme` Assets
app.page('/', () => {
  return new Response(readFileSync(HTML_PATH, 'utf-8'), {
    contentType: 'text/html; charset=utf-8'
  });
});

app.page('/theme-css/antigravity-pokemon-skin.css', () => {
  return new Response(readSharedAsset(['theme-css', 'antigravity-pokemon-skin.css']), {
    contentType: 'text/css; charset=utf-8'
  });
});

app.page('/assets/pet-sprites.css', () => {
  return new Response(readSharedAsset(['assets', 'pet-sprites.css']), {
    contentType: 'text/css; charset=utf-8'
  });
});

app.page('/assets/pet-sprites.js', () => {
  return new Response(readSharedAsset(['assets', 'pet-sprites.js']), {
    contentType: 'application/javascript; charset=utf-8'
  });
});

// 1b. Skin pack: descriptor, pack list, pack switching and pack media, all proxied from the bridge so the
//     aux-pane page only ever talks to its own origin (`plugin://...`).
async function bridgeJson(path, init = {}, timeoutMs = 1500) {
  const res = await fetch(`${BRIDGE_URL}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return { status: res.status, body };
}

app.api('/api/pack', async (data) => {
  const id = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(String(data?.id || '')) ? `?id=${data.id}` : '';
  try {
    return (await bridgeJson(`/api/pack${id}`)).body;
  } catch (err) {
    ensureBridgeStarted();
    return { ok: false, offline: true, error: err.message };
  }
}, 'GET');

app.api('/api/packs', async () => {
  try {
    return (await bridgeJson('/api/packs')).body;
  } catch (err) {
    ensureBridgeStarted();
    return { ok: false, offline: true, packs: [], error: err.message };
  }
}, 'GET');

app.api('/api/pack-select', async (data) => {
  const id = String(data?.id || '');
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) return { ok: false, error: 'bad pack id' };
  try {
    const { body } = await bridgeJson('/api/collection/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activePack: id })
    });
    const active = body?.settings?.activePack;
    return active === id ? { ok: true, id } : { ok: false, error: body?.error || `pack "${id}" is not installed` };
  } catch (err) {
    ensureBridgeStarted();
    return { ok: false, error: err.message };
  }
}, 'POST');

const PACK_ASSET_RE = /^[a-z0-9][a-z0-9_-]{0,63}\/(?:[A-Za-z0-9_.%-]+\/)*[A-Za-z0-9_.%-]+\.(?:png|gif|webp)$/;
app.api('/api/pack-asset', async (data) => {
  const p = String(data?.p || '');
  if (!PACK_ASSET_RE.test(p) || p.includes('..')) {
    return new Response('bad path', { status: 400 });
  }
  try {
    const res = await fetch(`${BRIDGE_URL}/packs/${p}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return new Response('not found', { status: res.status === 403 ? 403 : 404 });
    const type = res.headers.get('content-type') || 'application/octet-stream';
    return new Response(Buffer.from(await res.arrayBuffer()), {
      contentType: type,
      headers: { 'Cache-Control': 'max-age=300', 'X-Content-Type-Options': 'nosniff' }
    });
  } catch {
    ensureBridgeStarted();
    return new Response('bridge offline', { status: 503 });
  }
}, 'GET');

// 2. Proxy Live v3.0 Project-Grouped Queues & Agent Snapshot (auto-starting bridge if offline)
app.api('/api/agents-snapshot', async () => {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/agents`, {
      signal: AbortSignal.timeout(900)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    ensureBridgeStarted();
  }
  return { ok: false, offline: true, version: '3.0.0', projects: [], queues: [], agents: [] };
}, 'GET');

app.api('/api/queues', async () => {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/queues`, {
      signal: AbortSignal.timeout(900)
    });
    if (res.ok) {
      return await res.json();
    }
  } catch {
    ensureBridgeStarted();
  }
  return { ok: false, offline: true, version: '3.0.0', projects: [], queues: [], agents: [] };
}, 'GET');

// 3. Proxy Simulation / Species Override & Live UI Sync to Bridge
app.api('/api/simulate', async (data) => {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/simulate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
      signal: AbortSignal.timeout(1200)
    });
    return await res.json();
  } catch (err) {
    ensureBridgeStarted();
    return { ok: false, error: err.message };
  }
}, 'POST');

app.api('/api/ui-sync', async (data) => {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/ui-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
      signal: AbortSignal.timeout(1000)
    });
    return await res.json();
  } catch (err) {
    ensureBridgeStarted();
    return { ok: false, error: err.message };
  }
}, 'POST');

app.api('/api/focus-session', async (data) => {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/focus-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data || {}),
      signal: AbortSignal.timeout(1500)
    });
    return await res.json();
  } catch (err) {
    ensureBridgeStarted();
    return { ok: false, error: err.message };
  }
}, 'POST');

app.api('/api/theme', async (data) => {
  try {
    const rawTheme = String(data?.theme || 'mewtwo');
    const bridgeTheme = rawTheme === 'pokedex-light' ? 'rotom-light' : rawTheme;
    const res = await fetch(`${BRIDGE_URL}/api/theme`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: bridgeTheme, source: data?.source || 'pet-arena-sidecar' }),
      signal: AbortSignal.timeout(1200)
    });
    return await res.json();
  } catch (err) {
    ensureBridgeStarted();
    return { ok: false, error: err.message };
  }
}, 'POST');

// 4. One-Click Summon / Stop Windows Transparent Floating Authentic Desktop Pets
app.api('/api/summon-desktop-pet', async (data) => {
  const theme = String(data?.theme || '').replace(/[^a-z-]/gi, '');
  const spriteStyle = data?.spriteStyle === 'pixel' ? 'pixel' : 'showdown';
  const stopPets = Boolean(data?.stop);
  const bindToIde = data?.bindToIde !== false;

  if (!stopPets) {
    fetch(`${BRIDGE_URL}/api/summon-overlay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, spriteStyle, source: 'pet-arena-sidecar' }),
      signal: AbortSignal.timeout(1000)
    }).catch(() => {});
  }

  return invokeDesktopPetLauncher({
    theme,
    spriteStyle,
    stop: stopPets,
    bindToIde,
    forceRestart: !stopPets
  });
}, 'POST');

app.api('/api/summon-overlay', async (data) => {
  const theme = String(data?.theme || '').replace(/[^a-z-]/gi, '');
  const spriteStyle = data?.spriteStyle === 'pixel' ? 'pixel' : 'showdown';
  try {
    await fetch(`${BRIDGE_URL}/api/summon-overlay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme, spriteStyle, source: data?.source || 'pet-arena-sidecar' }),
      signal: AbortSignal.timeout(1000)
    });
  } catch {}
  return invokeDesktopPetLauncher({
    theme,
    spriteStyle,
    stop: false,
    bindToIde: true,
    forceRestart: true
  });
}, 'POST');

// 5. Open the web pet stage served by the bridge (`/stage`) in the default browser.
//    (Opening overlay.html from disk gives it a `null` origin, which the bridge's HTTP guard rejects.)
app.api('/api/open-web-stage', async () => {
  const stageUrl = `${BRIDGE_URL}/stage`;
  ensureBridgeStarted();
  const ok = runSilentVbs(['explorer.exe', stageUrl]);
  return { ok, url: stageUrl };
}, 'POST');

app.run();
