#!/usr/bin/env node
/**
 * Pokémon Agent Monitor — Antigravity Lifecycle Hook Handler
 * Zero-dependency ES module for Antigravity `hooks.json`.
 *
 * Reads hook event JSON from stdin, forwards live state transitions
 * (`thinking`, `working`, `celebrating`, `sleeping`, `error`) to the local
 * bridge (`http://127.0.0.1:17580/api/hook`) + a lightweight fallback cache file,
 * and outputs the exact required JSON contract on stdout so agent execution never blocks.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(__dirname, '..');
const BRIDGE_HOST = process.env.POKEMON_BRIDGE_HOST || '127.0.0.1';
const BRIDGE_PORT = Number(process.env.POKEMON_BRIDGE_PORT || 17580);
const BRIDGE_URL = `http://${BRIDGE_HOST}:${BRIDGE_PORT}/api/hook`;
const HOOK_STATE_FILE = join(homedir(), '.gemini', 'antigravity', 'pokemon-hook-state.json');
const AUTOSTART_THROTTLE_MS = 15_000;

/**
 * Read all of stdin with a safety timeout so the hook never hangs if invoked interactively.
 */
function readStdin(timeoutMs = 500) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Map an Antigravity hook payload to a normalized Pokémon pet state update.
 */
function mapHookPayloadToUpdate(payload) {
  const eventName = String(payload?.hookEventName || process.argv[2] || '').trim();
  const conversationId = String(payload?.conversationId || 'hook-session').trim();
  const model = String(payload?.modelName || 'auto').trim();
  const nowIso = new Date().toISOString();

  let state = 'thinking';
  let statusText = '💭 正在思考中...';
  let toolName = null;
  let ttlMs = 45_000;

  switch (eventName) {
    case 'SessionStart': {
      state = 'thinking';
      statusText = '🌟 新会话已开启，准备就绪';
      ttlMs = 20_000;
      break;
    }
    case 'PreInvocation': {
      state = 'thinking';
      const promptHint = String(payload?.lastUserInput || '').trim().replace(/\s+/g, ' ').slice(0, 32);
      statusText = promptHint ? `💭 思考中: ${promptHint}` : '💭 正在推理与规划下一步...';
      ttlMs = 60_000;
      break;
    }
    case 'PreToolUse': {
      state = 'working';
      toolName = String(payload?.toolCall?.name || 'tool').trim();
      const summary =
        payload?.toolCall?.args?.toolSummary ||
        payload?.toolCall?.args?.Path ||
        payload?.toolCall?.args?.query ||
        '';
      const cleanSummary = String(summary).replace(/^"+|"+$/g, '').split(/[\\/]/).pop().slice(0, 28);
      statusText = cleanSummary
        ? `⚡ 施展 ${toolName}: ${cleanSummary}`
        : `⚡ 正在执行工具: ${toolName}`;
      ttlMs = 90_000;
      break;
    }
    case 'PostToolUse': {
      toolName = String(payload?.toolCall?.name || 'tool').trim();
      if (payload?.error) {
        state = 'error';
        statusText = `💧 工具异常 (${toolName}): ${String(payload.error).slice(0, 32)}`;
        ttlMs = 20_000;
      } else {
        state = 'thinking';
        statusText = `💭 分析 ${toolName} 返回结果...`;
        ttlMs = 45_000;
      }
      break;
    }
    case 'PostInvocation': {
      state = 'thinking';
      statusText = '💭 正在整理最终回复...';
      ttlMs = 20_000;
      break;
    }
    case 'Stop': {
      const reason = String(payload?.terminationReason || 'NO_TOOL_CALL');
      if (reason === 'ERROR' || payload?.error) {
        state = 'error';
        statusText = `💧 执行中断: ${String(payload?.error || reason).slice(0, 36)}`;
        ttlMs = 30_000;
      } else if (reason === 'USER_CANCELED') {
        state = 'sleeping';
        statusText = '💤 用户已暂停当前回合';
        ttlMs = 30_000;
      } else {
        state = 'celebrating';
        statusText = '✨ 任务回合圆满完成！';
        ttlMs = 8_000;
      }
      break;
    }
    default: {
      state = 'thinking';
      statusText = eventName ? `💭 事件: ${eventName}` : '💭 智能体活跃中';
      ttlMs = 30_000;
    }
  }

  return {
    id: conversationId,
    conversationId,
    hookEventName: eventName || 'Unknown',
    model,
    state,
    statusText,
    toolName,
    workspacePaths: Array.isArray(payload?.workspacePaths) ? payload.workspacePaths : [],
    transcriptPath: payload?.transcriptPath || null,
    updatedAt: nowIso,
    expiresAtMs: Date.now() + ttlMs
  };
}

