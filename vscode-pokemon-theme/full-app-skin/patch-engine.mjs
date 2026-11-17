#!/usr/bin/env node
/**
 * Safe Dual-App Global Pokemon Skin Patch & Restore Engine (v4.1)
 * Targets:
 *   - App A: Antigravity 2.0 (%LOCALAPPDATA%/Programs/antigravity)
 *       * dist/utils.js hook repacked into resources/app.asar (Electron loads app.asar before an unpacked
 *         resources/app folder, so the old extract-only approach never ran). Original kept as
 *         app.asar.pokemon-backup; skin CSS/JS live outside the archive in resources/pokemon-skin/.
 *       * Zero-console silent launcher via wscript.exe //B //Nologo silent-launch.vbs
 *       * Auto-ensures Bridge (127.0.0.1:17580) + one-shot Shared OS Overlay startup + SSE summon-overlay & focus-session
 *   - App B: Antigravity IDE (%LOCALAPPDATA%/Programs/Antigravity IDE)
 *       * workbench.html + workbench-jetski-agent.html external skin assets + product.json SHA-256 checksum sync
 *       * out/main.js ESM hook (with .pokemon-backup byte-exact restore) using wscript.exe silent launcher
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VALID_THEMES = new Set(['mewtwo', 'pikachu', 'gengar', 'charizard', 'umbreon', 'pokedex-light']);

function parseArgs(argv) {
  const mode = argv[2] === 'restore' ? 'restore' : 'apply';
  let theme = 'mewtwo';
  let only = '';
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1]) {
      only = argv[i + 1] === 'app-a' ? 'app-a' : argv[i + 1] === 'app-b' ? 'app-b' : '';
      i++;
      continue;
    }
    if ((argv[i] === '--theme' || argv[i] === '-t') && argv[i + 1]) {
      const candidate = argv[i + 1].toLowerCase().trim();
      if (VALID_THEMES.has(candidate)) {
        theme = candidate;
      }
      i++;
    }
  }
  return { mode, theme, only };
}

function sha256Base64NoPad(filePath) {
  const bytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------------------------------------
// Minimal asar reader / writer (zero dependencies).
// Layout: [u32 4][u32 headerPickleSize] then header pickle [u32 payloadSize][u32 jsonLen][json, 4-aligned],
// then the file bodies; each file node's `offset` (a string) is relative to the end of the header.
// ---------------------------------------------------------------------------------------------------------
const ASAR_BLOCK_SIZE = 4 * 1024 * 1024;

function readAsar(asarPath) {
  const buf = fs.readFileSync(asarPath);
  const headerPickleSize = buf.readUInt32LE(4);
  const jsonLen = buf.readUInt32LE(12);
  const header = JSON.parse(buf.subarray(16, 16 + jsonLen).toString('utf8'));
  return { buf, header, payloadBase: 8 + headerPickleSize };
}

function asarNode(header, relPath) {
  let node = header;
  for (const part of relPath.split('/')) {
    if (!node || !node.files || !Object.prototype.hasOwnProperty.call(node.files, part)) return null;
    node = node.files[part];
  }
  return node;
}

function asarReadFile(archive, relPath) {
  const node = asarNode(archive.header, relPath);
  if (!node || node.files || node.unpacked || node.link) return null;
  const start = archive.payloadBase + Number(node.offset);
  return archive.buf.subarray(start, start + Number(node.size));
}

function asarIntegrity(data) {
  const blocks = [];
  for (let i = 0; i < data.length; i += ASAR_BLOCK_SIZE) {
    blocks.push(crypto.createHash('sha256').update(data.subarray(i, i + ASAR_BLOCK_SIZE)).digest('hex'));
  }
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(data).digest('hex'),
    blockSize: ASAR_BLOCK_SIZE,
    blocks
  };
}

/** Rebuild an archive, replacing the bodies listed in `replacements` (relPath -> Buffer). */
function writeAsar(archive, replacements, outPath) {
  const header = JSON.parse(JSON.stringify(archive.header));
  const bodies = [];
  let offset = 0;
  const walk = (node, prefix) => {
    for (const [name, child] of Object.entries(node.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (child.files) {
        walk(child, rel);
        continue;
      }
      if (child.unpacked || child.link) continue;
      let data;
      if (replacements.has(rel)) {
        data = replacements.get(rel);
        child.integrity = asarIntegrity(data);
      } else {
        const start = archive.payloadBase + Number(child.offset);
        data = archive.buf.subarray(start, start + Number(child.size));
      }
      child.size = data.length;
      child.offset = String(offset);
      offset += data.length;
      bodies.push(data);
    }
  };
  walk(header, '');

  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const padded = Math.ceil(json.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(4 + padded, 0);
  headerPickle.writeUInt32LE(json.length, 4);
  json.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  fs.writeFileSync(outPath, Buffer.concat([sizePickle, headerPickle, ...bodies]));

  // Verify what we wrote reads back byte-exact before anyone swaps it in.
  const check = readAsar(outPath);
  for (const [rel, data] of replacements) {
    const got = asarReadFile(check, rel);
    if (!got || !got.equals(data)) throw new Error(`asar verify failed for ${rel}`);
  }
}

/**
 * Put `newPath` in place of `livePath`. A running app may hold the archive open; Windows still allows the
 * rename when the file was opened with delete-sharing, and the running process keeps reading its old copy.
 * Returns false (nothing changed) when the file is locked.
 */
function swapFileInto(newPath, livePath) {
  const oldPath = `${livePath}.pokemon-old`;
  try { if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath); } catch (_e) {}
  try {
    fs.renameSync(livePath, oldPath);
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) return false;
    throw err;
  }
  try {
    fs.renameSync(newPath, livePath);
  } catch (err) {
    fs.renameSync(oldPath, livePath); // put the original back
    throw err;
  }
  try { fs.unlinkSync(oldPath); } catch (_e) {} // still open by the running app: removed on the next run
  return true;
}

function getStampedSkinAssets(theme) {
  const cssSrcPath = path.join(__dirname, 'antigravity-global-skin.css');
  const jsSrcPath = path.join(__dirname, 'antigravity-global-skin.js');
  if (!fs.existsSync(cssSrcPath) || !fs.existsSync(jsSrcPath)) {
    throw new Error(`Missing skin source files in ${__dirname}`);
  }
  const css = fs.readFileSync(cssSrcPath, 'utf8');
  const rawJs = fs.readFileSync(jsSrcPath, 'utf8');
  const stampedJs = rawJs.replace(
    /var DEFAULT_THEME = '[a-z-]+';/,
    `var DEFAULT_THEME = '${theme}';`
  );
  return { css, js: stampedJs };
}

function resolveSuiteRoot() {
  const markerPath = path.resolve(__dirname, '..', 'source-root.json');
  if (fs.existsSync(markerPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (parsed && parsed.suiteRoot && fs.existsSync(parsed.suiteRoot)) {
        return parsed.suiteRoot;
      }
    } catch (_e) {}
  }
  return path.resolve(__dirname, '..', '..');
}

