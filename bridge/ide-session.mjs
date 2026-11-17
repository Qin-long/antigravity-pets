/**
 * IDE session binding for the Pokémon agent bridge.
 *
 * Rules (product contract):
 *   1. The suite lives and dies with Antigravity IDE: once an IDE window has connected (or the bridge was
 *      started with `--bind-ide`), the bridge exits when every IDE host process has been gone for a grace period.
 *   2. Only conversations that had activity in a project window opened during *this* IDE launch are shown.
 *   3. Once shown, a conversation (and its lead agent) stays pinned until its project window closes —
 *      it no longer retires after 60s idle. Closing the window clears its conversations.
 *
 * Window / project knowledge comes from the IDE extension, which polls
 * `/api/agents?client=ide-extension&instance=..&folders=..&hostPid=..&host=..&startedAt=..`.
 * Host liveness comes from `tasklist` (cheap, no PowerShell) every few seconds.
 * State is persisted to %TEMP% keyed by the IDE main-process pid, so a bridge restart or window reload
 * inside the same IDE launch keeps the pinned conversations.
 */
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STATE_FILE = join(tmpdir(), 'antigravity-pokemon-ide-session.json');
const DEFAULT_HOST_EXES = ['antigravity ide.exe', 'antigravity.exe'];

export function normalizeProjectKey(p) {
  let s = String(p || '').trim();
  if (!s) return '';
  try {
    if (/^file:\/\//i.test(s)) s = decodeURIComponent(s.replace(/^file:\/\/\/?/i, ''));
  } catch {
    // keep raw
  }
  return s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout) return resolve(null);
      const procs = [];
      for (const line of String(stdout).split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line);
        if (m) procs.push({ name: m[1].toLowerCase(), pid: Number(m[2]) });
      }
      resolve(procs);
    });
  });
}

function processStartMs(pid) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !(pid > 0)) return resolve(0);
    const cmd = `$p=Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue; if($p){[DateTimeOffset]::new($p.StartTime).ToUnixTimeMilliseconds()}`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      const n = Number(String(stdout || '').trim());
      resolve(!err && Number.isFinite(n) && n > 0 ? n : 0);
    });
  });
}