/**
 * Persist a tiny bounded cache file so `agent-monitor.mjs` can read recent hook
 * transitions even if started moments after a hook fired.
 */
function persistFallbackHookState(update) {
  try {
    const dir = dirname(HOOK_STATE_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    let existing = {};
    if (existsSync(HOOK_STATE_FILE)) {
      try {
        existing = JSON.parse(readFileSync(HOOK_STATE_FILE, 'utf8')) || {};
      } catch {
        existing = {};
      }
    }
    const now = Date.now();
    const cleaned = {};
    for (const [key, val] of Object.entries(existing)) {
      if (val && typeof val === 'object' && Number(val.expiresAtMs || 0) > now - 60_000) {
        cleaned[key] = val;
      }
    }
    cleaned[update.id] = update;
    writeFileSync(HOOK_STATE_FILE, JSON.stringify(cleaned, null, 2), 'utf8');
  } catch {
    // Non-fatal: never block the agent loop on filesystem errors
  }
}

/**
 * Build the stdout JSON response required by Antigravity's hook specification.
 * - `PreToolUse` requires `{ "decision": "allow" }`
 * - `Stop` requires `{ "decision": "allow" }` (any value other than "continue" permits stopping)
 * - Other events expect `{}`
 */
function buildHookResponse(eventName) {
  if (eventName === 'PreToolUse') {
    return { decision: 'allow' };
  }
  if (eventName === 'Stop') {
    return { decision: 'allow' };
  }
  return {};
}

/**
 * Check whether a PID is still alive without throwing.
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

/**
 * On Windows, silently wake the bridge (`agent-monitor.mjs`) and/or WPF desktop overlay
 * (`launch-desktop-pet.ps1`) via `wscript.exe //B //Nologo silent-launch.vbs` when needed.
 * Throttled via `%TEMP%\antigravity-pokemon-hook-autostart.stamp` (15,000ms) and respects mute file.
 */
function maybeAutowakeOnWindows(eventName, bridgePostFailed) {
  if (process.platform !== 'win32') return;
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
      } catch {
        overlayAlive = false;
      }
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

    const silentVbs = join(WORKSPACE_ROOT, 'desktop-pet', 'silent-launch.vbs');
    if (!existsSync(silentVbs)) return;

    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const wscriptCandidate = join(sysRoot, 'System32', 'wscript.exe');
    const wscriptExe = existsSync(wscriptCandidate) ? wscriptCandidate : 'wscript.exe';
    const spawnOpts = { detached: true, stdio: 'ignore', windowsHide: true };

    if (needBridge) {
      const monitorScript = join(WORKSPACE_ROOT, 'bridge', 'agent-monitor.mjs');
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
      const launcherScript = join(WORKSPACE_ROOT, 'desktop-pet', 'launch-desktop-pet.ps1');
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
    // Non-fatal: never block agent execution on auto-wake failure
  }
}

async function main() {
  const raw = await readStdin(500);
  let payload = {};
  if (raw && raw.trim()) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = {};
    }
  }

  const eventName = String(payload?.hookEventName || process.argv[2] || '').trim();
  const update = mapHookPayloadToUpdate(payload);

  persistFallbackHookState(update);

  // Fire-and-forget fast HTTP push (250ms budget) so hook latency stays imperceptible
  let bridgePostFailed = false;
  try {
    const res = await fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(250)
    });
    if (!res.ok) {
      bridgePostFailed = true;
    }
  } catch {
    bridgePostFailed = true;
  }

  maybeAutowakeOnWindows(eventName, bridgePostFailed);

  process.stdout.write(JSON.stringify(buildHookResponse(eventName)) + '\n');
}

main().catch(() => {
  process.stdout.write('{}\n');
  process.exit(0);
});
