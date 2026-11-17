#!/usr/bin/env node
/**
 * Portable Plugin Hook Runner for `pokemon-agent-pets`.
 * Works both inside `plugin-bundle/pokemon-agent-pets/` and when synced to
 * `~/.gemini/config/plugins/pokemon-agent-pets/`.
 * Delegates to `bridge/hook-handler.mjs` when reachable, or directly forwards
 * live agent state transitions to `http://127.0.0.1:17580/api/hook`.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const AUTOSTART_THROTTLE_MS = 15_000;

function resolveWorkspaceRoot() {
  const cfgPath = join(PLUGIN_ROOT, 'workspace-config.json');
  if (existsSync(cfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
      if (cfg?.workspaceRoot && existsSync(cfg.workspaceRoot)) {
        return cfg.workspaceRoot;
      }
    } catch {}
  }
  const relRoot = resolve(PLUGIN_ROOT, '..', '..');
  if (existsSync(join(relRoot, 'bridge', 'hook-handler.mjs'))) {
    return relRoot;
  }
  return null;
}

function findBridgeHookHandler() {
  const workspaceRoot = resolveWorkspaceRoot();
  if (workspaceRoot) {
    const candidate = join(workspaceRoot, 'bridge', 'hook-handler.mjs');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function maybeAutowakeOnWindows(workspaceRoot, eventName, bridgePostFailed) {
  if (process.platform !== 'win32' || !workspaceRoot) return;
  if (eventName !== 'SessionStart' && eventName !== 'PreInvocation' && !bridgePostFailed) return;

  try {
    const tempDir = process.env.TEMP || process.env.TMP || tmpdir();
    const stateFile = join(tempDir, 'antigravity-pokemon-desktop-overlay-state.json');
    const muteFile = join(tempDir, 'antigravity-pokemon-desktop-overlay-muted.json');
    const stampFile = join(tempDir, 'antigravity-pokemon-hook-autostart.stamp');

    const overlayMuted = existsSync(muteFile);
    let overlayAlive = false;
    if (existsSync(stateFile)) {
      try {
        const st = JSON.parse(readFileSync(stateFile, 'utf8'));
        overlayAlive = isPidAlive(Number(st?.pid));
      } catch {}
    }

    const needBridge = Boolean(bridgePostFailed);
    const needOverlay = !overlayAlive && !overlayMuted;
    if (!needBridge && !needOverlay) return;

    const now = Date.now();
    if (existsSync(stampFile)) {
      try {
        const lastStamp = Number(readFileSync(stampFile, 'utf8').trim());
        if (Number.isFinite(lastStamp) && (now - lastStamp) < AUTOSTART_THROTTLE_MS) {
          return;
        }
      } catch {}
    }
    try {
      writeFileSync(stampFile, String(now), 'utf8');
    } catch {}

    const silentVbs = join(workspaceRoot, 'desktop-pet', 'silent-launch.vbs');
    if (!existsSync(silentVbs)) return;

    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const wscriptCandidate = join(sysRoot, 'System32', 'wscript.exe');
    const wscriptExe = existsSync(wscriptCandidate) ? wscriptCandidate : 'wscript.exe';
    const spawnOpts = { detached: true, stdio: 'ignore', windowsHide: true };

    if (needBridge) {
      const monitorScript = join(workspaceRoot, 'bridge', 'agent-monitor.mjs');
      if (existsSync(monitorScript)) {
        const child = spawn(
          wscriptExe,
          ['//B', '//Nologo', silentVbs, process.execPath, monitorScript],
          spawnOpts
        );
        child.unref();
      }
    }

    if (needOverlay) {
      const launcherScript = join(workspaceRoot, 'desktop-pet', 'launch-desktop-pet.ps1');
      if (existsSync(launcherScript)) {
        const child = spawn(
          wscriptExe,
          [
            '//B', '//Nologo', silentVbs,
            'powershell.exe', '-STA', '-NoProfile', '-NonInteractive',
            '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass',
            '-File', launcherScript, '-BindToIde', '-FromWatchdog'
          ],
          spawnOpts
        );
        child.unref();
      }
    }
  } catch {
    // Non-fatal: never block hook response
  }
}

const externalHandler = findBridgeHookHandler();
if (externalHandler) {
  await import(pathToFileURL(externalHandler).href);
} else {
  // Built-in zero-dependency fallback hook handler
  const eventArg = String(process.argv[2] || '').trim();
  const chunks = [];
  if (!process.stdin.isTTY) {
    await new Promise((res) => {
      const t = setTimeout(res, 400);
      process.stdin.on('data', (c) => chunks.push(Buffer.from(c)));
      process.stdin.on('end', () => { clearTimeout(t); res(); });
      process.stdin.on('error', () => { clearTimeout(t); res(); });
    });
  }
  let payload = {};
  try {
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (raw) payload = JSON.parse(raw);
  } catch {}

  const eventName = String(payload?.hookEventName || eventArg || '');
  const convId = String(payload?.conversationId || 'hook-session');
  let state = 'thinking';
  let statusText = '💭 正在思考中...';
  if (eventName === 'PreToolUse') {
    state = 'working';
    statusText = `⚡ 执行工具: ${payload?.toolCall?.name || 'tool'}`;
  } else if (eventName === 'Stop') {
    state = payload?.error ? 'error' : 'celebrating';
    statusText = payload?.error ? '💧 执行异常' : '✨ 回合完成！';
  }

  const update = {
    id: convId,
    conversationId: convId,
    hookEventName: eventName,
    model: String(payload?.modelName || 'auto'),
    state,
    statusText,
    updatedAt: new Date().toISOString(),
    expiresAtMs: Date.now() + 45000
  };

  try {
    const cacheFile = join(homedir(), '.gemini', 'antigravity', 'pokemon-hook-state.json');
    mkdirSync(dirname(cacheFile), { recursive: true });
    let cur = {};
    if (existsSync(cacheFile)) {
      try { cur = JSON.parse(readFileSync(cacheFile, 'utf8')) || {}; } catch {}
    }
    cur[convId] = update;
    writeFileSync(cacheFile, JSON.stringify(cur, null, 2), 'utf8');
  } catch {}

  let bridgePostFailed = false;
  try {
    const res = await fetch('http://127.0.0.1:17580/api/hook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(250)
    });
    if (!res.ok) bridgePostFailed = true;
  } catch {
    bridgePostFailed = true;
  }

  maybeAutowakeOnWindows(resolveWorkspaceRoot(), eventName, bridgePostFailed);

  const out = (eventName === 'PreToolUse' || eventName === 'Stop')
    ? { decision: 'allow' }
    : {};
  process.stdout.write(JSON.stringify(out) + '\n');
}