function buildAppAMainHookSnippet(suiteRoot, bridgeScriptPath, overlayLauncherPath, silentVbsPath, anchor) {
  return [
    '    /* POKEMON_GLOBAL_SKIN_START */',
    "    if (process.env.ELECTRON_RUN_AS_NODE !== '1') {",
    '        try {',
    "            const _pkmnFs = require('fs');",
    "            const _pkmnPath = require('path');",
    "            const _pkmnOs = require('os');",
    "            const _pkmnHttp = require('http');",
    "            const _pkmnCp = require('child_process');",
    `            const _pkmnSuiteRoot = ${JSON.stringify(suiteRoot)};`,
    `            const _pkmnBridgeScript = ${JSON.stringify(bridgeScriptPath)};`,
    `            const _pkmnOverlayScript = ${JSON.stringify(overlayLauncherPath)};`,
    `            const _pkmnSilentVbs = ${JSON.stringify(silentVbsPath)};`,
            "            const _pkmnWscriptExe = _pkmnPath.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'wscript.exe');",
    "            const _pkmnPsExe = _pkmnPath.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');",
    "            const _pkmnStateFile = _pkmnPath.join(_pkmnOs.tmpdir(), 'antigravity-pokemon-desktop-overlay-state.json');",
    "            const _pkmnMuteFile = _pkmnPath.join(_pkmnOs.tmpdir(), 'antigravity-pokemon-desktop-overlay-muted.json');",
    "            const _pkmnDir = _pkmnPath.join(process.resourcesPath || _pkmnPath.join(__dirname, '..', '..'), 'pokemon-skin');",
    '            const _resolveRealNodeExe = () => {',
    '                try {',
    "                    const nvmdDir = _pkmnPath.join(_pkmnOs.homedir(), '.nvmd');",
    "                    const defFile = _pkmnPath.join(nvmdDir, 'default');",
    '                    if (_pkmnFs.existsSync(defFile)) {',
    "                        const ver = _pkmnFs.readFileSync(defFile, 'utf8').trim();",
    '                        if (ver) {',
    "                            const cand = _pkmnPath.join(nvmdDir, 'versions', ver, 'node.exe');",
    '                            if (_pkmnFs.existsSync(cand)) return cand;',
    '                        }',
    '                    }',
    "                    const versDir = _pkmnPath.join(nvmdDir, 'versions');",
    '                    if (_pkmnFs.existsSync(versDir)) {',
    '                        const dirs = _pkmnFs.readdirSync(versDir).sort().reverse();',
    '                        for (const d of dirs) {',
    "                            const cand = _pkmnPath.join(versDir, d, 'node.exe');",
    '                            if (_pkmnFs.existsSync(cand)) return cand;',
    '                        }',
    '                    }',
    "                    const pfNode = 'C:\\\\Program Files\\\\nodejs\\\\node.exe';",
    '                    if (_pkmnFs.existsSync(pfNode)) return pfNode;',
    '                } catch (_en) {}',
    "                return '';",
    '            };',
    '            const _runPkmnSilentVbs = (targetArgs) => {',
    '                try {',
    "                    if (process.platform !== 'win32') return false;",
    '                    if (!_pkmnFs.existsSync(_pkmnSilentVbs)) return false;',
    '                    const exe = _pkmnFs.existsSync(_pkmnWscriptExe) ? _pkmnWscriptExe : "wscript.exe";',
    "                    _pkmnCp.execFile(exe, ['//B', '//Nologo', _pkmnSilentVbs, ...targetArgs], {",
    '                        cwd: _pkmnSuiteRoot,',
    '                        windowsHide: true,',
    '                        timeout: 8000',
    '                    }, () => {});',
    '                    return true;',
    '                } catch (_evbs) { return false; }',
    '            };',
    '            const _isPkmnPidAlive = (pid) => {',
    '                const n = Number(pid);',
    '                if (!Number.isInteger(n) || n <= 4) return false;',
    '                try { process.kill(n, 0); return true; } catch (e) { return Boolean(e && e.code === "EPERM"); }',
    '            };',
    '            const _getPkmnOverlayState = () => {',
    '                try {',
    '                    if (!_pkmnFs.existsSync(_pkmnStateFile)) return null;',
    "                    const st = JSON.parse(_pkmnFs.readFileSync(_pkmnStateFile, 'utf8').replace(/^\\uFEFF/, ''));",
    '                    if (!st || !st.pid) return null;',
    "                    if (st.desktop && String(st.desktop).toLowerCase() !== 'default') return null;",
    '                    if (!_isPkmnPidAlive(st.pid)) return null;',
    '                    const mtimeMs = _pkmnFs.statSync(_pkmnStateFile).mtimeMs || 0;',
    '                    return { ...st, mtimeMs };',
    '                } catch (_e) { return null; }',
    '            };',
    '            const _handleSummonWatermark = (rawSummon, isInitial) => {',
    '                const ts = typeof rawSummon === "number" ? rawSummon : (rawSummon ? (Date.parse(String(rawSummon)) || 0) : 0);',
    '                if (!global.__pkmnSummonInit) {',
    '                    global.__pkmnSummonInit = true;',
    '                    global.__pkmnLastSummonTs = ts;',
    '                    if (ts > 0 && (Date.now() - ts) < 6000) _ensurePkmnOverlay(true);',
    '                    return;',
    '                }',
    '                if (ts > (global.__pkmnLastSummonTs || 0) || (!isInitial && ts === 0 && rawSummon)) {',
    '                    global.__pkmnLastSummonTs = Math.max(ts, Date.now());',
    '                    _ensurePkmnOverlay(true);',
    '                }',
    '            };',
    '            const _ensurePkmnBridge = () => {',
    '                try {',
    '                    const now = Date.now();',
    '                    if (global.__pkmnBridgeLastCheck && now - global.__pkmnBridgeLastCheck < 10000) return;',
    '                    global.__pkmnBridgeLastCheck = now;',
    '                    if (!_pkmnFs.existsSync(_pkmnBridgeScript)) return;',
    "                    const req = _pkmnHttp.get('http://127.0.0.1:17580/health?client=agy-app&pid=' + process.pid, { timeout: 900 }, (res) => {",
    '                        const chunks = [];',
    "                        res.on('data', (c) => chunks.push(c));",
    "                        res.on('end', () => {",
    '                            try {',
    "                                const h = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    '                                if (h && h.summonRequestedAt !== undefined) _handleSummonWatermark(h.summonRequestedAt, true);',
    '                            } catch (_eh) {}',
    '                        });',
    '                    });',
    "                    req.on('socket', (s) => s.unref?.());",
    '                    const spawnBridge = () => {',
    '                        if (global.__pkmnBridgeSpawning) return;',
    '                        global.__pkmnBridgeSpawning = true;',
    '                        setTimeout(() => { global.__pkmnBridgeSpawning = false; }, 12000).unref?.();',
    '                        const realNode = _resolveRealNodeExe();',
    '                        if (realNode) _runPkmnSilentVbs([realNode, _pkmnBridgeScript]);',
    '                    };',
    "                    req.on('error', spawnBridge);",
    "                    req.on('timeout', () => { try { req.destroy(); } catch (_e) {} spawnBridge(); });",
    '                } catch (_eb) {}',
    '            };',
    '            const _ensurePkmnOverlay = (forceSummon = false) => {',
    '                try {',
    "                    if (process.platform !== 'win32') return;",
    '                    if (!_pkmnFs.existsSync(_pkmnOverlayScript)) return;',
    "                    const psBin = _pkmnFs.existsSync(_pkmnPsExe) ? _pkmnPsExe : 'powershell.exe';",
    "                    const basePsArgs = [psBin, '-STA', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', _pkmnOverlayScript, '-BindToIde'];",
    '                    const now = Date.now();',
    '                    if (!forceSummon) {',
    '                        if (global.__pkmnOverlayAutoStarted) return;',
    '                        if (global.__pkmnOverlayLastAutoAt && now - global.__pkmnOverlayLastAutoAt < 180000) return;',
    '                        global.__pkmnOverlayAutoStarted = true;',
    '                        global.__pkmnOverlayLastAutoAt = now;',
    "                        try { const _pkmnCfg = JSON.parse(_pkmnFs.readFileSync(_pkmnPath.join(_pkmnOs.homedir(), '.gemini', 'config', 'plugins', 'pokemon-agent-pets', 'workspace-config.json'), 'utf8').replace(/^\\uFEFF/, '')); if (_pkmnCfg && _pkmnCfg.autoShowDesktopPet === false) return; } catch (_ecfg) {}",
    '                        if (_pkmnFs.existsSync(_pkmnMuteFile)) return;',
    '                        if (_getPkmnOverlayState()) return;',
    "                        _runPkmnSilentVbs([...basePsArgs, '-FromWatchdog']);",
    '                        return;',
    '                    }',
    '                    if (global.__pkmnOverlayLastForceAt && now - global.__pkmnOverlayLastForceAt < 2500) return;',
    '                    global.__pkmnOverlayLastForceAt = now;',
    '                    try { if (_pkmnFs.existsSync(_pkmnMuteFile)) _pkmnFs.unlinkSync(_pkmnMuteFile); } catch (_em) {}',
    '                    const curSt = _getPkmnOverlayState();',
    '                    if (curSt && curSt.mtimeMs && (now - curSt.mtimeMs) < 4500) return;',
    '                    const args = [...basePsArgs];',
    "                    if (curSt) args.push('-ForceRestart');",
    '                    _runPkmnSilentVbs(args);',
    '                } catch (_eo) {}',
    '            };',
    '            const _bringHubWinToFront = (w, wc) => {',
    '                try {',
    '                    if (!w || w.isDestroyed?.()) return;',
    '                    if (w.isMinimized?.()) w.restore?.();',
    '                    w.show?.();',
    '                    w.moveTop?.();',
    '                    w.focus?.();',
    '                    if (wc && !wc.isDestroyed?.()) wc.focus?.();',
    '                } catch (_ef) {}',
    '            };',
    '            const _handleMainFocusSession = async (cmd) => {',
    '                try {',
    '                    if (!cmd || typeof cmd !== "object") return;',
    '                    if (cmd.host && cmd.host !== "app") return;',
    '                    if (cmd.matchedUiWindow && cmd.pid && Number(cmd.pid) !== process.pid) return;',
    '                    const wins = getHubWindows();',
    '                    if (!wins || wins.length === 0) return;',
    '                    if (cmd.windowId) {',
    '                        for (const w of wins) {',
    '                            const wc = getHubWebContents(w);',
    '                            if (!wc || wc.isDestroyed?.()) continue;',
    '                            const wid = await wc.executeJavaScript("typeof window.__POKEMON_GET_WINDOW_ID__===\\"function\\"?window.__POKEMON_GET_WINDOW_ID__():\\"\\"", true).catch(() => "");',
    '                            if (wid && wid === cmd.windowId) {',
    '                                _bringHubWinToFront(w, wc);',
    '                                await wc.executeJavaScript("if (window.__POKEMON_HANDLE_FOCUS_SESSION__) window.__POKEMON_HANDLE_FOCUS_SESSION__(" + JSON.stringify(cmd) + ", { force: true });", true).catch(() => {});',
    '                                return;',
    '                            }',
    '                        }',
    '                        if (cmd.matchedUiWindow) return;',
    '                    }',
    '                    let bestW = null;',
    '                    let bestWc = null;',
    '                    let bestScore = 0;',
    '                    const cands = Array.isArray(cmd.candidateWindowTitles) ? cmd.candidateWindowTitles : [];',
    '                    for (const w of wins) {',
    '                        const wc = getHubWebContents(w);',
    '                        const title = String((wc && !wc.isDestroyed?.() && wc.getTitle?.()) || w.getTitle?.() || "").toLowerCase();',
    '                        let sc = 0;',
    '                        if (cmd.pid && Number(cmd.pid) === process.pid) sc += 100;',
    '                        if (cmd.windowTitle && title && title === String(cmd.windowTitle).toLowerCase()) sc += 90;',
    '                        for (const ct of cands) {',
    '                            const q = String(ct || "").trim().toLowerCase();',
    '                            if (q && title.includes(q)) { sc += 65; break; }',
    '                        }',
    '                        if (cmd.projectName && cmd.projectName !== "全局会话" && title.includes(String(cmd.projectName).toLowerCase())) sc += 50;',
    '                        if (cmd.appKind === "hub") sc += 25;',
    '                        else if (!cmd.appKind && (!cmd.projectName || cmd.projectName === "全局会话")) sc += 15;',
    '                        if (cmd.host === "app") sc += 1;',
    '                        if (sc > bestScore) { bestScore = sc; bestW = w; bestWc = wc; }',
    '                    }',
    '                    if (!bestW && wins.length > 0 && cmd.host !== "ide") {',
    '                        bestW = wins[0];',
    '                        bestWc = getHubWebContents(bestW);',
    '                    }',
    '                    if (bestW && (bestScore > 0 || cmd.host !== "ide")) {',
    '                        _bringHubWinToFront(bestW, bestWc);',
    '                        if (bestWc && !bestWc.isDestroyed?.()) {',
    '                            await bestWc.executeJavaScript("if (window.__POKEMON_HANDLE_FOCUS_SESSION__) window.__POKEMON_HANDLE_FOCUS_SESSION__(" + JSON.stringify(cmd) + ", { force: true });", true).catch(() => {});',
    '                        }',
    '                    }',
    '                } catch (_eh) {}',
    '            };',
    '            const _connectPkmnFocusStream = () => {',
    '                if (global.__pkmnFocusSseActive || global.__pkmnQuitting) return;',
    '                global.__pkmnFocusSseActive = true;',
    '                const scheduleReconnect = () => {',
    '                    global.__pkmnFocusSseActive = false;',
    '                    if (global.__pkmnQuitting || global.__pkmnFocusRetryTimer) return;',
    '                    global.__pkmnFocusRetryTimer = setTimeout(() => {',
    '                        global.__pkmnFocusRetryTimer = null;',
    '                        _connectPkmnFocusStream();',
    '                    }, 4000);',
    '                    global.__pkmnFocusRetryTimer.unref?.();',
    '                };',
    '                try {',
    "                    const req = _pkmnHttp.get('http://127.0.0.1:17580/api/events', (res) => {",
    '                        if (res.statusCode !== 200) { res.resume(); scheduleReconnect(); return; }',
    "                        res.setEncoding('utf8');",
    '                        res.socket?.unref?.();',
    "                        let buf = '';",
    "                        res.on('data', (chunk) => {",
    '                            buf += chunk;',
    '                            if (buf.length > 262144) buf = buf.slice(-65536);',
    '                            let idx;',
    "                            while ((idx = buf.indexOf('\\n\\n')) !== -1) {",
    '                                const block = buf.slice(0, idx);',
    '                                buf = buf.slice(idx + 2);',
    "                                if (block.indexOf('event: focus-session') !== -1) {",
    "                                    const lines = block.split(/\\r?\\n/);",
    '                                    for (const ln of lines) {',
    "                                        if (ln.startsWith('data:')) {",
    '                                            try { void _handleMainFocusSession(JSON.parse(ln.slice(5).trim())); } catch (_ep) {}',
    '                                        }',
    '                                    }',
    "                                } else if (block.indexOf('event: summon-overlay') !== -1) {",
    "                                    const lines = block.split(/\\r?\\n/);",
    '                                    for (const ln of lines) {',
    "                                        if (ln.startsWith('data:')) {",
    '                                            try {',
    '                                                const evObj = JSON.parse(ln.slice(5).trim());',
    '                                                _handleSummonWatermark(evObj?.summonRequestedAt || evObj?.requestedAt || Date.now(), false);',
    '                                            } catch (_es) { _ensurePkmnOverlay(true); }',
    '                                        }',
    '                                    }',
    "                                } else if (block.indexOf('event: snapshot') !== -1 && block.indexOf('summonRequestedAt') !== -1) {",
    "                                    const lines = block.split(/\\r?\\n/);",
    '                                    for (const ln of lines) {',
    "                                        if (ln.startsWith('data:')) {",
    '                                            try {',
    '                                                const snap = JSON.parse(ln.slice(5).trim());',
    '                                                if (snap && snap.summonRequestedAt !== undefined) _handleSummonWatermark(snap.summonRequestedAt, true);',
    '                                            } catch (_esn) {}',
    '                                        }',
    '                                    }',
    '                                }',
    '                            }',
    '                        });',
    "                        res.on('end', scheduleReconnect);",
    "                        res.on('error', scheduleReconnect);",
    '                    });',
    "                    req.on('socket', (s) => s.unref?.());",
    "                    req.on('error', scheduleReconnect);",
    '                    if (!global.__pkmnQuitHooked) {',
    '                        global.__pkmnQuitHooked = true;',
    "                        electron_1.app.once?.('will-quit', () => {",
    '                            global.__pkmnQuitting = true;',
    '                            try { req.destroy(); } catch (_eq) {}',
    '                        });',
    '                    }',
    '                } catch (_ec) { scheduleReconnect(); }',
    '            };',
    '            // Tell the bridge this Hub page origin (https://127.0.0.1:<LS port>, new port every launch) so the',
    '            // injected skin may call it. Sent from the main process, i.e. as a native client without Origin.',
    '            const _registerPkmnHubOrigin = () => new Promise((resolve) => {',
    '                try {',
    '                    if (hubContents.isDestroyed?.()) return resolve(false);',
    "                    const o = new URL(hubContents.getURL()).origin;",
    "                    if (!o.startsWith('https://127.0.0.1:')) return resolve(false);",
    "                    const req = _pkmnHttp.get('http://127.0.0.1:17580/health?client=agy-app&pid=' + process.pid + '&hubOrigin=' + encodeURIComponent(o), { timeout: 1500 }, (res) => { res.resume(); res.on('end', () => resolve(true)); });",
    "                    req.on('socket', (s) => s.unref?.());",
    "                    req.on('error', () => resolve(false));",
    "                    req.on('timeout', () => { try { req.destroy(); } catch (_e) {} resolve(false); });",
    '                } catch (_e) { resolve(false); }',
    '            });',
    '            const _pkmnHubOriginTimer = setInterval(() => { void _registerPkmnHubOrigin(); }, 15000);',
    '            _pkmnHubOriginTimer.unref?.();',
    '            _ensurePkmnBridge();',
    '            _ensurePkmnOverlay(false);',
    '            _connectPkmnFocusStream();',
    '            let _pkmnCssKey = null;',
    '            const _injectPokemonSkin = async () => {',
    '                try {',
    '                    await _registerPkmnHubOrigin();',
    '                    _ensurePkmnBridge();',
    '                    _ensurePkmnOverlay(false);',
    '                    _connectPkmnFocusStream();',
    '                    if (win.isDestroyed?.() || hubContents.isDestroyed?.()) return;',
    '                    await hubContents.executeJavaScript("window.__POKEMON_HOST_PID__=" + process.pid + ";if(window.__POKEMON_SET_HOST_PID__)window.__POKEMON_SET_HOST_PID__(" + process.pid + ");", true).catch(() => {});',
    "                    const cssPath = _pkmnPath.join(_pkmnDir, 'antigravity-global-skin.css');",
    "                    const jsPath = _pkmnPath.join(_pkmnDir, 'antigravity-global-skin.js');",
    '                    if (_pkmnFs.existsSync(cssPath)) {',
    "                        const css = _pkmnFs.readFileSync(cssPath, 'utf8');",
    '                        if (_pkmnCssKey) {',
    '                            await hubContents.removeInsertedCSS(_pkmnCssKey).catch(() => {});',
    '                        }',
    "                        _pkmnCssKey = await hubContents.insertCSS(css, { cssOrigin: 'user' }).catch(() => null);",
    '                    }',
    '                    if (_pkmnFs.existsSync(jsPath)) {',
    "                        const js = _pkmnFs.readFileSync(jsPath, 'utf8');",
    '                        await hubContents.executeJavaScript(js, true).catch(() => {});',
    '                    }',
    '                } catch (_e) {}',
    '            };',
    "            hubContents.on('dom-ready', _injectPokemonSkin);",
    "            win.on('closed', () => {",
    "                hubContents.off?.('dom-ready', _injectPokemonSkin);",
    '                clearInterval(_pkmnHubOriginTimer);',
    '            });',
    '        } catch (_pkmnErr) {}',
    '    }',
    '    /* POKEMON_GLOBAL_SKIN_END */',
    anchor
  ].join('\n');
}