export function createIdeSession({
  bindFromArgv = false,
  standalone = false,
  hostExes = [],
  aliveMs = 6000,
  projectCloseGraceMs = 30000, // survives "Reload Window" (extension host restart) without dropping pins
  hostGoneGraceMs = 10000,
  neverSeenExitMs = 60000,
  watchIntervalMs = 4000,
  onAllHostsGone = () => {}
} = {}) {
  const startedAtMs = Date.now();
  const instances = new Map(); // instance -> { lastPollMs, focusedAt, workspaceName, folders[], startedAt, hostPid, host }
  const hostExeSet = new Set([...(hostExes.length ? hostExes : DEFAULT_HOST_EXES)].map((s) => String(s).toLowerCase()));
  let bound = Boolean(bindFromArgv) && !standalone;

  // Persisted per IDE launch (keyed by host pid).
  let hosts = {}; // pid -> { startMs, firstSeenMs }
  let projects = {}; // projectKey -> { openedAt, hostPid, lastSeenMs }
  let pinned = {}; // conversationId -> { projectKey, hostPid, pinnedAt }
  let hostSeen = false;
  let hostMissingSince = 0;
  let lastAliveHostPids = new Set();
  let dirty = false;
  let saveTimer = null;

  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8').replace(/^﻿/, ''));
    hosts = raw.hosts || {};
    projects = raw.projects || {};
    pinned = raw.pinned || {};
  } catch {
    // fresh
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!dirty) return;
      dirty = false;
      try {
        writeFileSync(STATE_FILE, JSON.stringify({ hosts, projects, pinned, savedAt: new Date().toISOString() }), 'utf8');
      } catch {
        // ignore
      }
    }, 800);
  }

  function aliveInstances(nowMs) {
    const out = [];
    for (const [id, info] of instances) {
      if (nowMs - info.lastPollMs <= aliveMs) out.push([id, info]);
    }
    return out;
  }

  function registerPoll(params, nowMs = Date.now()) {
    const inst = String(params.get('instance') || 'default').slice(0, 120);
    const hostPid = Number(params.get('hostPid')) || 0;
    const host = String(params.get('host') || '').toLowerCase().slice(0, 80);
    const folders = String(params.get('folders') || '')
      .split('|')
      .map((f) => normalizeProjectKey(f))
      .filter(Boolean)
      .slice(0, 20);
    const info = {
      lastPollMs: nowMs,
      focusedAt: Number(params.get('focusedAt')) || 0,
      workspaceName: String(params.get('ws') || '').slice(0, 200),
      folders,
      startedAt: Number(params.get('startedAt')) || nowMs,
      hostPid,
      host,
      // Older extension builds don't report folders: they keep liveness/stage routing but not scoping.
      reportsFolders: params.has('folders')
    };
    const isNew = !instances.has(inst);
    instances.set(inst, info);
    if (instances.size > 60) instances.delete(instances.keys().next().value);

    if (!standalone) bound = true; // an IDE window is using us -> follow its lifecycle
    if (host && /\.exe$/.test(host)) hostExeSet.add(host);
    hostSeen = true;
    hostMissingSince = 0;

    if (hostPid > 0 && !hosts[hostPid]) {
      hosts[hostPid] = { startMs: 0, firstSeenMs: nowMs };
      scheduleSave();
      processStartMs(hostPid).then((ms) => {
        if (hosts[hostPid]) {
          hosts[hostPid].startMs = ms;
          // Windows already open when we first met this IDE launch count from the IDE start.
          for (const p of Object.values(projects)) {
            if (p.hostPid === hostPid && p.fromFirstContact && ms > 0 && ms < p.openedAt) p.openedAt = ms;
          }
          scheduleSave();
        }
      });
    }

    for (const key of folders) {
      const p = projects[key];
      if (!p) {
        const h = hosts[hostPid];
        const firstContact = Boolean(h && nowMs - h.firstSeenMs < 15000);
        // Window open time: IDE start for windows present at first contact, else this extension host's start.
        const openedAt = firstContact && h.startMs > 0 ? Math.min(h.startMs, info.startedAt) : info.startedAt;
        projects[key] = { openedAt, hostPid, lastSeenMs: nowMs, fromFirstContact: firstContact };
        scheduleSave();
      } else {
        p.lastSeenMs = nowMs;
        if (hostPid && p.hostPid !== hostPid) {
          // Same folder in a new IDE launch: a fresh window.
          p.hostPid = hostPid;
          p.openedAt = info.startedAt;
          p.fromFirstContact = false;
          scheduleSave();
        }
      }
    }
    void isNew;
  }

  function openProjectMap(nowMs) {
    const map = new Map();
    for (const [key, p] of Object.entries(projects)) {
      if (nowMs - (p.lastSeenMs || 0) <= Math.max(aliveMs, projectCloseGraceMs)) map.set(key, p.openedAt || 0);
    }
    return map;
  }

  function sweep(nowMs) {
    let changed = false;
    const open = openProjectMap(nowMs);
    // Project windows closed (no IDE window has reported the folder for a while): clear them + their pins.
    // Only sweep while some IDE window is alive, so a bridge restart doesn't wipe state before windows re-poll.
    if (aliveInstances(nowMs).length > 0 || nowMs - startedAtMs > 20000) {
      for (const key of Object.keys(projects)) {
        if (!open.has(key)) {
          delete projects[key];
          changed = true;
        }
      }
      for (const [conv, pin] of Object.entries(pinned)) {
        if (!open.has(pin.projectKey)) {
          delete pinned[conv];
          changed = true;
        }
      }
    }
    if (changed) scheduleSave();
  }

  /** Is an IDE session driving visibility right now? (false -> caller uses legacy rules) */
  function isActive(nowMs = Date.now()) {
    return aliveInstances(nowMs).some(([, info]) => info.reportsFolders) || Object.keys(projects).length > 0;
  }

  /**
   * items: [{ shouldKeepAlive, latestActivityMs, isSimulated, queue: { conversationId, projectId } }]
   * Returns the subset to show.
   */
  function selectVisible(items, nowMs = Date.now()) {
    sweep(nowMs);
    const open = openProjectMap(nowMs);
    const sessionStart = Math.min(
      ...Object.values(hosts).map((h) => h.startMs || h.firstSeenMs || nowMs),
      nowMs
    );
    const out = [];
    let changed = false;
    for (const it of items) {
      const q = it.queue;
      if (it.isSimulated) {
        if (it.shouldKeepAlive) out.push(it);
        continue;
      }
      const key = normalizeProjectKey(q.projectId || q.workspacePath);
      const openedAt = open.get(key);
      if (openedAt !== undefined) {
        const pin = pinned[q.conversationId];
        if (pin || (it.latestActivityMs || 0) >= openedAt - 2000) {
          if (!pin) {
            pinned[q.conversationId] = { projectKey: key, hostPid: projects[key]?.hostPid || 0, pinnedAt: nowMs };
            changed = true;
          }
          out.push(it);
        }
      } else if (it.shouldKeepAlive && (it.latestActivityMs || 0) >= sessionStart) {
        // Conversation whose project has no open window (e.g. started from the Agent Manager):
        // visible only while active, with the normal 60s retirement.
        out.push(it);
      }
    }
    if (changed) scheduleSave();
    return out;
  }

  function pickOpenStageTarget(nowMs = Date.now()) {
    let target = null;
    for (const [inst, info] of aliveInstances(nowMs)) {
      if (!target || info.focusedAt > target.focusedAt) target = { inst, focusedAt: info.focusedAt, workspaceName: info.workspaceName };
    }
    return target;
  }

  function publicState(nowMs = Date.now()) {
    const open = openProjectMap(nowMs);
    return {
      bound,
      active: isActive(nowMs),
      windows: aliveInstances(nowMs).length,
      hostExes: [...hostExeSet],
      openProjects: [...open.entries()].map(([key, openedAt]) => ({ projectId: key, openedAt: new Date(openedAt).toISOString() })),
      pinnedConversations: Object.keys(pinned).length
    };
  }

  async function checkHosts() {
    const procs = await listProcesses();
    if (!procs) return; // can't tell; never kill on uncertainty
    const nowMs = Date.now();
    const alive = procs.filter((p) => hostExeSet.has(p.name));
    const alivePids = new Set(alive.map((p) => p.pid));

    // Forget state from IDE launches that are gone.
    let changed = false;
    for (const pid of Object.keys(hosts)) {
      if (!alivePids.has(Number(pid))) {
        delete hosts[pid];
        changed = true;
        for (const [k, p] of Object.entries(projects)) if (p.hostPid === Number(pid)) delete projects[k];
        for (const [c, p] of Object.entries(pinned)) if (p.hostPid === Number(pid)) delete pinned[c];
      }
    }
    if (changed) scheduleSave();
    lastAliveHostPids = alivePids;

    if (alive.length > 0) {
      hostSeen = true;
      hostMissingSince = 0;
      return;
    }
    if (!bound) return;
    if (!hostSeen) {
      if (nowMs - startedAtMs >= neverSeenExitMs) onAllHostsGone('never-seen');
      return;
    }
    if (!hostMissingSince) hostMissingSince = nowMs;
    if (nowMs - hostMissingSince >= hostGoneGraceMs) {
      // IDE fully closed: clear this launch's session so the next launch starts clean.
      hosts = {};
      projects = {};
      pinned = {};
      dirty = true;
      try {
        writeFileSync(STATE_FILE, JSON.stringify({ hosts, projects, pinned, savedAt: new Date().toISOString() }), 'utf8');
      } catch {
        // ignore
      }
      onAllHostsGone('ide-closed');
    }
  }

  let watchTimer = null;
  function start() {
    if (watchTimer) return;
    watchTimer = setInterval(() => {
      checkHosts().catch(() => {});
    }, watchIntervalMs);
    if (watchTimer.unref) watchTimer.unref();
    checkHosts().catch(() => {});
  }

  /** Another host app (e.g. the Antigravity app via its sidecar) whose processes keep the bridge alive. */
  function addHostExe(name) {
    const exe = String(name || '').toLowerCase();
    if (!/^[a-z0-9 _.-]{1,60}\.exe$/.test(exe) || hostExeSet.has(exe)) return;
    hostExeSet.add(exe);
    hostMissingSince = 0;
  }

  return {
    registerPoll,
    addHostExe,
    isActive,
    selectVisible,
    pickOpenStageTarget,
    publicState,
    start,
    get bound() {
      return bound;
    },
    get aliveHostPids() {
      return lastAliveHostPids;
    }
  };
}