function buildAppBMainEsmSnippet(suiteRoot, bridgeScriptPath, overlayLauncherPath, silentVbsPath) {
  return [
    '',
    '/* POKEMON_APPB_MAIN_START */',
    ';(async () => {',
    '  try {',
    "    if (process.env.ELECTRON_RUN_AS_NODE === '1') return;",
    "    const electronMod = await import('electron');",
    '    const electron = electronMod.default || electronMod;',
    '    if (!electron || !electron.app) return;',
    "    const _pkmnFs = await import('node:fs');",
    "    const _pkmnPath = await import('node:path');",
    "    const _pkmnOs = await import('node:os');",
    "    const _pkmnHttp = await import('node:http');",
    "    const _pkmnCp = await import('node:child_process');",
    `    const _pkmnSuiteRoot = ${JSON.stringify(suiteRoot)};`,
    `    const _pkmnBridgeScript = ${JSON.stringify(bridgeScriptPath)};`,
    `    const _pkmnOverlayScript = ${JSON.stringify(overlayLauncherPath)};`,
    `    const _pkmnSilentVbs = ${JSON.stringify(silentVbsPath)};`,
    "    const _pkmnWscriptExe = _pkmnPath.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'wscript.exe');",
    "    const _pkmnPsExe = _pkmnPath.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');",
    "    const _pkmnStateFile = _pkmnPath.join(_pkmnOs.tmpdir(), 'antigravity-pokemon-desktop-overlay-state.json');",
    "    const _pkmnMuteFile = _pkmnPath.join(_pkmnOs.tmpdir(), 'antigravity-pokemon-desktop-overlay-muted.json');",
    '    const _resolveRealNodeExe = () => {',
    '      try {',
    "        const nvmdDir = _pkmnPath.join(_pkmnOs.homedir(), '.nvmd');",
    "        const defFile = _pkmnPath.join(nvmdDir, 'default');",
    '        if (_pkmnFs.existsSync(defFile)) {',
    "          const ver = _pkmnFs.readFileSync(defFile, 'utf8').trim();",
    '          if (ver) {',
    "            const cand = _pkmnPath.join(nvmdDir, 'versions', ver, 'node.exe');",
    '            if (_pkmnFs.existsSync(cand)) return cand;',
    '          }',
    '        }',
    "        const versDir = _pkmnPath.join(nvmdDir, 'versions');",
    '        if (_pkmnFs.existsSync(versDir)) {',
    '          const dirs = _pkmnFs.readdirSync(versDir).sort().reverse();',
    '          for (const d of dirs) {',
    "            const cand = _pkmnPath.join(versDir, d, 'node.exe');",
    '            if (_pkmnFs.existsSync(cand)) return cand;',
    '          }',
    '        }',
    "        const pfNode = 'C:\\\\Program Files\\\\nodejs\\\\node.exe';",
    '        if (_pkmnFs.existsSync(pfNode)) return pfNode;',
    '      } catch (_en) {}',
    "      return '';",
    '    };',
    '    const _runPkmnSilentVbs = (targetArgs) => {',
    '      try {',
    "        if (process.platform !== 'win32') return false;",
    '        if (!_pkmnFs.existsSync(_pkmnSilentVbs)) return false;',
    '        const exe = _pkmnFs.existsSync(_pkmnWscriptExe) ? _pkmnWscriptExe : "wscript.exe";',
    "        _pkmnCp.execFile(exe, ['//B', '//Nologo', _pkmnSilentVbs, ...targetArgs], {",
    '          cwd: _pkmnSuiteRoot,',
    '          windowsHide: true,',
    '          timeout: 8000',
    '        }, () => {});',
    '        return true;',
    '      } catch (_evbs) { return false; }',
    '    };',
    '    const _isPkmnPidAlive = (pid) => {',
    '      const n = Number(pid);',
    '      if (!Number.isInteger(n) || n <= 4) return false;',
    '      try { process.kill(n, 0); return true; } catch (e) { return Boolean(e && e.code === "EPERM"); }',
    '    };',
    '    const _getPkmnOverlayState = () => {',
    '      try {',
    '        if (!_pkmnFs.existsSync(_pkmnStateFile)) return null;',
    "        const st = JSON.parse(_pkmnFs.readFileSync(_pkmnStateFile, 'utf8').replace(/^\\uFEFF/, ''));",
    '        if (!st || !st.pid) return null;',
    "        if (st.desktop && String(st.desktop).toLowerCase() !== 'default') return null;",
    '        if (!_isPkmnPidAlive(st.pid)) return null;',
    '        const mtimeMs = _pkmnFs.statSync(_pkmnStateFile).mtimeMs || 0;',
    '        return { ...st, mtimeMs };',
    '      } catch (_e) { return null; }',
    '    };',
    '    const _handleSummonWatermark = (rawSummon, isInitial) => {',
    '      const ts = typeof rawSummon === "number" ? rawSummon : (rawSummon ? (Date.parse(String(rawSummon)) || 0) : 0);',
    '      if (!globalThis.__pkmnAppBSummonInit) {',
    '        globalThis.__pkmnAppBSummonInit = true;',
    '        globalThis.__pkmnAppBLastSummonTs = ts;',
    '        if (ts > 0 && (Date.now() - ts) < 6000) _ensurePkmnOverlay(true);',
    '        return;',
    '      }',
    '      if (ts > (globalThis.__pkmnAppBLastSummonTs || 0) || (!isInitial && ts === 0 && rawSummon)) {',
    '        globalThis.__pkmnAppBLastSummonTs = Math.max(ts, Date.now());',
    '        _ensurePkmnOverlay(true);',
    '      }',
    '    };',
    '    const _ensurePkmnBridge = () => {',
    '      try {',
    '        const now = Date.now();',
    '        if (globalThis.__pkmnBridgeLastCheck && now - globalThis.__pkmnBridgeLastCheck < 10000) return;',
    '        globalThis.__pkmnBridgeLastCheck = now;',
    '        if (!_pkmnFs.existsSync(_pkmnBridgeScript)) return;',
    "        const req = _pkmnHttp.get('http://127.0.0.1:17580/health', { timeout: 900 }, (res) => {",
    '          const chunks = [];',
    "          res.on('data', (c) => chunks.push(c));",
    "          res.on('end', () => {",
    '            try {',
    "              const h = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    '              if (h && h.summonRequestedAt !== undefined) _handleSummonWatermark(h.summonRequestedAt, true);',
    '            } catch (_eh) {}',
    '          });',
    '        });',
    "        req.on('socket', (s) => s.unref?.());",
    '        const spawnBridge = () => {',
    '          if (globalThis.__pkmnBridgeSpawning) return;',
    '          globalThis.__pkmnBridgeSpawning = true;',
    '          setTimeout(() => { globalThis.__pkmnBridgeSpawning = false; }, 12000).unref?.();',
    '          const realNode = _resolveRealNodeExe();',
    '          if (realNode) _runPkmnSilentVbs([realNode, _pkmnBridgeScript]);',
    '        };',
    "        req.on('error', spawnBridge);",
    "        req.on('timeout', () => { try { req.destroy(); } catch (_e) {} spawnBridge(); });",
    '      } catch (_eb) {}',
    '    };',
    '    const _ensurePkmnOverlay = (forceSummon = false) => {',
    '      try {',
    "        if (process.platform !== 'win32') return;",
    '        if (!_pkmnFs.existsSync(_pkmnOverlayScript)) return;',
    "        const psBin = _pkmnFs.existsSync(_pkmnPsExe) ? _pkmnPsExe : 'powershell.exe';",
    "        const basePsArgs = [psBin, '-STA', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', _pkmnOverlayScript, '-BindToIde'];",
    '        const now = Date.now();',
    '        if (!forceSummon) {',
    '          if (globalThis.__pkmnOverlayAutoStarted) return;',
    '          if (globalThis.__pkmnOverlayLastAutoAt && now - globalThis.__pkmnOverlayLastAutoAt < 180000) return;',
    '          globalThis.__pkmnOverlayAutoStarted = true;',
    '          globalThis.__pkmnOverlayLastAutoAt = now;',
    '          if (_pkmnFs.existsSync(_pkmnMuteFile)) return;',
    '          if (_getPkmnOverlayState()) return;',
    "          _runPkmnSilentVbs([...basePsArgs, '-FromWatchdog']);",
    '          return;',
    '        }',
    '        if (globalThis.__pkmnOverlayLastForceAt && now - globalThis.__pkmnOverlayLastForceAt < 2500) return;',
    '        globalThis.__pkmnOverlayLastForceAt = now;',
    '        try { if (_pkmnFs.existsSync(_pkmnMuteFile)) _pkmnFs.unlinkSync(_pkmnMuteFile); } catch (_em) {}',
    '        const curSt = _getPkmnOverlayState();',
    '        if (curSt && curSt.mtimeMs && (now - curSt.mtimeMs) < 4500) return;',
    '        const args = [...basePsArgs];',
    "        if (curSt) args.push('-ForceRestart');",
    '        _runPkmnSilentVbs(args);',
    '      } catch (_eo) {}',
    '    };',
    '    const _bringBrowserWinToFront = (w) => {',
    '      try {',
    '        if (!w || w.isDestroyed?.()) return;',
    '        if (w.isMinimized?.()) w.restore?.();',
    '        w.show?.();',
    '        w.moveTop?.();',
    '        w.focus?.();',
    '        w.webContents?.focus?.();',
    '      } catch (_ef) {}',
    '    };',
    '    const _handleAppBFocusSession = async (cmd) => {',
    '      try {',
    '        if (!cmd || typeof cmd !== "object") return;',
    '        if (cmd.host === "app") return;',
    '        if (cmd.matchedUiWindow && cmd.pid && Number(cmd.pid) !== process.pid) return;',
    '        const wins = (electron.BrowserWindow?.getAllWindows?.() || []).filter((w) => w && !w.isDestroyed?.());',
    '        if (wins.length === 0) return;',
    '        if (cmd.windowId) {',
    '          for (const w of wins) {',
    '            const wc = w.webContents;',
    '            if (!wc || wc.isDestroyed?.()) continue;',
    '            const wid = await wc.executeJavaScript("typeof window.__POKEMON_GET_WINDOW_ID__===\\"function\\"?window.__POKEMON_GET_WINDOW_ID__():\\"\\"", true).catch(() => "");',
    '            if (wid && wid === cmd.windowId) {',
    '              _bringBrowserWinToFront(w);',
    '              await wc.executeJavaScript("if (window.__POKEMON_HANDLE_FOCUS_SESSION__) window.__POKEMON_HANDLE_FOCUS_SESSION__(" + JSON.stringify(cmd) + ", { force: true });", true).catch(() => {});',
    '              return;',
    '            }',
    '          }',
    '          if (cmd.matchedUiWindow) return;',
    '        }',
    '        let bestW = null;',
    '        let bestScore = 0;',
    '        const cands = Array.isArray(cmd.candidateWindowTitles) ? cmd.candidateWindowTitles : [];',
    '        for (const w of wins) {',
    '          const wc = w.webContents;',
    '          const title = String(w.getTitle?.() || wc?.getTitle?.() || "").toLowerCase();',
    '          const url = String(wc?.getURL?.() || "").toLowerCase();',
    '          let sc = 0;',
    '          if (cmd.pid && Number(cmd.pid) === process.pid) sc += 100;',
    '          if (cmd.windowTitle && title && title === String(cmd.windowTitle).toLowerCase()) sc += 90;',
    '          for (const ct of cands) {',
    '            const q = String(ct || "").trim().toLowerCase();',
    '            if (q && title.includes(q)) { sc += 65; break; }',
    '          }',
    '          if (cmd.projectName && cmd.projectName !== "全局会话" && title.includes(String(cmd.projectName).toLowerCase())) sc += 55;',
    '          if (cmd.appKind === "jetski" && url.includes("jetski")) sc += 30;',
    '          else if (cmd.appKind === "workbench" && url.includes("workbench.html")) sc += 30;',
    '          if (sc > bestScore) { bestScore = sc; bestW = w; }',
    '        }',
    '        if (bestW && bestScore > 0) {',
    '          _bringBrowserWinToFront(bestW);',
    '          if (bestW.webContents && !bestW.webContents.isDestroyed?.()) {',
    '            await bestW.webContents.executeJavaScript("if (window.__POKEMON_HANDLE_FOCUS_SESSION__) window.__POKEMON_HANDLE_FOCUS_SESSION__(" + JSON.stringify(cmd) + ", { force: true });", true).catch(() => {});',
    '          }',
    '        }',
    '      } catch (_eh) {}',
    '    };',
    '    let _activeSseReq = null;',
    '    const _connectPkmnFocusStream = () => {',
    '      if (globalThis.__pkmnAppBFocusSseActive || globalThis.__pkmnAppBQuitting) return;',
    '      globalThis.__pkmnAppBFocusSseActive = true;',
    '      const scheduleReconnect = () => {',
    '        globalThis.__pkmnAppBFocusSseActive = false;',
    '        if (globalThis.__pkmnAppBQuitting || globalThis.__pkmnAppBFocusRetry) return;',
    '        globalThis.__pkmnAppBFocusRetry = setTimeout(() => {',
    '          globalThis.__pkmnAppBFocusRetry = null;',
    '          _connectPkmnFocusStream();',
    '        }, 4000);',
    '        globalThis.__pkmnAppBFocusRetry.unref?.();',
    '      };',
    '      try {',
    "        const req = _pkmnHttp.get('http://127.0.0.1:17580/api/events', (res) => {",
    '          if (res.statusCode !== 200) { res.resume(); scheduleReconnect(); return; }',
    "          res.setEncoding('utf8');",
    '          res.socket?.unref?.();',
    "          let buf = '';",
    "          res.on('data', (chunk) => {",
    '            buf += chunk;',
    '            if (buf.length > 262144) buf = buf.slice(-65536);',
    '            let idx;',
    "            while ((idx = buf.indexOf('\\n\\n')) !== -1) {",
    '              const block = buf.slice(0, idx);',
    '              buf = buf.slice(idx + 2);',
    "              if (block.indexOf('event: focus-session') !== -1) {",
    "                const lines = block.split(/\\r?\\n/);",
    '                for (const ln of lines) {',
    "                  if (ln.startsWith('data:')) {",
    '                    try { void _handleAppBFocusSession(JSON.parse(ln.slice(5).trim())); } catch (_ep) {}',
    '                  }',
    '                }',
    "              } else if (block.indexOf('event: summon-overlay') !== -1) {",
    "                const lines = block.split(/\\r?\\n/);",
    '                for (const ln of lines) {',
    "                  if (ln.startsWith('data:')) {",
    '                    try {',
    '                      const evObj = JSON.parse(ln.slice(5).trim());',
    '                      _handleSummonWatermark(evObj?.summonRequestedAt || evObj?.requestedAt || Date.now(), false);',
    '                    } catch (_es) { _ensurePkmnOverlay(true); }',
    '                  }',
    '                }',
    "              } else if (block.indexOf('event: snapshot') !== -1 && block.indexOf('summonRequestedAt') !== -1) {",
    "                const lines = block.split(/\\r?\\n/);",
    '                for (const ln of lines) {',
    "                  if (ln.startsWith('data:')) {",
    '                    try {',
    '                      const snap = JSON.parse(ln.slice(5).trim());',
    '                      if (snap && snap.summonRequestedAt !== undefined) _handleSummonWatermark(snap.summonRequestedAt, true);',
    '                    } catch (_esn) {}',
    '                  }',
    '                }',
    '              }',
    '            }',
    '          });',
    "          res.on('end', scheduleReconnect);",
    "          res.on('error', scheduleReconnect);",
    '        });',
    '        _activeSseReq = req;',
    "        req.on('socket', (s) => s.unref?.());",
    "        req.on('error', scheduleReconnect);",
    '      } catch (_ec) { scheduleReconnect(); }',
    '    };',
    '    const _hookBrowserWindow = (bw) => {',
    '      try {',
    '        if (!bw || bw.isDestroyed?.() || !bw.webContents) return;',
    '        const onLoaded = () => {',
    '          _ensurePkmnBridge();',
    '          _ensurePkmnOverlay(false);',
    '          _connectPkmnFocusStream();',
    '          if (!bw.isDestroyed?.() && !bw.webContents.isDestroyed?.()) {',
    '            bw.webContents.executeJavaScript("window.__POKEMON_HOST_PID__=" + process.pid + ";if(window.__POKEMON_SET_HOST_PID__)window.__POKEMON_SET_HOST_PID__(" + process.pid + ");", true).catch(() => {});',
    '          }',
    '        };',
    "        bw.webContents.on('did-finish-load', onLoaded);",
    "        bw.once?.('closed', () => { bw.webContents?.off?.('did-finish-load', onLoaded); });",
    '      } catch (_ebw) {}',
    '    };',
    "    electron.app.on('browser-window-created', (_ev, bw) => _hookBrowserWindow(bw));",
    "    electron.app.once?.('will-quit', () => {",
    '      globalThis.__pkmnAppBQuitting = true;',
    '      try { _activeSseReq?.destroy(); } catch (_eq) {}',
    '    });',
    '    electron.app.whenReady().then(() => {',
    '      _ensurePkmnBridge();',
    '      _ensurePkmnOverlay(false);',
    '      _connectPkmnFocusStream();',
    '      for (const bw of (electron.BrowserWindow?.getAllWindows?.() || [])) _hookBrowserWindow(bw);',
    '    }).catch(() => {});',
    '  } catch (_pkmnMainErr) {}',
    '})().catch(() => {});',
    '/* POKEMON_APPB_MAIN_END */',
    ''
  ].join('\n');
}

function applyAppA(localAppData, theme, assets) {
  const appARoot = path.join(localAppData, 'Programs', 'antigravity');
  const resourcesDir = path.join(appARoot, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  if (!fs.existsSync(asarPath)) {
    return { found: false, path: appARoot };
  }

  const UTILS_REL = 'dist/utils.js';
  const HOOK_MARKER = 'POKEMON_GLOBAL_SKIN_START';
  const backupPath = `${asarPath}.pokemon-backup`;

  // Skin CSS/JS live next to the archive so a theme change never needs a repack.
  const skinDestDir = path.join(resourcesDir, 'pokemon-skin');
  fs.mkdirSync(skinDestDir, { recursive: true });
  fs.writeFileSync(path.join(skinDestDir, 'antigravity-global-skin.css'), assets.css, 'utf8');
  fs.writeFileSync(path.join(skinDestDir, 'antigravity-global-skin.js'), assets.js, 'utf8');

  // Clean base: the live archive when it has no hook (fresh install / app update), else our backup.
  const live = readAsar(asarPath);
  const liveUtils = asarReadFile(live, UTILS_REL);
  if (!liveUtils) throw new Error(`${UTILS_REL} not found inside ${asarPath}`);
  const liveIsPatched = liveUtils.toString('utf8').includes(HOOK_MARKER);
  if (!liveIsPatched) {
    fs.copyFileSync(asarPath, backupPath); // refresh: an app update replaces app.asar with a clean one
  } else if (!fs.existsSync(backupPath)) {
    throw new Error(`${asarPath} is already patched but ${backupPath} is missing; reinstall the app to get a clean copy`);
  }
  const clean = liveIsPatched ? readAsar(backupPath) : live;
  const rawCleanUtils = asarReadFile(clean, UTILS_REL).toString('utf8');
  const cleanUtils = rawCleanUtils.replace(
    /^[ \t]*\/\* POKEMON_GLOBAL_SKIN_START \*\/[\s\S]*?\/\* POKEMON_GLOBAL_SKIN_END \*\/\r?\n?/m,
    ''
  );

  const suiteRoot = resolveSuiteRoot();
  const bridgeScriptPath = path.join(suiteRoot, 'bridge', 'agent-monitor.mjs');
  const overlayLauncherPath = path.join(suiteRoot, 'desktop-pet', 'launch-desktop-pet.ps1');
  const silentVbsPath = path.join(suiteRoot, 'desktop-pet', 'silent-launch.vbs');

  const anchor = '    void win.loadURL(url);';
  if (!cleanUtils.includes(anchor)) {
    throw new Error(`Anchor "${anchor.trim()}" not found in ${UTILS_REL} of ${asarPath}`);
  }
  const injectionSnippet = buildAppAMainHookSnippet(
    suiteRoot,
    bridgeScriptPath,
    overlayLauncherPath,
    silentVbsPath,
    anchor
  );
  const patchedUtils = Buffer.from(cleanUtils.replace(anchor, injectionSnippet), 'utf8');

  // The earlier versions extracted the archive into resources/app, which Electron never loads; drop it.
  const legacyRemoved = removeLegacyAppAFolder(resourcesDir);

  if (liveIsPatched && liveUtils.equals(patchedUtils)) {
    return { found: true, path: appARoot, asar: 'up-to-date', legacyRemoved, theme };
  }

  const stagedPath = `${asarPath}.pokemon-new`;
  writeAsar(clean, new Map([[UTILS_REL, patchedUtils]]), stagedPath);
  if (!swapFileInto(stagedPath, asarPath)) {
    return {
      found: true,
      path: appARoot,
      asar: 'locked',
      stagedPath,
      message: 'Antigravity app is holding app.asar open: quit the app completely, then run the apply again.',
      legacyRemoved,
      theme
    };
  }
  return { found: true, path: appARoot, asar: 'patched', backupPath, legacyRemoved, theme };
}

function removeLegacyAppAFolder(resourcesDir) {
  const appDir = path.join(resourcesDir, 'app');
  const ours =
    fs.existsSync(path.join(appDir, 'dist', 'utils.js.pokemon-backup')) ||
    fs.existsSync(path.join(appDir, 'dist', 'pokemon-skin'));
  if (!ours) return false;
  fs.rmSync(appDir, { recursive: true, force: true });
  return true;
}

function restoreAppA(localAppData) {
  const appARoot = path.join(localAppData, 'Programs', 'antigravity');
  const resourcesDir = path.join(appARoot, 'resources');
  const asarPath = path.join(resourcesDir, 'app.asar');
  const backupPath = `${asarPath}.pokemon-backup`;
  if (!fs.existsSync(asarPath)) {
    return { restored: false, path: appARoot };
  }

  let asar = 'untouched';
  if (fs.existsSync(backupPath)) {
    const live = asarReadFile(readAsar(asarPath), 'dist/utils.js');
    if (live && live.toString('utf8').includes('POKEMON_GLOBAL_SKIN_START')) {
      const stagedPath = `${asarPath}.pokemon-new`;
      fs.copyFileSync(backupPath, stagedPath);
      if (!swapFileInto(stagedPath, asarPath)) {
        return {
          restored: false,
          path: appARoot,
          asar: 'locked',
          message: 'Antigravity app is holding app.asar open: quit the app completely, then run the restore again.'
        };
      }
      asar = 'restored';
    }
    fs.unlinkSync(backupPath);
  }
  for (const leftover of [`${asarPath}.pokemon-new`, `${asarPath}.pokemon-old`]) {
    try { if (fs.existsSync(leftover)) fs.unlinkSync(leftover); } catch (_e) {}
  }
  fs.rmSync(path.join(resourcesDir, 'pokemon-skin'), { recursive: true, force: true });
  const legacyRemoved = removeLegacyAppAFolder(resourcesDir);
  return { restored: asar === 'restored' || legacyRemoved, path: appARoot, asar, legacyRemoved };
}

function injectHtmlDocument(cleanHtml) {
  const linkTag = '\t<!-- Pokemon Global UI Skin -->\n\t<link rel="stylesheet" href="./antigravity-global-skin.css" data-pokemon-skin="1">\n</head>';
  const scriptTag = '<script src="./antigravity-global-skin.js" defer data-pokemon-skin="1"></script>\n</html>';

  let out = cleanHtml;
  // Ensure CSP connect-src explicitly permits http://127.0.0.1:17580 and ws://127.0.0.1:17580
  if (out.includes('connect-src') && !out.includes('http://127.0.0.1:17580')) {
    if (out.includes('http://127.0.0.1:*')) {
      out = out.replace(
        'http://127.0.0.1:*',
        'http://127.0.0.1:*\n\t\t\t\t\thttp://127.0.0.1:17580\n\t\t\t\t\tws://127.0.0.1:17580'
      );
    } else {
      out = out.replace(
        /connect-src\s+/,
        'connect-src http://127.0.0.1:17580 ws://127.0.0.1:17580 '
      );
    }
  }

  if (out.includes('</head>')) {
    out = out.replace('</head>', linkTag);
  } else {
    throw new Error('Missing </head> in workbench HTML');
  }
  if (out.includes('</html>')) {
    out = out.replace('</html>', scriptTag);
  } else {
    out = `${out}\n<script src="./antigravity-global-skin.js" defer data-pokemon-skin="1"></script>\n`;
  }
  return out;
}

function injectAppBMainJs(cleanMainJs, suiteRoot) {
  const bridgeScriptPath = path.join(suiteRoot, 'bridge', 'agent-monitor.mjs');
  const overlayLauncherPath = path.join(suiteRoot, 'desktop-pet', 'launch-desktop-pet.ps1');
  const silentVbsPath = path.join(suiteRoot, 'desktop-pet', 'silent-launch.vbs');
  const esmHook = buildAppBMainEsmSnippet(suiteRoot, bridgeScriptPath, overlayLauncherPath, silentVbsPath);

  const strippedMainJs = cleanMainJs.replace(
    /\r?\n?\/\* POKEMON_APPB_MAIN_START \*\/[\s\S]*?\/\* POKEMON_APPB_MAIN_END \*\/\r?\n?/g,
    ''
  );
  const sourceMapIdx = strippedMainJs.lastIndexOf('//# sourceMappingURL=');
  if (sourceMapIdx !== -1) {
    return `${strippedMainJs.slice(0, sourceMapIdx)}${esmHook}${strippedMainJs.slice(sourceMapIdx)}`;
  }
  return `${strippedMainJs}\n${esmHook}`;
}

function applyAppB(localAppData, theme, assets) {
  const appBRoot = path.join(localAppData, 'Programs', 'Antigravity IDE');
  const appDir = path.join(appBRoot, 'resources', 'app');
  const productPath = path.join(appDir, 'product.json');
  const mainJsPath = path.join(appDir, 'out', 'main.js');
  const workbenchDir = path.join(appDir, 'out', 'vs', 'code', 'electron-browser', 'workbench');

  if (!fs.existsSync(productPath) || !fs.existsSync(workbenchDir)) {
    return { found: false, path: appBRoot };
  }

  const productBackup = `${productPath}.pokemon-backup`;
  if (!fs.existsSync(productBackup)) {
    fs.copyFileSync(productPath, productBackup);
  }

  fs.writeFileSync(path.join(workbenchDir, 'antigravity-global-skin.css'), assets.css, 'utf8');
  fs.writeFileSync(path.join(workbenchDir, 'antigravity-global-skin.js'), assets.js, 'utf8');

  const htmlTargets = [
    {
      file: 'workbench.html',
      checksumKey: 'vs/code/electron-browser/workbench/workbench.html'
    },
    {
      file: 'workbench-jetski-agent.html',
      checksumKey: 'vs/code/electron-browser/workbench/workbench-jetski-agent.html'
    }
  ];

  const productObj = JSON.parse(fs.readFileSync(productBackup, 'utf8'));
  if (!productObj.checksums || typeof productObj.checksums !== 'object') {
    productObj.checksums = {};
  }

  const updatedChecksums = {};
  for (const t of htmlTargets) {
    const htmlPath = path.join(workbenchDir, t.file);
    if (!fs.existsSync(htmlPath)) continue;
    const htmlBackup = `${htmlPath}.pokemon-backup`;
    if (!fs.existsSync(htmlBackup)) {
      fs.copyFileSync(htmlPath, htmlBackup);
    }
    const cleanHtml = fs.readFileSync(htmlBackup, 'utf8');
    const patchedHtml = injectHtmlDocument(cleanHtml);
    fs.writeFileSync(htmlPath, patchedHtml, 'utf8');

    const newHash = sha256Base64NoPad(htmlPath);
    productObj.checksums[t.checksumKey] = newHash;
    updatedChecksums[t.file] = newHash;
  }

  let mainJsPatched = false;
  if (fs.existsSync(mainJsPath)) {
    const mainJsBackup = `${mainJsPath}.pokemon-backup`;
    if (!fs.existsSync(mainJsBackup)) {
      fs.copyFileSync(mainJsPath, mainJsBackup);
    }
    const cleanMain = fs.readFileSync(mainJsBackup, 'utf8');
    const suiteRoot = resolveSuiteRoot();
    const patchedMain = injectAppBMainJs(cleanMain, suiteRoot);
    fs.writeFileSync(mainJsPath, patchedMain, 'utf8');
    mainJsPatched = true;

    for (const candidateKey of ['main.js', 'out/main.js']) {
      if (Object.prototype.hasOwnProperty.call(productObj.checksums, candidateKey)) {
        const mainHash = sha256Base64NoPad(mainJsPath);
        productObj.checksums[candidateKey] = mainHash;
        updatedChecksums[candidateKey] = mainHash;
      }
    }
  }

  fs.writeFileSync(productPath, `${JSON.stringify(productObj, null, '\t')}\n`, 'utf8');
  return { found: true, path: appBRoot, mainJsPatched, updatedChecksums, theme };
}

function restoreAppB(localAppData) {
  const appBRoot = path.join(localAppData, 'Programs', 'Antigravity IDE');
  const appDir = path.join(appBRoot, 'resources', 'app');
  const productPath = path.join(appDir, 'product.json');
  const mainJsPath = path.join(appDir, 'out', 'main.js');
  const workbenchDir = path.join(appDir, 'out', 'vs', 'code', 'electron-browser', 'workbench');

  if (!fs.existsSync(workbenchDir)) {
    return { restored: false, path: appBRoot };
  }

  let didRestore = false;
  for (const name of ['workbench.html', 'workbench-jetski-agent.html']) {
    const htmlPath = path.join(workbenchDir, name);
    const backupPath = `${htmlPath}.pokemon-backup`;
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, htmlPath);
      fs.unlinkSync(backupPath);
      didRestore = true;
    }
  }

  const mainJsBackup = `${mainJsPath}.pokemon-backup`;
  if (fs.existsSync(mainJsBackup)) {
    fs.copyFileSync(mainJsBackup, mainJsPath);
    fs.unlinkSync(mainJsBackup);
    didRestore = true;
  }

  const productBackup = `${productPath}.pokemon-backup`;
  if (fs.existsSync(productBackup)) {
    fs.copyFileSync(productBackup, productPath);
    fs.unlinkSync(productBackup);
    didRestore = true;
  }

  for (const assetName of ['antigravity-global-skin.css', 'antigravity-global-skin.js']) {
    const p = path.join(workbenchDir, assetName);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      didRestore = true;
    }
  }

  return { restored: didRestore, path: appBRoot };
}

function main() {
  const { mode, theme, only } = parseArgs(process.argv);
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  const skipped = { skipped: true };

  if (mode === 'restore') {
    const resA = only === 'app-b' ? skipped : restoreAppA(localAppData);
    const resB = only === 'app-a' ? skipped : restoreAppB(localAppData);
    console.log(JSON.stringify({ ok: true, mode: 'restore', appA: resA, appB: resB }, null, 2));
    return;
  }

  const assets = getStampedSkinAssets(theme);
  const resA = only === 'app-b' ? skipped : applyAppA(localAppData, theme, assets);
  const resB = only === 'app-a' ? skipped : applyAppB(localAppData, theme, assets);
  if (!resA.found && !resB.found && !resA.skipped && !resB.skipped) {
    throw new Error(`Neither Antigravity 2.0 nor Antigravity IDE found under ${localAppData}\\Programs`);
  }
  console.log(JSON.stringify({ ok: true, mode: 'apply', theme, appA: resA, appB: resB }, null, 2));
}

main();
