'use strict';

const vscode = require('vscode');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

/**
 * Theme catalog mapping Webview skin IDs <-> VS Code contributed themes.
 * `id` is the stable value stored in `workbench.colorTheme` (package.json `contributes.themes[].id`);
 * `legacyLabel` is what older versions stored there, migrated to `id` on activation.
 */
const POKEMON_THEMES = [
  {
    skin: 'pikachu',
    id: 'agent-pets-volt-dark',
    label: '⚡ 电光黄 · 暗色',
    legacyLabel: '⚡ 皮卡丘·十万伏特暗色主题',
    shortName: '⚡ 电光黄',
    desc: '雷电金 #FFD43B · 青色语法高亮'
  },
  {
    skin: 'gengar',
    id: 'agent-pets-shadow-dark',
    label: '🟣 暗影紫 · 暗色',
    legacyLabel: '🟣 耿鬼·暗影球深紫主题',
    shortName: '🟣 暗影紫',
    desc: '幽灵深紫 #120E1E · 猩红点缀'
  },
  {
    skin: 'charizard',
    id: 'agent-pets-flame-dark',
    label: '🔥 烈焰橙 · 暗色',
    legacyLabel: '🔥 喷火龙·闪焰冲锋主题',
    shortName: '🔥 烈焰橙',
    desc: '黑曜熔岩 #181210 · 烈焰橙与青色'
  },
  {
    skin: 'umbreon',
    id: 'agent-pets-moonlight-dark',
    label: '🌙 月夜黑 · 暗色',
    legacyLabel: '🌙 月亮伊布·月光夜色主题',
    shortName: '🌙 月夜黑',
    desc: '深渊夜空 #0B0F19 · 月环金与月光蓝'
  },
  {
    skin: 'mewtwo',
    id: 'agent-pets-psychic-dark',
    label: '🔮 灵能紫 · 暗色',
    legacyLabel: '🔮 超梦·精神击破暗色主题',
    shortName: '🔮 灵能紫',
    desc: '银紫幻境 #110E1B · 紫粉高亮'
  },
  {
    skin: 'pokedex-light',
    id: 'agent-pets-daybreak-light',
    label: '☀️ 晨光 · 浅色',
    legacyLabel: '🔴 洛托姆图鉴·清爽亮色主题',
    shortName: '☀️ 晨光浅色',
    desc: '绯红点缀 #EF4444 · 护眼白昼'
  }
];

/** Find a catalog entry by its id, current label or a label stored by older versions. */
function findThemeEntry(value) {
  const v = String(value || '');
  return POKEMON_THEMES.find((t) => t.id === v || t.label === v || t.legacyLabel === v) || null;
}

// Creature ids of the active skin pack; filled in place from the bridge (GET /api/pack) by refreshPackDescriptor().
const SPECIES_LIST = [];
let packDescriptor = null; // { id, version, creatures: [...], baseUrl, ... } as served by the bridge
let packSig = '';
let packFetchInFlight = false;
const packListeners = new Set();

async function refreshPackDescriptor(bridgeUrl) {
  if (packFetchInFlight) return;
  packFetchInFlight = true;
  try {
    const p = await httpRequestJson(`${bridgeUrl}/api/pack`, 'GET', null, 2500);
    if (!p || !p.ok || !Array.isArray(p.creatures)) return;
    packDescriptor = { ...p, bridgeUrl };
    packSig = `${p.id}@${p.version}`;
    SPECIES_LIST.length = 0;
    for (const c of p.creatures) SPECIES_LIST.push(c.id);
    for (const fn of packListeners) {
      try {
        fn(packDescriptor);
      } catch (_) {
        // ignore listener errors
      }
    }
  } catch (_) {
    // bridge not up yet; retried on the next poll
  } finally {
    packFetchInFlight = false;
  }
}

const SPECIES_EMOJI = {
  pikachu: '⚡',
  gengar: '👻',
  charizard: '🔥',
  umbreon: '🌙',
  eevee: '🦊',
  rotom: '🔴',
  mewtwo: '🔮'
};

const STATE_META = {
  thinking: { icon: '💭', label: 'Thinking', cn: '思考中' },
  working: { icon: '⚡', label: 'Working', cn: '工作中' },
  sleeping: { icon: '💤', label: 'Sleeping', cn: '休眠中' },
  celebrating: { icon: '✨', label: 'Celebrating', cn: '欢呼中' },
  error: { icon: '💫', label: 'Error', cn: '异常' }
};

/**
 * Resolve the root folder of `Antigravity IDE ui` so shared assets (`assets/`, `theme-css/`,
 * `bridge/`, `desktop-pet/`) work seamlessly whether the extension is symlinked, copied to
 * `~/.antigravity/extensions/`, or opened directly in workspace development mode.
 */
function resolveSuiteRoot(context) {
  const candidates = [];

  const configured = vscode.workspace.getConfiguration('pokemonTheme').get('suiteRoot');
  if (configured && typeof configured === 'string' && configured.trim()) {
    candidates.push(configured.trim());
  }

  // Optional marker written by install-theme.ps1 when copying to ~/.antigravity/extensions
  const markerPath = path.join(context.extensionPath, 'source-root.json');
  try {
    if (fs.existsSync(markerPath)) {
      const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (marker && marker.suiteRoot) {
        candidates.push(marker.suiteRoot);
      }
    }
  } catch (_) {
    // ignore invalid marker
  }

  // Parent directory when running inside repo or via symlink/junction
  candidates.push(path.resolve(context.extensionPath, '..'));

  // Open workspace folders
  if (Array.isArray(vscode.workspace.workspaceFolders)) {
    for (const wf of vscode.workspace.workspaceFolders) {
      candidates.push(wf.uri.fsPath);
    }
  }

  // Common Desktop location fallback
  candidates.push(path.join(os.homedir(), 'Desktop', 'Antigravity IDE ui'));

  for (const dir of candidates) {
    if (!dir) continue;
    try {
      const hasAssets = fs.existsSync(path.join(dir, 'assets'));
      const hasSkin = fs.existsSync(path.join(dir, 'theme-css', 'antigravity-pokemon-skin.css'));
      const hasDesktopPet = fs.existsSync(path.join(dir, 'desktop-pet'));
      if (hasSkin || hasAssets || hasDesktopPet) {
        return dir;
      }
    } catch (_) {
      // continue checking next candidate
    }
  }

  return path.resolve(context.extensionPath, '..');
}

function assignSpeciesForAgent(name, role) {
  const key = String(name || role || 'agent').toLowerCase();
  if (!SPECIES_LIST.length) return '';
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return SPECIES_LIST[hash % SPECIES_LIST.length];
}

function httpRequestJson(urlStr, method = 'GET', bodyObj = null, timeoutMs = 1200) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlStr);
    } catch (err) {
      return reject(err);
    }

    const payload = bodyObj ? Buffer.from(JSON.stringify(bodyObj), 'utf8') : null;
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: parsed.pathname + parsed.search,
        method,
        timeout: timeoutMs,
        headers: payload
          ? {
              'Content-Type': 'application/json',
              'Content-Length': payload.length
            }
          : {}
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(text));
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }
    );

    req.on('timeout', () => {
      req.destroy(new Error('Request timeout'));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Read the last N bytes of a file synchronously for fast, zero-lag transcript inspection.
 */
function readTailLines(filePath, maxBytes = 24576) {
  let fd = null;
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return { mtimeMs: stat.mtimeMs, lines: [] };
    const readSize = Math.min(stat.size, maxBytes);
    const startPos = Math.max(0, stat.size - readSize);
    const buf = Buffer.alloc(readSize);
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, readSize, startPos);
    const raw = buf.toString('utf8');
    const lines = raw.split(/\r?\n/).filter((line) => line.trim().startsWith('{'));
    return { mtimeMs: stat.mtimeMs, lines };
  } catch (_) {
    return { mtimeMs: 0, lines: [] };
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

function parseSwarmMembersList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.members)) return raw.members;
    if (raw.members && typeof raw.members === 'object') {
      return Object.entries(raw.members)
        .map(([k, v]) => (v && typeof v === 'object' ? { name: k, ...v } : null))
        .filter(Boolean);
    }
    return Object.entries(raw)
      .filter(([, v]) => v && typeof v === 'object' && ('conversation_id' in v || 'role' in v))
      .map(([k, v]) => ({ name: k, ...v }));
  }
  return [];
}

const SUBAGENT_IDLE_TTL_MS = 60000;

function formatTokensCompact(numVal) {
  const n = Math.max(0, Math.round(Number(numVal) || 0));
  if (n >= 1000000) {
    return `${(Math.round((n / 1000000) * 10) / 10).toString().replace(/\.0$/, '')}M`;
  }
  if (n >= 100000) {
    return `${Math.round(n / 1000)}k`;
  }
  if (n >= 1000) {
    return `${(Math.round((n / 1000) * 10) / 10).toString().replace(/\.0$/, '')}k`;
  }
  return String(n);
}

function inferModelMaxTokens(modelName) {
  const m = String(modelName || '').toLowerCase();
  if (m.includes('gemini')) return 1000000;
  return 200000;
}

function normalizeAgentContextObj(rawCtx, modelName) {
  const c = rawCtx && typeof rawCtx === 'object' ? rawCtx : {};
  let maxTokens = Number(c.maxTokens || c.contextMaxTokens || inferModelMaxTokens(modelName));
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) maxTokens = 200000;

  const rawUsed = c.usedTokens !== undefined ? c.usedTokens : c.contextUsedTokens;
  const usedTokens = Math.max(0, Math.round(Number(rawUsed) || 0));

  const rawUsedPct = c.usedPct !== undefined ? c.usedPct : c.contextUsedPct;
  const usedPct =
    typeof rawUsedPct === 'number' && Number.isFinite(rawUsedPct)
      ? Math.max(0, Math.min(100, rawUsedPct))
      : Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100));

  const rawCached = c.cachedTokens !== undefined ? c.cachedTokens : c.cacheHitTokens;
  const cachedTokens = Math.max(0, Math.round(Number(rawCached) || 0));

  const cacheHitPct =
    typeof c.cacheHitPct === 'number' && Number.isFinite(c.cacheHitPct)
      ? Math.max(0, Math.min(100, c.cacheHitPct))
      : usedTokens > 0
      ? Math.max(0, Math.min(100, (cachedTokens / usedTokens) * 100))
      : 0;

  const uncachedTokens =
    c.uncachedTokens !== undefined
      ? Math.max(0, Math.round(Number(c.uncachedTokens) || 0))
      : Math.max(0, usedTokens - cachedTokens);

  return {
    usedTokens,
    maxTokens,
    usedPct: Math.round(usedPct * 10) / 10,
    cachedTokens,
    cacheHitPct: Math.round(cacheHitPct * 10) / 10,
    cacheKnown: c.cacheKnown !== false,
    cacheWarm: c.cacheWarm !== false,
    uncachedTokens,
    tooltipText: typeof c.tooltipText === 'string' ? c.tooltipText : '',
    modelContextLabel: String(c.modelContextLabel || `${formatTokensCompact(maxTokens)} ctx`)
  };
}

function estimateTranscriptFallbackContext(transcriptPath, modelName) {
  const maxTokens = inferModelMaxTokens(modelName);
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return normalizeAgentContextObj({ usedTokens: 0, maxTokens, cachedTokens: 0, cacheHitPct: 0 }, modelName);
  }
  try {
    const st = fs.statSync(transcriptPath);
    const estUsed = Math.min(maxTokens, Math.max(1200, Math.round(st.size / 4.2)));
    const { lines } = readTailLines(transcriptPath, 16384);
    let lastTs = 0;
    let prevTs = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const obj = JSON.parse(lines[i]);
        const t = obj?.created_at ? Date.parse(obj.created_at) : 0;
        if (t > 0) {
          if (!lastTs) lastTs = t;
          else if (!prevTs) {
            prevTs = t;
            break;
          }
        }
      } catch (_) {}
    }
    // Bridge offline: size is an estimate, cache hits are unknown (never invent a ratio).
    void prevTs;
    return normalizeAgentContextObj(
      { usedTokens: estUsed, maxTokens, cachedTokens: 0, cacheHitPct: 0, cacheKnown: false },
      modelName
    );
  } catch (_) {
    return normalizeAgentContextObj({ usedTokens: 0, maxTokens, cachedTokens: 0, cacheHitPct: 0 }, modelName);
  }
}

function extractTranscriptHeadMeta(transcriptPath) {
  let projectName = '';
  let conversationTitle = '';
  if (!fs.existsSync(transcriptPath)) return { projectName, conversationTitle };
  let fd = null;
  try {
    const stat = fs.statSync(transcriptPath);
    const len = Math.min(stat.size, 24576);
    if (len > 0) {
      const buf = Buffer.alloc(len);
      fd = fs.openSync(transcriptPath, 'r');
      fs.readSync(fd, buf, 0, len, 0);
      const raw = buf.toString('utf8');
      const wsMatch = raw.match(/Active Workspaces:\s*(?:\\n|\r?\n)-\s*([^\r\n"\\]+)/i) ||
                      raw.match(/Command Working Directory:\s*([^\r\n"\\]+)/i);
      if (wsMatch && wsMatch[1]) {
        const cleanWs = wsMatch[1].trim().replace(/[\\/]+$/, '');
        projectName = path.basename(cleanWs) || '';
      }
      const reqMatch = raw.match(/<USER_REQUEST>\s*([\s\S]{1,120}?)\s*(?:<\/USER_REQUEST>|\\n|\r?\n)/i);
      if (reqMatch && reqMatch[1]) {
        conversationTitle = reqMatch[1].replace(/\\n/g, ' ').trim().slice(0, 64);
      }
    }
  } catch (_) {
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
  return { projectName, conversationTitle };
}

/**
 * Direct `~/.gemini/antigravity/brain` & `~/.gemini/antigravity-ide/brain` v3.0 queue fallback
 * when `bridge/agent-monitor.mjs` is offline. Enforces 60s subagent idle removal & leadAgent keep-alive.
 */
function scanBrainFallbackQueues() {
  const candidateBrainDirs = [
    path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain')
  ].filter((p) => fs.existsSync(p));

  const now = Date.now();
  const wsDefaultName =
    Array.isArray(vscode.workspace.workspaceFolders) && vscode.workspace.workspaceFolders[0]
      ? path.basename(vscode.workspace.workspaceFolders[0].uri.fsPath)
      : '全局会话';

  const queues = [];

  try {
    const allConvs = [];
    const swarmMemberParentIds = new Set();

    for (const brainDir of candidateBrainDirs) {
      const dirs = fs
        .readdirSync(brainDir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'tempmediaStorage');

      for (const d of dirs) {
        const convPath = path.join(brainDir, d.name);
        const transcriptPath = path.join(convPath, '.system_generated', 'logs', 'transcript.jsonl');
        const swarmMembersPath = path.join(convPath, '.system_generated', 'swarm', 'members.json');
        const swarmBoardPath = path.join(convPath, '.system_generated', 'swarm', 'board.jsonl');
        let mtimeMs = 0;
        let members = null;
        let swarmTitle = '';

        try {
          if (fs.existsSync(transcriptPath)) {
            mtimeMs = Math.max(mtimeMs, fs.statSync(transcriptPath).mtimeMs);
          }
          if (fs.existsSync(swarmBoardPath)) {
            mtimeMs = Math.max(mtimeMs, fs.statSync(swarmBoardPath).mtimeMs);
          }
          if (fs.existsSync(swarmMembersPath)) {
            mtimeMs = Math.max(mtimeMs, fs.statSync(swarmMembersPath).mtimeMs);
            const raw = JSON.parse(fs.readFileSync(swarmMembersPath, 'utf8'));
            if (raw && typeof raw.title === 'string') swarmTitle = raw.title.trim();
            members = parseSwarmMembersList(raw);
            for (const m of members) {
              if (!m || m.killed || !m.conversation_id) continue;
              swarmMemberParentIds.add(m.conversation_id);
              const wt = path.join(brainDir, m.conversation_id, '.system_generated', 'logs', 'transcript.jsonl');
              if (fs.existsSync(wt)) {
                mtimeMs = Math.max(mtimeMs, fs.statSync(wt).mtimeMs);
              }
            }
          }
          if (!mtimeMs) mtimeMs = fs.statSync(convPath).mtimeMs;
        } catch (_) {}

        allConvs.push({
          id: d.name,
          brainDir,
          convPath,
          transcriptPath,
          members,
          swarmTitle,
          mtimeMs
        });
      }
    }

    const roots = allConvs
      .filter((c) => !swarmMemberParentIds.has(c.id))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .slice(0, 6);

    for (let rIdx = 0; rIdx < roots.length; rIdx++) {
      const root = roots[rIdx];
      const headMeta = extractTranscriptHeadMeta(root.transcriptPath);
      const projectName = headMeta.projectName || wsDefaultName || '全局会话';
      const conversationTitle = root.swarmTitle || headMeta.conversationTitle || `会话 ${root.id.slice(0, 8)}`;

      let leadAgent = null;
      const subagents = [];

      if (Array.isArray(root.members) && root.members.length > 0) {
        for (const m of root.members) {
          if (!m || m.killed) continue;
          const memberId = m.conversation_id || m.id || `${root.id}-${m.name || 'worker'}`;
          const name = m.name || 'worker';
          const role = m.role || (name === 'coordinator' ? 'coordinator' : 'worker');
          const isLead = role === 'coordinator' || name === 'coordinator';
          const wakeMode = String(m.wake_mode || m.state || '').toLowerCase();

          let state = 'sleeping';
          let statusText = isLead ? '💤 领队统筹中 · 点击查看会话名' : '💤 待命休眠中';
          let lastActiveMs = root.mtimeMs || now;
          let memberTranscriptPath = '';

          if (m.conversation_id) {
            memberTranscriptPath = path.join(root.brainDir, m.conversation_id, '.system_generated', 'logs', 'transcript.jsonl');
            const parsed = inspectTranscriptState(memberTranscriptPath, now);
            if (parsed) {
              lastActiveMs = parsed.mtimeMs || lastActiveMs;
              state = parsed.state;
              statusText = parsed.statusText;
              if (state === 'sleeping' && wakeMode === 'working' && now - lastActiveMs < 45000) {
                state = 'thinking';
                statusText = '💭 正在思考推演中...';
              }
            }
          }

          const idleMs = state === 'sleeping' ? Math.max(0, now - lastActiveMs) : 0;
          const memberModel = m.model || 'antigravity';
          const agentEntry = {
            id: memberId,
            name,
            role,
            isLead,
            conversationId: root.id,
            conversationTitle,
            projectName,
            model: memberModel,
            state,
            statusText,
            idleMs,
            lastActiveAt: new Date(lastActiveMs).toISOString(),
            pokemonSpecies: assignSpeciesForAgent(name, role),
            context: estimateTranscriptFallbackContext(
              memberTranscriptPath || (isLead ? root.transcriptPath : ''),
              memberModel
            ),
            source: 'brain-fallback'
          };

          if (isLead && !leadAgent) {
            leadAgent = agentEntry;
          } else if (!(state === 'sleeping' && idleMs > SUBAGENT_IDLE_TTL_MS)) {
            subagents.push(agentEntry);
          }
        }
      } else {
        const parsed = inspectTranscriptState(root.transcriptPath, now);
        const lastActiveMs = (parsed && parsed.mtimeMs) || root.mtimeMs || now;
        const st = parsed ? parsed.state : 'sleeping';
        leadAgent = {
          id: root.id,
          name: `lead-${root.id.slice(0, 6)}`,
          role: 'main-agent',
          isLead: true,
          conversationId: root.id,
          conversationTitle,
          projectName,
          model: 'antigravity',
          state: st,
          statusText: parsed ? parsed.statusText : '💤 领队待命中 · 点击查看会话名',
          idleMs: st === 'sleeping' ? Math.max(0, now - lastActiveMs) : 0,
          lastActiveAt: new Date(lastActiveMs).toISOString(),
          pokemonSpecies: assignSpeciesForAgent('lead', 'main-agent'),
          context: estimateTranscriptFallbackContext(root.transcriptPath, 'antigravity'),
          source: 'brain-fallback'
        };
      }

      if (!leadAgent) {
        leadAgent = {
          id: `${root.id}:lead`,
          name: 'coordinator',
          role: 'coordinator',
          isLead: true,
          conversationId: root.id,
          conversationTitle,
          projectName,
          model: 'antigravity',
          state: 'sleeping',
          statusText: '💤 领队统筹中 · 点击查看会话名',
          idleMs: Math.max(0, now - (root.mtimeMs || now)),
          lastActiveAt: new Date(root.mtimeMs || now).toISOString(),
          pokemonSpecies: 'rotom',
          context: estimateTranscriptFallbackContext(root.transcriptPath, 'antigravity'),
          source: 'brain-fallback'
        };
      }

      const hasActiveSubagent = subagents.some((s) => s.state !== 'sleeping');
      const isRetirable =
        !hasActiveSubagent &&
        subagents.length === 0 &&
        leadAgent.state === 'sleeping' &&
        (leadAgent.idleMs || 0) > SUBAGENT_IDLE_TTL_MS;

      if (!isRetirable || queues.length === 0) {
        queues.push({
          conversationId: root.id,
          conversationTitle,
          projectName,
          hasActiveSubagent,
          retirable: isRetirable,
          leadAgent: { ...leadAgent, isLead: true, queueIndex: 0 },
          subagents: subagents.map((s, idx) => ({ ...s, isLead: false, queueIndex: idx + 1 }))
        });
      }
    }
  } catch (_) {}

  const nonRetirable = queues.filter((q) => !q.retirable);
  const kept = nonRetirable.length > 0 ? nonRetirable : queues.slice(0, 1);

  if (kept.length === 0) {
    kept.push({
      conversationId: 'local-companion-session',
      conversationTitle: '当前智能体会话',
      projectName: wsDefaultName,
      hasActiveSubagent: false,
      leadAgent: {
        id: 'local-companion',
        name: 'pikachu-companion',
        role: 'main-agent',
        isLead: true,
        queueIndex: 0,
        conversationId: 'local-companion-session',
        conversationTitle: '当前智能体会话',
        projectName: wsDefaultName,
        model: 'antigravity-ide',
        state: 'sleeping',
        statusText: '💤 趴在编辑器边打盹，点击查看会话名称！',
        idleMs: 0,
        lastActiveAt: new Date(now).toISOString(),
        pokemonSpecies: 'pikachu',
        source: 'companion'
      },
      subagents: []
    });
  }

  return kept;
}

function inspectTranscriptState(transcriptPath, now) {
  if (!fs.existsSync(transcriptPath)) return null;
  const { mtimeMs, lines } = readTailLines(transcriptPath, 20480);
  if (!mtimeMs) return null;

  let lastStep = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      lastStep = JSON.parse(lines[i]);
      break;
    } catch (_) {}
  }

  const ageMs = Math.max(0, now - mtimeMs);
  if (!lastStep) {
    return {
      mtimeMs,
      state: ageMs < 12000 ? 'thinking' : 'sleeping',
      statusText: ageMs < 12000 ? '💭 正在思考中...' : '💤 待命休眠中'
    };
  }

  const status = String(lastStep.status || '').toUpperCase();
  const type = String(lastStep.type || '').toUpperCase();
  const toolCalls = Array.isArray(lastStep.tool_calls) ? lastStep.tool_calls : [];

  if (status === 'ERROR') {
    return { mtimeMs, state: 'error', statusText: '💫 步骤异常，等待恢复' };
  }

  if (ageMs > 22000 && status === 'DONE') {
    return { mtimeMs, state: 'sleeping', statusText: '💤 任务就绪 · 休眠呼吸中' };
  }

  if (toolCalls.length > 0) {
    const toolName = toolCalls[toolCalls.length - 1].name || toolCalls[toolCalls.length - 1].tool_name || 'tool';
    if (toolName === 'swarm_wait') {
      return { mtimeMs, state: 'sleeping', statusText: '💤 待命休眠中' };
    }
    if (status !== 'DONE' || ageMs <= 12000) {
      return { mtimeMs, state: 'working', statusText: `⚡ 调用工具: ${toolName}` };
    }
  }

  if (type === 'USER_INPUT' && ageMs <= 30000) {
    return { mtimeMs, state: 'thinking', statusText: '💭 收到指令，深度思考中...' };
  }

  if (status !== 'DONE' || (lastStep.thinking && ageMs <= 15000)) {
    return { mtimeMs, state: 'thinking', statusText: '💭 正在推演方案...' };
  }

  return { mtimeMs, state: 'sleeping', statusText: '💤 空闲小憩中' };
}

/**
 * Polls `bridge/agent-monitor.mjs` (`127.0.0.1:17580/api/agents`) with automatic
 * fallback to direct `~/.gemini/antigravity/brain` scanning.
 */
// Identifies this IDE window to the bridge (stage tab requests go to the most recently focused window).
const IDE_INSTANCE_ID = String(vscode.env.sessionId || `win-${process.pid}-${Date.now()}`);
let ideLastFocusedAt = 0;
// IDE main process (VSCODE_PID) + its executable name, so the bridge can exit when the IDE closes.
const IDE_HOST_PID = (() => {
  const envPid = Number(process.env.VSCODE_PID);
  if (Number.isInteger(envPid) && envPid > 0) return envPid;
  return typeof process.ppid === 'number' && process.ppid > 0 ? process.ppid : 0;
})();
const IDE_HOST_EXE = path.basename(String(process.execPath || '')).toLowerCase();
const EXT_HOST_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);

class AgentMonitorClient {
  constructor() {
    this.snapshot = {
      ok: true,
      bridgeConnected: false,
      updatedAt: new Date().toISOString(),
      summary: { total: 0, thinking: 0, working: 0, sleeping: 0, celebrating: 0, error: 0 },
      agents: []
    };
    this.localOverrides = new Map();
    this.listeners = new Set();
    this.timer = null;
  }

  onDidUpdate(fn) {
    this.listeners.add(fn);
    return new vscode.Disposable(() => this.listeners.delete(fn));
  }

  getBridgeUrl() {
    const raw = vscode.workspace.getConfiguration('pokemonTheme').get('bridgeUrl') || 'http://127.0.0.1:17580';
    return String(raw).replace(/\/+$/, '');
  }

  start() {
    this.stop();
    this.poll();
    const interval = Math.max(
      400,
      Number(vscode.workspace.getConfiguration('pokemonTheme').get('pollIntervalMs')) || 800
    );
    this.timer = setInterval(() => this.poll(), interval);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async simulate(payload) {
    const bridgeUrl = this.getBridgeUrl();
    try {
      await httpRequestJson(`${bridgeUrl}/api/simulate`, 'POST', payload, 1200);
    } catch (_) {
      // Apply local override when bridge is offline
      if (payload && payload.action === 'reset' && !payload.id) {
        this.localOverrides.clear();
      } else if (payload && (payload.id || payload.name)) {
        const key = payload.id || payload.name;
        if (payload.action === 'reset' || payload.state === 'auto') {
          this.localOverrides.delete(key);
        } else {
          this.localOverrides.set(key, {
            ...payload,
            expiresAt: Date.now() + (payload.ttlMs || 60000)
          });
        }
      }
    }
    await this.poll();
  }

  async focusSession(payload) {
    const bridgeUrl = this.getBridgeUrl();
    try {
      return await httpRequestJson(
        `${bridgeUrl}/api/focus-session`,
        'POST',
        { ...(payload || {}), source: 'vscode-webview' },
        1500
      );
    } catch (_) {
      return { ok: false };
    }
  }

  async syncTheme(skinKey) {
    const bridgeUrl = this.getBridgeUrl();
    const bridgeTheme = skinKey === 'pokedex-light' ? 'rotom-light' : skinKey || 'mewtwo';
    try {
      await httpRequestJson(
        `${bridgeUrl}/api/theme`,
        'POST',
        { theme: bridgeTheme, source: 'vscode-extension' },
        1200
      );
    } catch (_) {}
  }

  async summonOverlay(payload = {}) {
    const bridgeUrl = this.getBridgeUrl();
    const skinKey = payload.theme || getCurrentSkinKey();
    const bridgeTheme = skinKey === 'pokedex-light' ? 'rotom-light' : skinKey || 'mewtwo';
    try {
      return await httpRequestJson(
        `${bridgeUrl}/api/summon-overlay`,
        'POST',
        {
          ...payload,
          theme: bridgeTheme,
          source: payload.source || 'vscode-extension'
        },
        1500
      );
    } catch (_) {
      return { ok: false };
    }
  }

  async poll() {
    const bridgeUrl = this.getBridgeUrl();
    let rawQueues = [];
    let bridgeConnected = false;
    let swarmTitle = '';
    let activeTheme = '';
    let lastFocusRequest = null;
    let summonRequestedAt = null;
    let openStageRequestedAt = null;

    const normalizeAgentItem = (a, isLead, convId, convTitle, projName, wsPath, winId, qIdx, rowIdx) => {
      const st = STATE_META[a?.state] ? a.state : 'sleeping';
      const modelStr = a?.model || '';
      return {
        id: a?.id || a?.name || `${convId}-${qIdx}`,
        name: a?.name || a?.id || 'agent',
        role: a?.role || (isLead ? 'main-agent' : 'worker'),
        isLead: Boolean(isLead),
        queueIndex: qIdx,
        rowIndex: rowIdx,
        conversationId: convId,
        conversationTitle: convTitle,
        projectName: projName,
        workspacePath: wsPath || a?.workspacePath || '',
        windowId: winId || a?.windowId || '',
        model: modelStr,
        state: st,
        statusText: a?.statusText || STATE_META[st]?.cn || '',
        idleMs: st === 'sleeping' ? Number(a?.idleMs || 0) : 0,
        lastActiveAt: a?.lastActiveAt || new Date().toISOString(),
        pokemonSpecies: a?.pokemonSpecies && (!SPECIES_LIST.length || SPECIES_LIST.includes(a.pokemonSpecies))
          ? a.pokemonSpecies
          : assignSpeciesForAgent(a?.name, a?.role),
        context: normalizeAgentContextObj(a?.context || a, modelStr),
        source: a?.source || 'bridge'
      };
    };

    try {
      if (vscode.window.state.focused) ideLastFocusedAt = Date.now();
      // Window identity for the bridge's IDE-bound session: open project folders, IDE main pid + exe,
      // and when this window's extension host started (≈ window open time).
      const folders = (vscode.workspace.workspaceFolders || [])
        .map((f) => (f.uri && f.uri.scheme === 'file' ? f.uri.fsPath : ''))
        .filter(Boolean)
        .join('|');
      const q =
        `client=ide-extension&instance=${encodeURIComponent(IDE_INSTANCE_ID)}&focusedAt=${ideLastFocusedAt}` +
        `&ws=${encodeURIComponent(String(vscode.workspace.name || ''))}` +
        `&folders=${encodeURIComponent(folders)}&hostPid=${IDE_HOST_PID}` +
        `&host=${encodeURIComponent(IDE_HOST_EXE)}&startedAt=${EXT_HOST_STARTED_AT}`;
      const data = await httpRequestJson(`${bridgeUrl}/api/agents?${q}`, 'GET', null, 1100);
      // Only the IDE window the bridge picked (most recently focused) opens the stage tab.
      openStageRequestedAt =
        data && data.openStageRequestedAt && data.openStageTarget === IDE_INSTANCE_ID
          ? Number(data.openStageRequestedAt) || null
          : null;
      if (data && (Array.isArray(data.projects) || Array.isArray(data.queues) || Array.isArray(data.agents))) {
        bridgeConnected = true;
        swarmTitle = data.swarmTitle || '';
        activeTheme = data.activeTheme || '';
        const sig = data.pack ? `${data.pack.id}@${data.pack.version}` : '';
        if (sig && sig !== packSig) refreshPackDescriptor(bridgeUrl);
        lastFocusRequest = data.lastFocusRequest || data.latestFocusCommand || null;
        summonRequestedAt = data.summonRequestedAt !== undefined ? data.summonRequestedAt : null;
        if (Array.isArray(data.projects)) {
          for (const p of data.projects) {
            for (const q of p.queues || []) {
              rawQueues.push({
                ...q,
                projectName: q.projectName || p.projectName || '全局会话',
                workspacePath: q.workspacePath || p.workspacePath || ''
              });
            }
          }
        } else if (Array.isArray(data.queues)) {
          rawQueues = data.queues;
        } else if (Array.isArray(data.agents) && data.agents.length > 0) {
          rawQueues = [{
            conversationId: data.activeSessionId || 'bridge-session',
            conversationTitle: data.swarmTitle || '当前活跃会话',
            projectName: '全局会话',
            leadAgent: data.agents[0],
            subagents: data.agents.slice(1)
          }];
        }
      }
    } catch (_) {
      bridgeConnected = false;
      rawQueues = scanBrainFallbackQueues();
    }

    // Apply local overrides + enforce 60s subagent idle removal & leadAgent keep-alive
    const now = Date.now();
    for (const [k, ov] of this.localOverrides.entries()) {
      if (ov.expiresAt && ov.expiresAt < now) {
        this.localOverrides.delete(k);
        continue;
      }
      let matched = null;
      for (const q of rawQueues) {
        if (q.leadAgent && (q.leadAgent.id === k || q.leadAgent.name === k)) matched = q.leadAgent;
        for (const s of q.subagents || []) {
          if (s.id === k || s.name === k) matched = s;
        }
      }
      if (matched) {
        if (ov.state && STATE_META[ov.state]) {
          matched.state = ov.state;
          if (ov.state !== 'sleeping') matched.idleMs = 0;
        }
        if (ov.statusText) matched.statusText = ov.statusText;
        if (ov.pokemonSpecies && SPECIES_LIST.includes(ov.pokemonSpecies)) {
          matched.pokemonSpecies = ov.pokemonSpecies;
        }
      } else if (ov.name || ov.id) {
        if (rawQueues.length === 0) rawQueues = scanBrainFallbackQueues();
        rawQueues[0].subagents = rawQueues[0].subagents || [];
        rawQueues[0].subagents.push({
          id: ov.id || ov.name,
          name: ov.name || ov.id,
          role: 'simulated',
          model: 'simulator',
          state: STATE_META[ov.state] ? ov.state : 'working',
          statusText: ov.statusText || '⚡ 模拟招式演练中！',
          idleMs: 0,
          lastActiveAt: new Date(now).toISOString(),
          pokemonSpecies: SPECIES_LIST.includes(ov.pokemonSpecies) ? ov.pokemonSpecies : SPECIES_LIST[0] || '',
          source: 'simulated'
        });
      }
    }

    const projectsMap = new Map();
    const projects = [];
    const queues = [];
    const agents = [];

    for (let i = 0; i < rawQueues.length; i++) {
      const rq = rawQueues[i];
      const convId = rq.conversationId || `conv-${i + 1}`;
      const projName = rq.projectName || '全局会话';
      const convTitle = rq.conversationTitle || rq.headerTitle || rq.swarmTitle || '当前智能体会话';
      const wsPath = rq.workspacePath || '';
      const winId = rq.windowId || '';
      const rowIdx = queues.length;

      const keptSubs = [];
      for (const rs of rq.subagents || []) {
        if (!rs || rs.state === 'killed') continue;
        const sIdle = rs.state === 'sleeping' ? Number(rs.idleMs || 0) : 0;
        if (rs.state === 'sleeping' && sIdle > SUBAGENT_IDLE_TTL_MS) continue;
        keptSubs.push(normalizeAgentItem(rs, false, convId, convTitle, projName, wsPath, winId, keptSubs.length + 1, rowIdx));
      }

      const lead = normalizeAgentItem(
        rq.leadAgent || { id: `${convId}:lead`, name: 'coordinator', role: 'coordinator', state: 'sleeping' },
        true,
        convId,
        convTitle,
        projName,
        wsPath,
        winId,
        0,
        rowIdx
      );
      const hasActiveSubagent = keptSubs.some((s) => s.state !== 'sleeping');

      const normQ = {
        rowIndex: rowIdx,
        conversationId: convId,
        conversationTitle: convTitle,
        projectName: projName,
        workspacePath: wsPath,
        windowId: winId,
        hasActiveSubagent,
        leadAgent: lead,
        subagents: keptSubs
      };
      queues.push(normQ);
      agents.push(lead, ...keptSubs);

      if (!projectsMap.has(projName)) {
        const grp = { projectId: projName.toLowerCase(), projectName: projName, queues: [] };
        projectsMap.set(projName, grp);
        projects.push(grp);
      }
      projectsMap.get(projName).queues.push(normQ);
    }

    const summary = {
      projectCount: projects.length,
      queueCount: queues.length,
      total: agents.length,
      thinking: 0,
      working: 0,
      sleeping: 0,
      celebrating: 0,
      error: 0
    };
    for (const a of agents) {
      if (typeof summary[a.state] === 'number') {
        summary[a.state]++;
      } else {
        summary.sleeping++;
      }
    }

    this.snapshot = {
      ok: true,
      version: '4.1.0',
      mode: 'single-shared-overlay',
      bridgeConnected,
      bridgeUrl,
      swarmTitle,
      activeTheme,
      lastFocusRequest,
      summonRequestedAt,
      openStageRequestedAt,
      updatedAt: new Date().toISOString(),
      summary,
      projects,
      queues,
      agents
    };

    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch (_) {}
    }

    return this.snapshot;
  }
}

/**
 * Detect current skin key from active VS Code workbench.colorTheme
 */
function getCurrentSkinKey() {
  const currentTheme = String(vscode.workspace.getConfiguration('workbench').get('colorTheme') || '');
  const found = findThemeEntry(currentTheme);
  if (found) return found.skin;
  if (currentTheme.includes('耿鬼') || currentTheme.toLowerCase().includes('gengar')) return 'gengar';
  if (currentTheme.includes('喷火龙') || currentTheme.toLowerCase().includes('charizard')) return 'charizard';
  if (currentTheme.includes('月亮伊布') || currentTheme.toLowerCase().includes('umbreon')) return 'umbreon';
  if (currentTheme.includes('超梦') || currentTheme.toLowerCase().includes('mewtwo')) return 'mewtwo';
  if (currentTheme.includes('洛托姆') || currentTheme.toLowerCase().includes('light')) return 'pokedex-light';
  return 'pikachu';
}

/**
 * Shared HTML generator for both Sidebar WebviewView (`pokemonPetSidebar`)
 * and Floating Pet Arena WebviewPanel (`pokemonTheme.openPetArena`).
 */
function buildPetArenaWebviewHtml(webview, context, suiteRoot, mode = 'arena') {
  const nonce = String(Date.now()) + Math.random().toString(36).slice(2, 10);

  const skinCssFile = path.join(suiteRoot, 'theme-css', 'antigravity-pokemon-skin.css');
  const spritesCssFile = path.join(suiteRoot, 'assets', 'pet-sprites.css');
  const spritesJsFile = path.join(suiteRoot, 'assets', 'pet-sprites.js');

  const skinCssUri = fs.existsSync(skinCssFile) ? webview.asWebviewUri(vscode.Uri.file(skinCssFile)) : null;
  const spritesCssUri = fs.existsSync(spritesCssFile) ? webview.asWebviewUri(vscode.Uri.file(spritesCssFile)) : null;
  const spritesJsUri = fs.existsSync(spritesJsFile) ? webview.asWebviewUri(vscode.Uri.file(spritesJsFile)) : null;

  // Sprite URLs of the active skin pack, served by the bridge (empty until the pack descriptor arrives).
  const officialSpriteUris = {};
  const speciesNames = {};
  const packBridge = packDescriptor ? packDescriptor.bridgeUrl : '';
  if (packDescriptor) {
    const styles = packDescriptor.styles || [];
    const pixelStyle = (styles.find((st) => st.pixelated) || {}).id || packDescriptor.defaultStyle;
    const pick = (c, styleId) => {
      const a = c.assets[styleId] || c.assets[packDescriptor.defaultStyle] || {};
      const rel = a.gif || (a.frameUrls && a.frameUrls[0]) || c.artwork || '';
      return rel ? packBridge + rel : '';
    };
    for (const c of packDescriptor.creatures) {
      officialSpriteUris[c.id] = {
        showdown: pick(c, packDescriptor.defaultStyle),
        pixel: pick(c, pixelStyle),
        artwork: c.artwork ? packBridge + c.artwork : pick(c, packDescriptor.defaultStyle)
      };
      speciesNames[c.id] = c.name;
    }
  }

  const webviewPack = packDescriptor
    ? { id: packDescriptor.id, name: packDescriptor.name, version: packDescriptor.version, defaultStyle: packDescriptor.defaultStyle, styles: packDescriptor.styles, creatures: packDescriptor.creatures }
    : null;
  // `<` escaped so pack text can never close the inline <script>.
  const webviewPackJson = JSON.stringify(webviewPack).replace(/</g, '\\u003c');
  const initialSkin = getCurrentSkinKey();
  const cfg = vscode.workspace.getConfiguration('pokemonTheme');
  const initialSpriteMode =
    cfg.get('spriteStyle') === 'authentic-pixel' ? 'authentic-pixel' : 'authentic-showdown';
  const isCompact = mode === 'sidebar';

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:${packBridge ? ' ' + packBridge : ''}`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource} 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="zh-CN" data-pokemon-theme="${initialSkin}" data-sprite-mode="${initialSpriteMode}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>智能体桌宠</title>
  ${skinCssUri ? `<link rel="stylesheet" href="${skinCssUri}" />` : ''}
  ${spritesCssUri ? `<link rel="stylesheet" href="${spritesCssUri}" />` : ''}
  <style>
    html, body {
      margin: 0;
      padding: 0;
      min-height: 100vh;
    }
    body.pkmn-skin-root {
      padding: ${isCompact ? '10px' : '16px'};
      overflow-x: hidden;
    }
    .arena-layout {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-width: 1120px;
      margin: 0 auto;
    }
    .header-title {
      font-size: ${isCompact ? '13.5px' : '16px'};
      font-weight: 800;
      margin: 0;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .header-sub {
      font-size: 11px;
      color: var(--pkmn-text-muted, #94a3b8);
      margin-top: 2px;
    }
    .pet-playground {
      min-height: ${isCompact ? '250px' : '360px'};
      height: ${isCompact ? '265px' : '390px'};
      position: relative;
      border-radius: 16px;
    }
    .stage-toolbar {
      position: absolute;
      top: 8px;
      left: 10px;
      right: 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      z-index: 20;
      pointer-events: none;
    }
    .stage-toolbar > * {
      pointer-events: auto;
    }
    .stage-hint {
      position: absolute;
      bottom: 7px;
      right: 10px;
      font-size: 10.5px;
      opacity: 0.72;
      pointer-events: none;
      z-index: 5;
    }
    .draggable-pet-slot {
      position: absolute;
      left: 24px;
      top: 48px;
      touch-action: none;
      user-select: none;
      cursor: grab;
      z-index: 10;
      transition: box-shadow 0.15s ease;
    }
    .draggable-pet-slot.is-dragging {
      cursor: grabbing;
      z-index: 99;
    }
    .action-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(${isCompact ? '125px' : '170px'}, 1fr));
      gap: 8px;
    }
    .roster-list {
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .queue-member-card {
      min-width: ${isCompact ? '185px' : '225px'};
      flex-shrink: 0;
    }
    .lead-click-head {
      cursor: pointer;
    }
    .lead-crown-pill {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      font-size: 10px;
      font-weight: 900;
      padding: 1px 6px;
      border-radius: 999px;
      background: linear-gradient(135deg, #facc15, #f59e0b);
      color: #1e1b4b;
    }
    .agent-card-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      margin-bottom: 6px;
    }
    .agent-name {
      font-weight: 800;
      font-size: 12.5px;
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    .agent-status-line {
      font-size: 11.5px;
      color: var(--pkmn-text-secondary, #cbd5e1);
      margin-bottom: 8px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .agent-controls {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px;
    }
    .mini-select, .mini-btn {
      font-size: 11px;
      padding: 3px 7px;
      border-radius: 7px;
      background: var(--pkmn-bg-deep, #0d111c);
      color: var(--pkmn-text-primary, #f8fafc);
      border: 1px solid var(--pkmn-border, rgba(255,212,59,0.28));
      cursor: pointer;
    }
    .mini-btn:hover, .mini-select:hover {
      border-color: var(--pkmn-accent-primary, #ffd43b);
    }
    .toast-msg {
      font-size: 11.5px;
      font-weight: 700;
      padding: 7px 11px;
      border-radius: 10px;
      background: var(--pkmn-accent-soft, rgba(255,212,59,0.15));
      border: 1px solid var(--pkmn-border-strong, #ffd43b);
      display: none;
    }
    .toast-msg.visible {
      display: block;
    }
    /* Authentic original animated Pokémon card if PokemonPets controller hasn't mounted */
    .fallback-pet {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 6px 10px;
      border-radius: 14px;
      background: rgba(15, 23, 42, 0.68);
      border: 1px solid var(--pkmn-border-strong, #ffd43b);
    }
    .fallback-pet-sprite {
      width: 72px;
      height: 72px;
      object-fit: contain;
      pointer-events: none;
      filter: drop-shadow(0 5px 10px rgba(0, 0, 0, 0.45));
    }
    html[data-sprite-mode="authentic-pixel"] .fallback-pet-sprite,
    html[data-sprite-mode="authentic-pixel"] .pk-pet-gif,
    html[data-sprite-mode="authentic-pixel"] .pk-pet-authentic-img {
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    .fallback-pet-name {
      font-size: 11px;
      font-weight: 700;
      margin-top: 3px;
    }
    /* v4.1 Stage & Roster Circular Context (Red) + Cache Hit (Green) Rings */
    .stage-ctx-ring-overlay {
      position: absolute;
      left: 50%;
      top: 52%;
      width: ${isCompact ? '76px' : '88px'};
      height: ${isCompact ? '76px' : '88px'};
      transform: translate(-50%, -50%) rotate(-90deg);
      pointer-events: none;
      z-index: 4;
      overflow: visible;
    }
    .stage-ctx-pill {
      position: absolute;
      left: 50%;
      bottom: -8px;
      transform: translateX(-50%);
      z-index: 6;
      pointer-events: none;
      font-size: 9px;
      padding: 1px 5px;
    }
    .member-card-avatar-row {
      display: flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 6px;
    }
    .member-avatar-ring {
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: rgba(15, 23, 42, 0.46);
    }
    .member-avatar-img {
      position: relative;
      z-index: 1;
      width: 28px;
      height: 28px;
      object-fit: contain;
    }
  </style>
</head>
<body class="pkmn-skin-root">
  <div class="arena-layout">
    <div class="pkmn-rotom-frame">
      <div class="pkmn-rotom-header">
        <div style="display:flex;align-items:center;gap:10px;">
          <div class="pkmn-led-orb" title="实时感应器"></div>
          <div>
            <h1 class="header-title">
              ⚡ 智能体桌宠
              <span id="conn-badge" class="pkmn-badge pkmn-badge--pixel">扫描中</span>
            </h1>
            <div id="summary-line" class="header-sub">正在连接智能体状态监控桥接器...</div>
          </div>
        </div>
        <div class="pkmn-led-cluster">
          <span class="pkmn-led-dot pkmn-led-dot--red"></span>
          <span class="pkmn-led-dot pkmn-led-dot--yellow"></span>
          <span class="pkmn-led-dot pkmn-led-dot--green"></span>
        </div>
      </div>

      <div style="padding:${isCompact ? '10px' : '14px'};display:flex;flex-direction:column;gap:12px;">
        <div id="toast" class="toast-msg"></div>
        <div id="session-title-banner" class="pkmn-session-title-banner" style="display:none;">
          <div style="min-width:0;">
            <div id="session-banner-main" style="font-weight:800;word-break:break-word;"></div>
            <div id="session-banner-sub" style="font-size:10.5px;opacity:0.84;margin-top:2px;"></div>
          </div>
          <button id="session-banner-close" class="mini-btn" title="关闭会话名称提示">×</button>
        </div>

        <!-- Draggable Floating Pokémon Stage -->
        <div id="pet-stage" class="pkmn-pet-stage pet-playground">
          <div class="stage-toolbar">
            <span class="pkmn-badge" id="active-count-pill">🐾 0 只伙伴在场</span>
            <div style="display:flex;flex-wrap:wrap;gap:5px;justify-content:flex-end;">
              <button id="btn-sprite-style" class="mini-btn" title="切换高清 / 像素画风">
                ${initialSpriteMode === 'authentic-pixel' ? '👾 画风: 像素' : '✨ 画风: 高清'}
              </button>
              <button id="btn-lineup" class="mini-btn" title="按项目会话列队整齐归位（排头为👑主宠）">📏 列队归位</button>
              <button id="btn-wander" class="mini-btn" title="开启/暂停宠物自由漫步">🐾 漫步: 停</button>
              <button id="btn-spawn-demo" class="mini-btn" title="召唤一只演练伙伴测试互动">➕ 召唤测试宠</button>
            </div>
          </div>
          <div class="stage-hint">💡 👑排头领队：单击查看会话名 · 双击弹起对应项目与会话 · 所有窗口共用唯一桌面浮窗</div>
        </div>

        <!-- OS Desktop Pet & Full App Global Skin Quick Launchers -->
        <div class="action-grid">
          <button id="btn-launch-os-pet" class="pkmn-btn pkmn-btn--primary">
            🪟 召唤全局唯一共享桌宠浮窗
          </button>
          <button id="btn-apply-global-skin" class="pkmn-btn">
            ✨ 开启全反重力界面皮肤
          </button>
          ${
            isCompact
              ? `<button id="btn-open-arena" class="pkmn-btn">🏟️ 打开大屏悬浮宠物乐园</button>`
              : `<button id="btn-start-bridge" class="pkmn-btn">🛰️ 启动/重连 17580 监控桥</button>`
          }
          <button id="btn-reset-sim" class="pkmn-btn">
            🔄 恢复全部实时状态同步
          </button>
        </div>

        <!-- 5 Theme Switcher -->
        <div class="pkmn-glass-card">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
            <span style="font-size:12px;font-weight:800;">🎨 一键切换 IDE 代码与图鉴皮肤</span>
            <span style="font-size:10.5px;opacity:0.75;">同步编辑器 + 桌宠舞台</span>
          </div>
          <div id="theme-chips" class="pkmn-theme-switcher">
            ${POKEMON_THEMES.map(
              (t) => `
              <button class="pkmn-theme-chip ${t.skin === initialSkin ? 'is-active' : ''}"
                      data-skin="${t.skin}"
                      data-label="${t.label}"
                      title="${t.desc}">
                ${t.shortName}
              </button>`
            ).join('')}
          </div>
        </div>

        <!-- Live Project-Grouped Session Queue Roster -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;">
            <span style="font-size:12px;font-weight:800;">📡 项目分组 · 会话列队实时图鉴（👑 单击看会话 · 双击弹起项目与会话）</span>
            <button id="btn-refresh" class="mini-btn">刷新 ⚡</button>
          </div>
          <div id="roster-list" class="roster-list"></div>
        </div>
      </div>
    </div>
  </div>

  ${spritesJsUri ? `<script nonce="${nonce}" src="${spritesJsUri}"></script>` : ''}
  <script nonce="${nonce}">
    (function () {
      const vscode = acquireVsCodeApi();
      const stageEl = document.getElementById('pet-stage');
      const rosterEl = document.getElementById('roster-list');
      const summaryEl = document.getElementById('summary-line');
      const connBadgeEl = document.getElementById('conn-badge');
      const activeCountEl = document.getElementById('active-count-pill');
      const toastEl = document.getElementById('toast');
      const wanderBtn = document.getElementById('btn-wander');
      const spriteStyleBtn = document.getElementById('btn-sprite-style');

      const sessionBannerEl = document.getElementById('session-title-banner');
      const sessionBannerMainEl = document.getElementById('session-banner-main');
      const sessionBannerSubEl = document.getElementById('session-banner-sub');
      const sessionBannerCloseBtn = document.getElementById('session-banner-close');
      let activeBannerConvId = '';
      let bannerTimer = null;

      function hideSessionBanner() {
        activeBannerConvId = '';
        if (bannerTimer) {
          clearTimeout(bannerTimer);
          bannerTimer = null;
        }
        if (sessionBannerEl) sessionBannerEl.style.display = 'none';
      }

      function toggleSessionTitleBanner(convId, convTitle, projName) {
        if (!sessionBannerEl) return;
        if (activeBannerConvId === convId && sessionBannerEl.style.display !== 'none') {
          hideSessionBanner();
          return;
        }
        activeBannerConvId = convId || 'current';
        sessionBannerMainEl.textContent = '💬 当前会话：' + (convTitle || '当前智能体会话');
        sessionBannerSubEl.textContent = '📁 所属项目：' + (projName || '全局会话') + ' · 💡 双击领队自动弹起对应项目与会话';
        sessionBannerEl.style.display = 'flex';
        if (bannerTimer) clearTimeout(bannerTimer);
        bannerTimer = setTimeout(() => hideSessionBanner(), 6000);
      }

      function requestFocusSessionFromLead(meta) {
        if (!meta) return;
        hideSessionBanner();
        vscode.postMessage({
          type: 'focusSession',
          payload: {
            conversationId: meta.conversationId || '',
            conversationTitle: meta.conversationTitle || '',
            projectName: meta.projectName || '',
            workspacePath: meta.workspacePath || '',
            windowId: meta.windowId || ''
          }
        });
        showToast('🚀 正在弹起项目与会话：' + (meta.conversationTitle || '当前智能体会话') + '（📁 ' + (meta.projectName || '全局会话') + '）');
      }

      if (sessionBannerCloseBtn) {
        sessionBannerCloseBtn.addEventListener('click', () => hideSessionBanner());
      }

      const OFFICIAL_URIS = ${JSON.stringify(officialSpriteUris)};
      if (window.PetSprites) window.PetSprites.setPack(${webviewPackJson}, { assetBase: ${JSON.stringify(packBridge)} });
      let currentSpriteMode = ${JSON.stringify(initialSpriteMode)};
      const petActors = new Map(); // id -> { slotEl, controller, x, y, vx, vy, dragging, manuallyPlaced, agent, rowIdx, colIdx, rowTotal, totalRows }
      let wanderEnabled = false;
      let latestAgents = [];

      // Arrange pets into horizontal session rows: Column 0 = 👑 leadAgent (leftmost), Columns 1..N = subagents
      function computeQueueSlotPosition(rowIdx, totalRows, colIdx, rowTotal) {
        const rect = stageEl.getBoundingClientRect();
        const stageW = Math.max(280, rect.width || 420);
        const stageH = Math.max(220, rect.height || 280);
        const petW = ${isCompact ? 94 : 112};
        const bottomBaselineY = Math.max(46, stageH - ${isCompact ? 136 : 152});
        const rowGap = totalRows <= 1 ? 0 : Math.min(92, Math.max(54, Math.floor((bottomBaselineY - 42) / Math.max(1, totalRows - 1))));
        const rowY = Math.max(38, bottomBaselineY - rowIdx * rowGap);
        const count = Math.max(1, rowTotal);
        const usableW = Math.max(petW, stageW - 24);
        const stride = count <= 1 ? 0 : Math.min(petW + 10, Math.max(54, (usableW - petW) / (count - 1)));
        const startX = 14;
        return clampPosition(Math.round(startX + colIdx * stride), rowY);
      }

      function lineupStagePetsSideBySide(resetManual) {
        petActors.forEach((entry) => {
          if (entry.dragging) return;
          if (resetManual) entry.manuallyPlaced = false;
          if (!entry.manuallyPlaced) {
            const pos = computeQueueSlotPosition(
              entry.rowIdx || 0,
              entry.totalRows || 1,
              entry.colIdx || 0,
              entry.rowTotal || 1
            );
            entry.x = pos.x;
            entry.y = pos.y;
            entry.slotEl.style.transform = 'translate3d(' + entry.x + 'px, ' + entry.y + 'px, 0)';
          }
        });
      }

      function getAuthenticSpriteSrc(species, mode) {
        const sp = OFFICIAL_URIS[species] ? species : Object.keys(OFFICIAL_URIS)[0];
        const pack = OFFICIAL_URIS[sp];
        if (!pack) return '';
        return mode === 'authentic-pixel' ? pack.pixel : pack.showdown;
      }

      const SPECIES_CN = ${JSON.stringify(speciesNames)};

      const STATE_BADGE = {
        thinking: { cls: 'is-thinking', text: '💭 Thinking 思考中' },
        working: { cls: 'is-working', text: '⚡ Working 工作中' },
        sleeping: { cls: 'is-sleeping', text: '💤 Sleeping 休眠中' },
        celebrating: { cls: 'is-celebrating', text: '✨ Celebrating 欢呼' },
        error: { cls: 'is-error', text: '💫 Error 异常' }
      };

      function showToast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add('visible');
        clearTimeout(showToast._t);
        showToast._t = setTimeout(() => toastEl.classList.remove('visible'), 2800);
      }

      function clampPosition(x, y) {
        const rect = stageEl.getBoundingClientRect();
        const maxX = Math.max(16, (rect.width || 320) - 132);
        const maxY = Math.max(38, (rect.height || 250) - 138);
        return {
          x: Math.max(8, Math.min(maxX, x)),
          y: Math.max(34, Math.min(maxY, y))
        };
      }

      function createFallbackMarkup(agent) {
        const st = STATE_BADGE[agent.state] || STATE_BADGE.sleeping;
        const src = getAuthenticSpriteSrc(agent.pokemonSpecies, currentSpriteMode);
        const artFallback = (OFFICIAL_URIS[agent.pokemonSpecies] || OFFICIAL_URIS[Object.keys(OFFICIAL_URIS)[0]] || {}).artwork || '';
        const prefix = agent.isLead ? '👑 ' : '';
        return '<div class="fallback-pet">' +
          '<div class="pkmn-state-pill ' + st.cls + '" style="margin-bottom:4px;">' + st.text + '</div>' +
          '<img class="fallback-pet-sprite pkmn-authentic-sprite" src="' + escapeHtml(src) + '" data-fallback="' + escapeHtml(artFallback) + '" alt="' + escapeHtml(agent.name) + '" />' +
          '<div class="fallback-pet-name">' + prefix + escapeHtml(agent.name) + '</div>' +
        '</div>';
      }

      // Sync authentic animated Pokémon sprite style ("authentic-showdown" | "authentic-pixel")
      function syncEntryAuthenticSprite(entry) {
        if (!entry) return;
        const c = entry.controller;
        if (c) {
          if (typeof c.setSpriteMode === 'function' && entry.lastAppliedMode !== currentSpriteMode) {
            c.setSpriteMode(currentSpriteMode);
          }
          entry.lastAppliedMode = currentSpriteMode;
        } else {
          entry.slotEl.innerHTML = createFallbackMarkup(entry.agent);
        }
      }

      function escapeHtml(str) {
        return String(str || '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;');
      }

      function fmtTok(n) {
        const v = Math.max(0, Math.round(Number(n) || 0));
        if (v >= 1000000) return (Math.round((v / 1000000) * 10) / 10).toString().replace(/\.0$/, '') + 'M';
        if (v >= 100000) return Math.round(v / 1000) + 'k';
        if (v >= 1000) return (Math.round((v / 1000) * 10) / 10).toString().replace(/\.0$/, '') + 'k';
        return String(v);
      }

      function getAgentCtx(agent) {
        const c = (agent && agent.context && typeof agent.context === 'object') ? agent.context : {};
        const maxTokens = Math.max(1, Number(c.maxTokens || 200000));
        const usedTokens = Math.max(0, Math.round(Number(c.usedTokens) || 0));
        const usedPct = typeof c.usedPct === 'number' && isFinite(c.usedPct)
          ? Math.max(0, Math.min(100, c.usedPct))
          : Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100));
        const cachedTokens = Math.max(0, Math.round(Number(c.cachedTokens) || 0));
        const cacheHitPct = typeof c.cacheHitPct === 'number' && isFinite(c.cacheHitPct)
          ? Math.max(0, Math.min(100, c.cacheHitPct))
          : (usedTokens > 0 ? Math.max(0, Math.min(100, (cachedTokens / usedTokens) * 100)) : 0);
        const tooltipText = c.tooltipText || (
          '🔴 已用上下文: ' + fmtTok(usedTokens) + ' / ' + fmtTok(maxTokens) +
          ' (' + Math.round(usedPct) + '%) | 🟢 缓存命中: ' + Math.round(cacheHitPct) + '% (' + fmtTok(cachedTokens) + ')'
        );
        return { usedTokens, maxTokens, usedPct, cachedTokens, cacheHitPct, tooltipText };
      }

      function buildConcentricRingSvgMarkup(ctx, svgClass, strokeWRed, strokeWGreen) {
        const rRed = 21.5;
        const cRed = 2 * Math.PI * rRed;
        const rGreen = 18.0;
        const cGreen = 2 * Math.PI * rGreen;
        const effRed = (ctx.usedPct > 0 || ctx.usedTokens > 0) ? Math.max(2.5, Math.min(100, ctx.usedPct)) : 0;
        const effGreen = (ctx.cacheHitPct > 0 || ctx.cachedTokens > 0) ? Math.max(2.5, Math.min(100, ctx.cacheHitPct)) : 0;
        const offRed = (cRed * (1 - effRed / 100)).toFixed(2);
        const offGreen = (cGreen * (1 - effGreen / 100)).toFixed(2);
        return (
          '<svg viewBox="0 0 48 48" class="' + svgClass + '" aria-hidden="true">' +
            '<circle class="pkmn-ctx-track-red" cx="24" cy="24" r="' + rRed + '" stroke-width="' + strokeWRed + '"></circle>' +
            '<circle class="pkmn-ctx-bar-red" cx="24" cy="24" r="' + rRed + '" stroke-width="' + strokeWRed + '" stroke-dasharray="' + cRed.toFixed(2) + '" stroke-dashoffset="' + offRed + '"></circle>' +
            '<circle class="pkmn-ctx-track-green" cx="24" cy="24" r="' + rGreen + '" stroke-width="' + strokeWGreen + '"></circle>' +
            '<circle class="pkmn-ctx-bar-green" cx="24" cy="24" r="' + rGreen + '" stroke-width="' + strokeWGreen + '" stroke-dasharray="' + cGreen.toFixed(2) + '" stroke-dashoffset="' + offGreen + '"></circle>' +
          '</svg>'
        );
      }

      function updateStageEntryContextRing(entry) {
        if (!entry || !entry.slotEl) return;
        const ctx = getAgentCtx(entry.agent);
        let wrap = entry.slotEl.querySelector('.js-stage-ctx-wrap');
        if (!wrap) {
          wrap = document.createElement('div');
          wrap.className = 'js-stage-ctx-wrap';
          wrap.style.pointerEvents = 'none';
          entry.slotEl.appendChild(wrap);
        }
        entry.slotEl.title = (entry.agent.isLead ? '👑 ' : '🐾 ') + entry.agent.name + ' | ' + ctx.tooltipText;
        wrap.innerHTML =
          buildConcentricRingSvgMarkup(ctx, 'stage-ctx-ring-overlay', '2.4', '2.2') +
          '<div class="pkmn-ctx-micro-pill stage-ctx-pill">' +
            '<span class="pkmn-ctx-red-val">🔴' + Math.round(ctx.usedPct) + '%</span>' +
            '<span class="pkmn-ctx-green-val">🟢' + Math.round(ctx.cacheHitPct) + '%</span>' +
          '</div>';
      }

      function mountOrUpdateStagePet(agent, rowIdx, totalRows, colIdx, rowTotal) {
        let entry = petActors.get(agent.id);
        const displayName = (agent.isLead ? '👑 ' : '') + agent.name;

        if (!entry) {
          const slotEl = document.createElement('div');
          slotEl.className = 'draggable-pet-slot';
          slotEl.style.setProperty('--pk-pet-size', '${isCompact ? '112px' : '132px'}');

          const initPos = computeQueueSlotPosition(rowIdx, totalRows, colIdx, rowTotal);

          entry = {
            slotEl,
            controller: null,
            species: agent.pokemonSpecies,
            state: agent.state,
            x: initPos.x,
            y: initPos.y,
            rowIdx,
            totalRows,
            colIdx,
            rowTotal,
            vx: (Math.random() > 0.5 ? 1 : -1) * (0.28 + Math.random() * 0.25),
            vy: (Math.random() > 0.5 ? 1 : -1) * (0.16 + Math.random() * 0.18),
            dragging: false,
            manuallyPlaced: false,
            agent
          };

          slotEl.style.transform = 'translate3d(' + entry.x + 'px, ' + entry.y + 'px, 0)';
          stageEl.appendChild(slotEl);

          if (window.PokemonPets && typeof window.PokemonPets.mountPet === 'function') {
            entry.controller = window.PokemonPets.mountPet(slotEl, {
              species: agent.pokemonSpecies,
              shiny: Boolean(agent.shiny),
              state: agent.state,
              agentName: displayName,
              statusText: agent.statusText,
              spriteMode: currentSpriteMode,
              interactive: false,
              draggable: false
            });
            entry.lastAppliedMode = currentSpriteMode;
          } else {
            slotEl.innerHTML = createFallbackMarkup(agent);
          }

          bindPointerDrag(entry);
          updateStageEntryContextRing(entry);
          petActors.set(agent.id, entry);
        } else {
          entry.agent = agent;
          entry.rowIdx = rowIdx;
          entry.totalRows = totalRows;
          entry.colIdx = colIdx;
          entry.rowTotal = rowTotal;
          if (!entry.dragging) {
            if (entry.controller) {
              if (entry.species !== agent.pokemonSpecies && typeof entry.controller.setSpecies === 'function') {
                entry.species = agent.pokemonSpecies;
                entry.controller.setSpecies(agent.pokemonSpecies);
              }
              entry.state = agent.state;
              if (typeof entry.controller.setShiny === 'function') entry.controller.setShiny(Boolean(agent.shiny));
              if (typeof entry.controller.setState === 'function') {
                entry.controller.setState(agent.state, agent.statusText);
              }
              syncEntryAuthenticSprite(entry);
            } else {
              entry.slotEl.innerHTML = createFallbackMarkup(agent);
            }
            updateStageEntryContextRing(entry);
          }
        }
      }

      function bindPointerDrag(entry) {
        let startX = 0;
        let startY = 0;
        let originX = 0;
        let originY = 0;
        let moved = false;

        entry.slotEl.addEventListener('pointerdown', (ev) => {
          if (ev.button !== 0) return;
          ev.preventDefault();
          entry.slotEl.setPointerCapture(ev.pointerId);
          startX = ev.clientX;
          startY = ev.clientY;
          originX = entry.x;
          originY = entry.y;
          moved = false;
          entry.dragging = true;
          entry.slotEl.classList.add('is-dragging');
          if (entry.controller && typeof entry.controller.setDragging === 'function') {
            entry.controller.setDragging(true);
          }
        });

        entry.slotEl.addEventListener('pointermove', (ev) => {
          if (!entry.dragging) return;
          const dx = ev.clientX - startX;
          const dy = ev.clientY - startY;
          if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
          const next = clampPosition(originX + dx, originY + dy);
          entry.x = next.x;
          entry.y = next.y;
          entry.slotEl.style.transform = 'translate3d(' + entry.x + 'px, ' + entry.y + 'px, 0)';
        });

        const finishDrag = (ev) => {
          if (!entry.dragging) return;
          entry.dragging = false;
          entry.slotEl.classList.remove('is-dragging');
          try {
            entry.slotEl.releasePointerCapture(ev.pointerId);
          } catch (_) {}

          if (entry.controller && typeof entry.controller.setDragging === 'function') {
            entry.controller.setDragging(false);
            if (typeof entry.controller.setState === 'function') {
              entry.controller.setState(entry.agent.state, entry.agent.statusText);
            }
          }

          if (!moved) {
            if (entry.controller && typeof entry.controller.triggerPoke === 'function') {
              entry.controller.triggerPoke();
            }
            if (entry.agent.isLead) {
              const nowClick = Date.now();
              if (entry._lastLeadClickAt && (nowClick - entry._lastLeadClickAt) <= 280) {
                entry._lastLeadClickAt = 0;
                if (entry._leadClickTimer) {
                  clearTimeout(entry._leadClickTimer);
                  entry._leadClickTimer = null;
                }
                requestFocusSessionFromLead(entry.agent);
              } else {
                entry._lastLeadClickAt = nowClick;
                if (entry._leadClickTimer) clearTimeout(entry._leadClickTimer);
                entry._leadClickTimer = setTimeout(() => {
                  entry._leadClickTimer = null;
                  entry._lastLeadClickAt = 0;
                  toggleSessionTitleBanner(
                    entry.agent.conversationId,
                    entry.agent.conversationTitle,
                    entry.agent.projectName
                  );
                  showToast('💬 会话：' + (entry.agent.conversationTitle || '当前智能体会话') + '（📁 ' + (entry.agent.projectName || '全局会话') + ' · 双击弹起）');
                }, 220);
              }
            } else {
              showToast('❤️ ' + entry.agent.name + ' 开心地蹭了蹭你的手！');
            }
          } else {
            entry.manuallyPlaced = true;
          }
        };

        entry.slotEl.addEventListener('pointerup', finishDrag);
        entry.slotEl.addEventListener('pointercancel', finishDrag);
      }

      // Gentle wandering animation loop for awake Pokémon
      function tickWander() {
        if (wanderEnabled) {
          const rect = stageEl.getBoundingClientRect();
          const maxX = Math.max(16, (rect.width || 320) - 132);
          const maxY = Math.max(38, (rect.height || 250) - 138);

          petActors.forEach((entry) => {
            if (entry.dragging) return;
            if (entry.agent.state === 'sleeping') return;
            const speedMul = entry.agent.state === 'working' ? 1.35 : 0.75;
            entry.x += entry.vx * speedMul;
            entry.y += entry.vy * speedMul;
            if (entry.x <= 8 || entry.x >= maxX) {
              entry.vx *= -1;
              entry.x = Math.max(8, Math.min(maxX, entry.x));
            }
            if (entry.y <= 34 || entry.y >= maxY) {
              entry.vy *= -1;
              entry.y = Math.max(34, Math.min(maxY, entry.y));
            }
            entry.slotEl.style.transform = 'translate3d(' + entry.x.toFixed(1) + 'px, ' + entry.y.toFixed(1) + 'px, 0)';
          });
        }
        requestAnimationFrame(tickWander);
      }
      requestAnimationFrame(tickWander);

      function renderMemberCardHtml(a) {
        const badge = STATE_BADGE[a.state] || STATE_BADGE.sleeping;
        const options = Object.keys(SPECIES_CN)
          .map((sp) => '<option value="' + sp + '"' + (sp === a.pokemonSpecies ? ' selected' : '') + '>' + SPECIES_CN[sp] + '</option>')
          .join('');
        const remSec = (!a.isLead && a.state === 'sleeping' && a.idleMs > 0)
          ? Math.max(1, Math.ceil((60000 - a.idleMs) / 1000))
          : null;
        const badgeLabel = remSec !== null ? ('💤 待命 ' + remSec + 's') : badge.text;
        const ctx = getAgentCtx(a);
        const spriteSrc = getAuthenticSpriteSrc(a.pokemonSpecies, currentSpriteMode);

        return (
          '<div class="pkmn-glass-card queue-member-card ' + (a.isLead ? 'pkmn-queue-lead-card' : '') + '" data-agent-id="' + escapeHtml(a.id) + '" title="' + escapeHtml(ctx.tooltipText) + '">' +
            '<div class="agent-card-top ' + (a.isLead ? 'lead-click-head js-lead-banner-trigger' : '') + '"' +
              (a.isLead
                ? (' data-conv-id="' + escapeHtml(a.conversationId) + '" data-conv-title="' + escapeHtml(a.conversationTitle) + '" data-proj-name="' + escapeHtml(a.projectName) + '" data-ws-path="' + escapeHtml(a.workspacePath || '') + '" data-win-id="' + escapeHtml(a.windowId || '') + '" title="单击查看当前会话名 · 双击自动弹起对应项目与会话"')
                : '') +
            '>' +
              '<span class="agent-name">' +
                (a.isLead ? '<span class="lead-crown-pill">👑 领队</span> ' : '') +
                escapeHtml(a.name) +
              '</span>' +
              '<span class="pkmn-state-pill ' + badge.cls + '">' + badgeLabel + '</span>' +
            '</div>' +
            '<div class="member-card-avatar-row">' +
              '<div class="pkmn-ctx-avatar-ring member-avatar-ring" title="' + escapeHtml(ctx.tooltipText) + '">' +
                buildConcentricRingSvgMarkup(ctx, 'pkmn-ctx-ring-svg', '2.8', '2.6') +
                '<img class="member-avatar-img pkmn-authentic-sprite" src="' + escapeHtml(spriteSrc) + '" alt="' + escapeHtml(a.name) + '" />' +
              '</div>' +
              '<div style="min-width:0;flex:1;">' +
                '<div class="agent-status-line" style="margin-bottom:4px;" title="' + escapeHtml(a.statusText) + '">' +
                  escapeHtml(a.statusText || '待命中') +
                '</div>' +
                '<div class="pkmn-ctx-micro-pill" title="' + escapeHtml(ctx.tooltipText) + '">' +
                  '<span class="pkmn-ctx-red-val">🔴 ' + fmtTok(ctx.usedTokens) + ' (' + Math.round(ctx.usedPct) + '%)</span>' +
                  '<span>·</span>' +
                  '<span class="pkmn-ctx-green-val">🟢 ' + Math.round(ctx.cacheHitPct) + '%</span>' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<div class="agent-controls">' +
              '<select class="mini-select js-species-select" data-id="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '">' +
                options +
              '</select>' +
              '<button class="mini-btn js-sim-btn" data-id="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '" data-state="thinking">💭思考</button>' +
              '<button class="mini-btn js-sim-btn" data-id="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '" data-state="working">⚡工作</button>' +
              '<button class="mini-btn js-sim-btn" data-id="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '" data-state="sleeping">💤休眠</button>' +
              '<button class="mini-btn js-sim-btn" data-id="' + escapeHtml(a.id) + '" data-name="' + escapeHtml(a.name) + '" data-state="celebrating">✨欢呼</button>' +
            '</div>' +
          '</div>'
        );
      }

      function renderRoster(snapshot) {
        const agents = snapshot.agents || [];
        const projects = Array.isArray(snapshot.projects) && snapshot.projects.length > 0
          ? snapshot.projects
          : [{
              projectName: '全局会话',
              queues: [{
                conversationId: 'default',
                conversationTitle: snapshot.swarmTitle || '当前智能体会话',
                projectName: '全局会话',
                leadAgent: agents[0] ? { ...agents[0], isLead: true } : null,
                subagents: agents.slice(1).map((x) => ({ ...x, isLead: false }))
              }].filter((q) => q.leadAgent)
            }];

        latestAgents = agents;

        const allQueues = [];
        projects.forEach((p) => (p.queues || []).forEach((q) => allQueues.push(q)));
        const totalRows = Math.max(1, allQueues.length);

        const seenIds = new Set();
        allQueues.forEach((q, rIdx) => {
          const members = [q.leadAgent, ...(q.subagents || [])].filter(Boolean);
          members.forEach((m, cIdx) => {
            seenIds.add(m.id);
            mountOrUpdateStagePet(m, rIdx, totalRows, cIdx, members.length);
          });
        });

        petActors.forEach((entry, id) => {
          if (!seenIds.has(id)) {
            if (entry.controller && typeof entry.controller.destroy === 'function') {
              entry.controller.destroy();
            }
            entry.slotEl.remove();
            petActors.delete(id);
          }
        });

        if (!wanderEnabled) {
          lineupStagePetsSideBySide(false);
        }

        const s = snapshot.summary || { total: agents.length, thinking: 0, working: 0, sleeping: 0 };
        connBadgeEl.textContent = snapshot.bridgeConnected ? '17580 v4.1 全局浮窗联动' : 'Brain 本地列队';
        activeCountEl.textContent = '🐾 ' + allQueues.length + ' 排队列 · ' + agents.length + ' 只伙伴';
        summaryEl.textContent =
          '项目 ' + projects.length + ' 个 · 会话队列 ' + allQueues.length + ' 排 · 💭 思考 ' + s.thinking + ' · ⚡ 工作 ' + s.working + ' · 💤 待命 ' + s.sleeping;

        rosterEl.innerHTML = projects
          .map((proj) => {
            const qHtml = (proj.queues || [])
              .map((q) => {
                const subHtml = (q.subagents || []).map((sub) => renderMemberCardHtml(sub)).join('');
                return (
                  '<div class="pkmn-queue-session-row" data-conversation-id="' + escapeHtml(q.conversationId) + '">' +
                    renderMemberCardHtml({
                      ...q.leadAgent,
                      isLead: true,
                      conversationId: q.conversationId,
                      conversationTitle: q.conversationTitle,
                      projectName: q.projectName || proj.projectName,
                      workspacePath: q.workspacePath || '',
                      windowId: q.windowId || ''
                    }) +
                    (subHtml ? '<span class="pkmn-queue-arrow-sep">▸</span>' + subHtml : '') +
                  '</div>'
                );
              })
              .join('');

            return (
              '<div class="pkmn-queue-project-group">' +
                '<div class="pkmn-queue-project-header">' +
                  '<span>📁 ' + escapeHtml(proj.projectName || '全局会话') + '</span>' +
                  '<span class="pkmn-badge">' + (proj.queues || []).length + ' 个会话队列</span>' +
                '</div>' +
                qHtml +
              '</div>'
            );
          })
          .join('');
      }

      // Event Delegation
      document.getElementById('theme-chips').addEventListener('click', (ev) => {
        const btn = ev.target.closest('.pkmn-theme-chip');
        if (!btn) return;
        const skin = btn.getAttribute('data-skin');
        const label = btn.getAttribute('data-label');
        document.documentElement.setAttribute('data-pokemon-theme', skin);
        document.querySelectorAll('.pkmn-theme-chip').forEach((el) => el.classList.toggle('is-active', el === btn));
        vscode.postMessage({ type: 'switchTheme', skin, label });
        showToast('🎨 已切换主题皮肤：' + label);
      });

      rosterEl.addEventListener('change', (ev) => {
        const sel = ev.target.closest('.js-species-select');
        if (!sel) return;
        vscode.postMessage({
          type: 'simulate',
          payload: {
            id: sel.getAttribute('data-id'),
            name: sel.getAttribute('data-name'),
            pokemonSpecies: sel.value,
            ttlMs: 600000
          }
        });
      });

      let rosterLeadClickTimer = null;
      rosterEl.addEventListener('dblclick', (ev) => {
        const leadHead = ev.target.closest('.js-lead-banner-trigger');
        if (!leadHead) return;
        ev.preventDefault();
        if (rosterLeadClickTimer) {
          clearTimeout(rosterLeadClickTimer);
          rosterLeadClickTimer = null;
        }
        requestFocusSessionFromLead({
          conversationId: leadHead.getAttribute('data-conv-id') || '',
          conversationTitle: leadHead.getAttribute('data-conv-title') || '',
          projectName: leadHead.getAttribute('data-proj-name') || '',
          workspacePath: leadHead.getAttribute('data-ws-path') || '',
          windowId: leadHead.getAttribute('data-win-id') || ''
        });
      });

      rosterEl.addEventListener('click', (ev) => {
        const leadHead = ev.target.closest('.js-lead-banner-trigger');
        if (leadHead) {
          const cid = leadHead.getAttribute('data-conv-id');
          const ctitle = leadHead.getAttribute('data-conv-title');
          const pname = leadHead.getAttribute('data-proj-name');
          if (rosterLeadClickTimer) clearTimeout(rosterLeadClickTimer);
          rosterLeadClickTimer = setTimeout(() => {
            rosterLeadClickTimer = null;
            toggleSessionTitleBanner(cid, ctitle, pname);
          }, 220);
          return;
        }
        const btn = ev.target.closest('.js-sim-btn');
        if (!btn) return;
        const state = btn.getAttribute('data-state');
        const name = btn.getAttribute('data-name');
        const textMap = {
          thinking: '💭 正在推演代码方案...',
          working: '⚡ 高速编码输出招式中！',
          sleeping: '💤 蜷缩打盹恢复体力 Zzz...',
          celebrating: '✨ 任务大成功！欢呼雀跃！'
        };
        vscode.postMessage({
          type: 'simulate',
          payload: {
            id: btn.getAttribute('data-id'),
            name,
            state,
            statusText: textMap[state] || '',
            ttlMs: 60000
          }
        });
      });

      function applySpriteMode(nextMode, notifyHost) {
        currentSpriteMode = nextMode === 'authentic-pixel' ? 'authentic-pixel' : 'authentic-showdown';
        document.documentElement.setAttribute('data-sprite-mode', currentSpriteMode);
        if (spriteStyleBtn) {
          spriteStyleBtn.textContent =
            currentSpriteMode === 'authentic-pixel' ? '👾 画风: 像素' : '✨ 画风: 高清';
        }
        petActors.forEach((entry) => syncEntryAuthenticSprite(entry));
        if (notifyHost) {
          vscode.postMessage({ type: 'setSpriteStyle', spriteMode: currentSpriteMode });
          showToast(
            currentSpriteMode === 'authentic-pixel'
              ? '👾 已切换为：像素画风！'
              : '✨ 已切换为：高清画风！'
          );
        }
      }

      if (spriteStyleBtn) {
        spriteStyleBtn.addEventListener('click', () => {
          const next = currentSpriteMode === 'authentic-showdown' ? 'authentic-pixel' : 'authentic-showdown';
          applySpriteMode(next, true);
        });
      }

      const lineupBtn = document.getElementById('btn-lineup');
      if (lineupBtn) {
        lineupBtn.addEventListener('click', () => {
          wanderEnabled = false;
          wanderBtn.textContent = '🐾 漫步: 停';
          lineupStagePetsSideBySide(true);
          showToast('📏 所有伙伴已整齐并排列队！');
        });
      }

      window.addEventListener('resize', () => {
        if (!wanderEnabled) lineupStagePetsSideBySide(false);
      });

      wanderBtn.addEventListener('click', () => {
        wanderEnabled = !wanderEnabled;
        wanderBtn.textContent = wanderEnabled ? '🐾 漫步: 开' : '🐾 漫步: 停';
        if (!wanderEnabled) {
          lineupStagePetsSideBySide(false);
        }
      });

      document.getElementById('btn-spawn-demo').addEventListener('click', () => {
        const speciesPool = ['pikachu', 'gengar', 'charizard', 'umbreon', 'eevee', 'rotom', 'mewtwo'];
        const sp = speciesPool[Math.floor(Math.random() * speciesPool.length)];
        const states = ['thinking', 'working', 'celebrating'];
        const st = states[Math.floor(Math.random() * states.length)];
        const demoId = 'trainer-pet-' + Math.floor(100 + Math.random() * 900);
        vscode.postMessage({
          type: 'simulate',
          payload: {
            id: demoId,
            name: demoId,
            pokemonSpecies: sp,
            state: st,
            statusText: '⚡ 随时待命陪你写代码！',
            ttlMs: 120000
          }
        });
        showToast('⚡ 已召唤伙伴 ' + SPECIES_CN[sp] + ' 加入舞台！');
      });

      document.getElementById('btn-launch-os-pet').addEventListener('click', () => {
        vscode.postMessage({ type: 'launchDesktopPet' });
      });

      const applyGlobalSkinBtn = document.getElementById('btn-apply-global-skin');
      if (applyGlobalSkinBtn) {
        applyGlobalSkinBtn.addEventListener('click', () => {
          vscode.postMessage({ type: 'applyGlobalSkin' });
        });
      }

      const openArenaBtn = document.getElementById('btn-open-arena');
      if (openArenaBtn) {
        openArenaBtn.addEventListener('click', () => vscode.postMessage({ type: 'openPetArena' }));
      }

      const startBridgeBtn = document.getElementById('btn-start-bridge');
      if (startBridgeBtn) {
        startBridgeBtn.addEventListener('click', () => vscode.postMessage({ type: 'startMonitorBridge' }));
      }

      document.getElementById('btn-reset-sim').addEventListener('click', () => {
        vscode.postMessage({ type: 'simulate', payload: { action: 'reset' } });
        showToast('🔄 已恢复全部智能体实时状态同步');
      });

      document.getElementById('btn-refresh').addEventListener('click', () => {
        vscode.postMessage({ type: 'refresh' });
      });

      window.addEventListener('message', (ev) => {
        const msg = ev.data;
        if (!msg) return;
        if (msg.type === 'snapshot') {
          renderRoster(msg.snapshot);
        } else if (msg.type === 'skinChanged') {
          document.documentElement.setAttribute('data-pokemon-theme', msg.skin);
          document.querySelectorAll('.pkmn-theme-chip').forEach((el) => {
            el.classList.toggle('is-active', el.getAttribute('data-skin') === msg.skin);
          });
        } else if (msg.type === 'spriteModeChanged') {
          applySpriteMode(msg.spriteMode, false);
        } else if (msg.type === 'toast') {
          showToast(msg.text);
        }
      });

      vscode.postMessage({ type: 'ready' });
    })();
  </script>
</body>
</html>`;
}

/**
 * Sidebar WebviewView Provider (`pokemonPetSidebar`)
 */
class PokemonSidebarProvider {
  constructor(context, monitor, handlers) {
    this.context = context;
    this.monitor = monitor;
    this.handlers = handlers;
    this.view = null;
  }

  resolveWebviewView(webviewView) {
    this.view = webviewView;
    const suiteRoot = resolveSuiteRoot(this.context);
    const resourceRoots = [vscode.Uri.file(this.context.extensionPath)];
    if (fs.existsSync(suiteRoot)) {
      resourceRoots.push(vscode.Uri.file(suiteRoot));
    }

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots
    };

    webviewView.webview.html = buildPetArenaWebviewHtml(
      webviewView.webview,
      this.context,
      suiteRoot,
      'sidebar'
    );

    webviewView.webview.onDidReceiveMessage((msg) =>
      this.handlers.handleWebviewMessage(msg, webviewView.webview)
    );

    const rerender = () => {
      if (this.view !== webviewView) return;
      webviewView.webview.html = buildPetArenaWebviewHtml(webviewView.webview, this.context, suiteRoot, 'sidebar');
    };
    packListeners.add(rerender);

    webviewView.onDidDispose(() => {
      packListeners.delete(rerender);
      this.view = null;
    });
  }

  postMessage(msg) {
    if (this.view && this.view.visible) {
      this.view.webview.postMessage(msg);
    }
  }
}

function activate(context) {
  const monitor = new AgentMonitorClient();
  let arenaPanel = null;

  // 0. Older versions stored the theme's display label in `workbench.colorTheme`; themes now have stable ids.
  try {
    const workbenchCfg = vscode.workspace.getConfiguration('workbench');
    const storedTheme = String(workbenchCfg.get('colorTheme') || '');
    const legacyEntry = POKEMON_THEMES.find((t) => t.legacyLabel === storedTheme);
    if (legacyEntry) {
      workbenchCfg.update('colorTheme', legacyEntry.id, vscode.ConfigurationTarget.Global).then(undefined, () => {});
    }
  } catch (_) {}

  // 1. Status Bar Item: ⚡ 桌宠: N 个智能体运行中
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
  statusBarItem.command = 'pokemonTheme.openPetArena';
  statusBarItem.text = '⚡ 桌宠: 扫描中...';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  function updateStatusBar(snapshot) {
    const s = snapshot.summary || { total: 0, thinking: 0, working: 0, sleeping: 0, celebrating: 0 };
    const activeCount = s.thinking + s.working + s.celebrating;

    const badges = [];
    if (s.thinking > 0) badges.push(`💭${s.thinking} Thinking`);
    if (s.working > 0) badges.push(`⚡${s.working} Working`);
    if (s.sleeping > 0) badges.push(`💤${s.sleeping} Sleeping`);
    if (badges.length === 0) badges.push('💤 Sleeping');

    // Compact: "⚡ 3 · 🔴70% 🟢78%" (rings of the most relevant lead: focused/active queue first).
    const queuesArr = Array.isArray(snapshot.queues) ? snapshot.queues : [];
    const mainQ = queuesArr.find((q) => q.hasActiveSubagent) || queuesArr[0];
    const leadCtx = mainQ && mainQ.leadAgent ? normalizeAgentContextObj(mainQ.leadAgent.context, mainQ.leadAgent.model) : null;
    const ringTxt = leadCtx
      ? ` · 🔴${Math.round(leadCtx.usedPct)}% 🟢${leadCtx.cacheKnown ? Math.round(leadCtx.cacheHitPct) + '%' : '—'}`
      : '';
    const busyTxt = activeCount > 0 ? ` ⚡${activeCount}` : '';
    statusBarItem.text = `$(symbol-event) 桌宠 ${s.total}${busyTxt}${ringTxt}`;

    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.appendMarkdown(`### ⚡ 智能体桌宠监控\n\n`);
    md.appendMarkdown(
      `- **数据源**: ${snapshot.bridgeConnected ? '🟢 Bridge `127.0.0.1:17580` 实时连接' : '🟡 `~/.gemini/antigravity/brain` 本地直连回退'}\n`
    );
    md.appendMarkdown(
      `- **状态汇总**: 💭 Thinking **${s.thinking}** · ⚡ Working **${s.working}** · 💤 Sleeping **${s.sleeping}**\n\n---\n\n`
    );

    for (const a of (snapshot.agents || []).slice(0, 8)) {
      const spEmoji = SPECIES_EMOJI[a.pokemonSpecies] || '⚡';
      const st = STATE_META[a.state] || STATE_META.sleeping;
      const ctx = normalizeAgentContextObj(a.context, a.model);
      const ctxPart = ` · \`🔴${formatTokensCompact(ctx.usedTokens)}(${Math.round(ctx.usedPct)}%) 🟢${ctx.cacheKnown ? Math.round(ctx.cacheHitPct) + '%' : '—'}\``;
      md.appendMarkdown(
        `- ${spEmoji} **${a.name}** — \`${st.icon} ${st.label}\`${ctxPart} ${a.statusText ? `*(${a.statusText})*` : ''}\n`
      );
    }

    md.appendMarkdown(
      `\n---\n[🏟️ 打开桌宠乐园](command:pokemonTheme.openPetArena) · [🎨 切换主题皮肤](command:pokemonTheme.switchTheme) · [🪟 召唤桌面透明悬浮宠](command:pokemonTheme.launchDesktopPet)`
    );
    statusBarItem.tooltip = md;
  }

  async function applyPokemonTheme(label) {
    const entry = findThemeEntry(label);
    await vscode.workspace
      .getConfiguration('workbench')
      .update('colorTheme', entry ? entry.id : label, vscode.ConfigurationTarget.Global);
  }

  function resolveRealNodeBinary() {
    try {
      const nvmdDir = path.join(os.homedir(), '.nvmd');
      const defFile = path.join(nvmdDir, 'default');
      if (fs.existsSync(defFile)) {
        const ver = fs.readFileSync(defFile, 'utf8').trim();
        if (ver) {
          const cand = path.join(nvmdDir, 'versions', ver, 'node.exe');
          if (fs.existsSync(cand)) return cand;
        }
      }
      const versDir = path.join(nvmdDir, 'versions');
      if (fs.existsSync(versDir)) {
        const dirs = fs.readdirSync(versDir).sort().reverse();
        for (const d of dirs) {
          const cand = path.join(versDir, d, 'node.exe');
          if (fs.existsSync(cand)) return cand;
        }
      }
      const pfNode = 'C:\\Program Files\\nodejs\\node.exe';
      if (fs.existsSync(pfNode)) return pfNode;
    } catch (_) {}
    return '';
  }

  function runSilentWscriptVbs(suiteRoot, targetArgs) {
    if (process.platform !== 'win32') return false;
    const vbsPath = path.join(suiteRoot, 'desktop-pet', 'silent-launch.vbs');
    if (!fs.existsSync(vbsPath)) return false;
    const sysWscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');
    const exe = fs.existsSync(sysWscript) ? sysWscript : 'wscript.exe';
    try {
      cp.execFile(
        exe,
        ['//B', '//Nologo', vbsPath, ...targetArgs],
        { cwd: suiteRoot, windowsHide: true, timeout: 8000 },
        () => {}
      );
      return true;
    } catch (_) {
      return false;
    }
  }

  let lastBridgeSpawnAttemptMs = 0;
  let hasAutoStartedOverlayOnce = false;
  let lastOverlayForceLaunchMs = 0;

  async function startMonitorBridgeProcess(silent = false) {
    const suiteRoot = resolveSuiteRoot(context);
    const bridgeScript = path.join(suiteRoot, 'bridge', 'agent-monitor.mjs');
    if (!fs.existsSync(bridgeScript)) {
      if (!silent) {
        vscode.window.showWarningMessage(`未找到监控桥脚本: ${bridgeScript}，已启用 Brain 目录直连回退模式。`);
      }
      return false;
    }

    const now = Date.now();
    if (silent && now - lastBridgeSpawnAttemptMs < 12000) {
      return false;
    }
    lastBridgeSpawnAttemptMs = now;

    try {
      const realNode = resolveRealNodeBinary();
      // `--bind-ide`: the bridge exits once every process of this IDE executable has closed.
      const bindArgs = ['--bind-ide'];
      if (/\.exe$/i.test(IDE_HOST_EXE)) bindArgs.push('--host-exe', IDE_HOST_EXE);
      const targetArgs = realNode ? [realNode, bridgeScript, ...bindArgs] : [bridgeScript, ...bindArgs];
      const ok = runSilentWscriptVbs(suiteRoot, targetArgs);
      if (!ok) {
        return false;
      }
      setTimeout(() => monitor.poll(), 650);
      if (!silent) {
        vscode.window.showInformationMessage('🛰️ 智能体实时监控桥 (127.0.0.1:17580) 已在后台静默启动！');
      }
      return true;
    } catch (err) {
      if (!silent) {
        vscode.window.showErrorMessage(`启动监控桥失败: ${err.message}`);
      }
      return false;
    }
  }

  function resolveIdeProcessId() {
    const envPid = Number(process.env.VSCODE_PID);
    if (Number.isInteger(envPid) && envPid > 0) return envPid;
    if (typeof process.ppid === 'number' && process.ppid > 0) return process.ppid;
    return process.pid;
  }

  function getSharedDesktopOverlayState() {
    try {
      const stateFile = path.join(os.tmpdir(), 'antigravity-pokemon-desktop-overlay-state.json');
      if (!fs.existsSync(stateFile)) return null;
      const st = JSON.parse(fs.readFileSync(stateFile, 'utf8').replace(/^\uFEFF/, ''));
      const pid = Number(st && st.pid);
      if (!Number.isInteger(pid) || pid <= 4) return null;
      if (st.desktop && String(st.desktop).toLowerCase() !== 'default') return null;
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (err) {
        alive = Boolean(err && err.code === 'EPERM');
      }
      if (!alive) return null;
      const mtimeMs = fs.statSync(stateFile).mtimeMs || 0;
      return { ...st, mtimeMs };
    } catch (_) {
      return null;
    }
  }

  function isDesktopOverlayMuted() {
    try {
      const muteFile = path.join(os.tmpdir(), 'antigravity-pokemon-desktop-overlay-muted.json');
      return fs.existsSync(muteFile);
    } catch (_) {
      return false;
    }
  }

  async function ensureMonitorBridgeRunning() {
    const bridgeUrl = monitor.getBridgeUrl();
    try {
      const health = await httpRequestJson(`${bridgeUrl}/health`, 'GET', null, 850);
      if (health && health.ok) return true;
    } catch (_) {
      // bridge offline -> start silently via wscript.exe
    }
    return startMonitorBridgeProcess(true);
  }

  async function launchDesktopPetOverlay(options = {}) {
    const { silent = false, isAutoStartup = false, fromSummonSignal = false } = options;
    if (isAutoStartup) {
      if (hasAutoStartedOverlayOnce) return;
      hasAutoStartedOverlayOnce = true;
      if (isDesktopOverlayMuted() || getSharedDesktopOverlayState()) {
        await ensureMonitorBridgeRunning();
        return;
      }
    }

    const suiteRoot = resolveSuiteRoot(context);
    const candidateScripts = [
      path.join(suiteRoot, 'desktop-pet', 'launch-desktop-pet.ps1'),
      path.join(suiteRoot, 'desktop-pet', 'pokemon-desktop-overlay.ps1'),
      path.join(suiteRoot, 'start-pokemon-ide.ps1')
    ];

    const scriptPath = candidateScripts.find((p) => fs.existsSync(p));
    if (!scriptPath) {
      if (silent) return;
      const htmlFallback = path.join(suiteRoot, 'desktop-pet', 'overlay.html');
      if (fs.existsSync(htmlFallback)) {
        await vscode.env.openExternal(vscode.Uri.file(htmlFallback));
        vscode.window.showInformationMessage('✨ 已打开桌宠舞台！');
        return;
      }
      vscode.window.showWarningMessage(
        `未在 ${path.join(suiteRoot, 'desktop-pet')} 找到桌面悬浮宠启动脚本，请确认套件目录完整。`
      );
      return;
    }

    await ensureMonitorBridgeRunning();

    if (!isAutoStartup && !fromSummonSignal) {
      await monitor.summonOverlay({ theme: getCurrentSkinKey(), source: 'vscode-launch-command' });
    }

    const now = Date.now();
    if (!isAutoStartup) {
      if (now - lastOverlayForceLaunchMs < 2500) return;
      lastOverlayForceLaunchMs = now;
      try {
        const muteFile = path.join(os.tmpdir(), 'antigravity-pokemon-desktop-overlay-muted.json');
        if (fs.existsSync(muteFile)) fs.unlinkSync(muteFile);
      } catch (_) {}
      const curState = getSharedDesktopOverlayState();
      if (curState && curState.mtimeMs && now - curState.mtimeMs < 4500) {
        if (!silent) {
          vscode.window.showInformationMessage('⚡ 已召唤 Windows 桌面悬浮桌宠！');
        }
        return;
      }
    }

    try {
      let scriptText = '';
      try {
        scriptText = fs.readFileSync(scriptPath, 'utf8');
      } catch (_) {}

      const cfg = vscode.workspace.getConfiguration('pokemonTheme');
      const bindToIde = cfg.get('bindDesktopPetToIdeLifecycle') !== false;
      const currentSkin = getCurrentSkinKey();
      const overlayTheme =
        currentSkin === 'pokedex-light' && !/pokedex-light/i.test(scriptText) ? 'pikachu' : currentSkin;

      const sysPsExe = path.join(
        process.env.SystemRoot || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      const psBin = fs.existsSync(sysPsExe) ? sysPsExe : 'powershell.exe';
      const vbsTargetArgs = [
        psBin,
        '-STA',
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath
      ];

      if (!isAutoStartup && /\$Theme\b/i.test(scriptText)) {
        vbsTargetArgs.push('-Theme', overlayTheme);
      }
      if (bindToIde) {
        if (/\$BindToIde\b/i.test(scriptText)) {
          vbsTargetArgs.push('-BindToIde');
        }
        if (/\$IdePid\b/i.test(scriptText)) {
          vbsTargetArgs.push('-IdePid', String(resolveIdeProcessId()));
        }
      }
      if (isAutoStartup && /\$FromWatchdog\b/i.test(scriptText)) {
        vbsTargetArgs.push('-FromWatchdog');
      } else if (!isAutoStartup && getSharedDesktopOverlayState() && /\$ForceRestart\b/i.test(scriptText)) {
        vbsTargetArgs.push('-ForceRestart');
      }

      runSilentWscriptVbs(suiteRoot, vbsTargetArgs);
      if (!silent) {
        vscode.window.showInformationMessage('⚡ 已召唤 Windows 桌面悬浮桌宠！按住宠物可任意拖拽。');
      }
    } catch (err) {
      if (!silent) {
        vscode.window.showErrorMessage(`召唤桌面透明桌宠失败: ${err.message}`);
      }
    }
  }

  function openPetArenaPanel() {
    const suiteRoot = resolveSuiteRoot(context);
    if (arenaPanel) {
      arenaPanel.reveal(vscode.ViewColumn.Beside);
      arenaPanel.webview.postMessage({ type: 'snapshot', snapshot: monitor.snapshot });
      return;
    }

    const resourceRoots = [vscode.Uri.file(context.extensionPath)];
    if (fs.existsSync(suiteRoot)) {
      resourceRoots.push(vscode.Uri.file(suiteRoot));
    }

    arenaPanel = vscode.window.createWebviewPanel(
      'pokemonPetArena',
      '⚡ 智能体桌宠',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots
      }
    );

    arenaPanel.webview.html = buildPetArenaWebviewHtml(arenaPanel.webview, context, suiteRoot, 'arena');
    const arenaRef = arenaPanel;
    const rerenderArena = () => {
      if (arenaPanel === arenaRef) arenaRef.webview.html = buildPetArenaWebviewHtml(arenaRef.webview, context, suiteRoot, 'arena');
    };
    packListeners.add(rerenderArena);
    arenaRef.onDidDispose(() => packListeners.delete(rerenderArena));
    arenaPanel.webview.onDidReceiveMessage((msg) => handleWebviewMessage(msg, arenaPanel.webview));
    arenaPanel.onDidDispose(() => {
      arenaPanel = null;
    });
  }

  // The stage (lineup / gacha reveal / Pokédex / settings) as an IDE editor tab, hosting the bridge's
  // `/stage` page. Falls back to the legacy built-in arena only when the bridge can't be started.
  let stagePanel = null;
  async function openStagePanel(options = {}) {
    const { preserveFocus = false } = options;
    if (stagePanel) {
      stagePanel.reveal(stagePanel.viewColumn || vscode.ViewColumn.Active, preserveFocus);
      return;
    }
    await ensureMonitorBridgeRunning().catch(() => {});
    const bridgeUrl = monitor.getBridgeUrl();
    let alive = false;
    for (let i = 0; i < 6 && !alive; i++) {
      try {
        const h = await httpRequestJson(`${bridgeUrl}/health`, 'GET', null, 800);
        alive = Boolean(h && h.ok !== false);
      } catch (_) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (!alive) {
      openPetArenaPanel();
      return;
    }
    let stageUrl = `${bridgeUrl}/static/desktop-pet/overlay.html?host=ide`;
    try {
      stageUrl = String(await vscode.env.asExternalUri(vscode.Uri.parse(stageUrl)));
    } catch (_) {}
    const origin = (() => {
      try {
        return new URL(stageUrl).origin;
      } catch (_) {
        return bridgeUrl;
      }
    })();

    stagePanel = vscode.window.createWebviewPanel(
      'pokemonStage',
      '桌宠舞台',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus },
      // enableScripts must be true: the nested iframe inherits the webview frame's sandbox, and without
      // `allow-scripts` the stage page can't run (stuck on "connecting", no theme control).
      // The host document itself still runs no script (its CSP is default-src 'none').
      { enableScripts: true, retainContextWhenHidden: true }
    );
    stagePanel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'pokeball-activity.svg'));
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    stagePanel.webview.html =
      '<!doctype html><html><head><meta charset="utf-8">' +
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${esc(origin)} http://127.0.0.1:17580 http://localhost:17580; style-src 'unsafe-inline';">` +
      '<style>html,body{margin:0;padding:0;height:100%;overflow:hidden;background:#120f1a}iframe{border:0;width:100%;height:100vh;display:block}</style>' +
      `</head><body><iframe src="${esc(stageUrl)}" allow="clipboard-write"></iframe></body></html>`;
    stagePanel.onDidDispose(() => {
      stagePanel = null;
    });
  }

  function runGlobalSkinScript(action = 'apply', themeKey = null) {
    return new Promise((resolve) => {
      const skinDir = path.join(context.extensionPath, 'full-app-skin');
      const fallbackDir = path.join(resolveSuiteRoot(context), 'vscode-pokemon-theme', 'full-app-skin');
      const scriptName = action === 'restore' ? 'restore-global-skin.ps1' : 'apply-global-skin.ps1';
      const candidate = [path.join(skinDir, scriptName), path.join(fallbackDir, scriptName)].find((p) =>
        fs.existsSync(p)
      );

      if (!candidate) {
        vscode.window.showWarningMessage(`未找到全局皮肤脚本: ${scriptName}`);
        return resolve(false);
      }

      const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', candidate];
      if (action === 'apply') {
        const skin = themeKey || getCurrentSkinKey();
        args.push('-Theme', skin);
      }

      const psExe = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
      cp.execFile(psExe, args, { cwd: path.dirname(candidate), windowsHide: true }, async (err) => {
        if (err) {
          vscode.window.showErrorMessage(`全局皮肤操作失败: ${err.message}`);
          return resolve(false);
        }
        const msg =
          action === 'restore'
            ? '♻️ 已恢复 Antigravity 默认原始界面！重载窗口后立即生效。'
            : '✨ 已注入 Antigravity 全界面皮肤与右侧 Subagents 队伍栏！重载窗口后生效。';
        const pick = await vscode.window.showInformationMessage(msg, '立即重载窗口 (Reload Window)');
        if (pick) {
          await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
        resolve(true);
      });
    });
  }

  async function handleWebviewMessage(msg, webview) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'ready':
      case 'refresh': {
        const snap = await monitor.poll();
        webview.postMessage({ type: 'snapshot', snapshot: snap });
        break;
      }
      case 'switchTheme': {
        if (msg.label) {
          await applyPokemonTheme(msg.label);
        }
        if (msg.skin) {
          await monitor.syncTheme(msg.skin);
        }
        break;
      }
      case 'focusSession': {
        await monitor.focusSession(msg.payload || {});
        break;
      }
      case 'setSpriteStyle': {
        const style = msg.spriteMode === 'authentic-pixel' ? 'authentic-pixel' : 'authentic-showdown';
        await vscode.workspace
          .getConfiguration('pokemonTheme')
          .update('spriteStyle', style, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'simulate': {
        await monitor.simulate(msg.payload || {});
        break;
      }
      case 'launchDesktopPet': {
        await launchDesktopPetOverlay({ silent: false });
        webview.postMessage({ type: 'toast', text: '🪟 正在召唤 Windows 桌面悬浮桌宠...' });
        break;
      }
      case 'openPetArena': {
        openPetArenaPanel();
        break;
      }
      case 'startMonitorBridge': {
        await startMonitorBridgeProcess(false);
        break;
      }
      case 'applyGlobalSkin': {
        webview.postMessage({ type: 'toast', text: '✨ 正在为整个 Antigravity 注入全界面皮肤...' });
        await runGlobalSkinScript('apply', getCurrentSkinKey());
        break;
      }
      case 'restoreGlobalSkin': {
        await runGlobalSkinScript('restore');
        break;
      }
    }
  }

  // 2. Register Sidebar WebviewView (`pokemonPetSidebar`)
  const sidebarProvider = new PokemonSidebarProvider(context, monitor, { handleWebviewMessage });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('pokemonPetSidebar', sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  // 3. Broadcast live agent state & remote theme updates to StatusBar, Sidebar, and Floating Arena Panel
  const FOCUS_COMMAND_CANDIDATES = [
    'antigravity.focusChat',
    'antigravity.openConversation',
    'workbench.panel.chat.view.copilot.focus',
    'workbench.action.chat.open',
    'workbench.action.focusAuxiliaryBar',
    'workbench.action.focusSideBar'
  ];

  function parseFocusTimestampMs(raw) {
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (raw === undefined || raw === null || raw === '') return 0;
    const s = String(raw).trim();
    if (/^\d+$/.test(s)) return Number(s);
    const parsed = Date.parse(s);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function matchesCurrentIdeWorkspace(focusCmd) {
    if (!focusCmd || typeof focusCmd !== 'object') return false;
    if (focusCmd.windowId && focusCmd.windowId === IDE_INSTANCE_ID) return true;
    const folders = Array.isArray(vscode.workspace.workspaceFolders)
      ? vscode.workspace.workspaceFolders
      : [];
    const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    const targetWs = normPath(focusCmd.workspacePath);
    const targetProj = String(focusCmd.projectName || '').trim().toLowerCase();
    return folders.some((wf) => {
      const rawFs = (wf && wf.uri && wf.uri.fsPath) || '';
      const normFs = normPath(rawFs);
      const baseName = path.basename(rawFs).trim().toLowerCase();
      const wfName = String((wf && wf.name) || '').trim().toLowerCase();
      if (targetWs && normFs && normFs === targetWs) return true;
      if (targetProj && targetProj !== '全局会话' && (baseName === targetProj || wfName === targetProj)) {
        return true;
      }
      return false;
    });
  }

  async function handleIncomingFocusRequest(focusCmd, bridgeUrl) {
    let executedCmd = null;
    try {
      const available = new Set(await vscode.commands.getCommands(true));
      for (const cmd of FOCUS_COMMAND_CANDIDATES) {
        if (!available.has(cmd)) continue;
        try {
          await vscode.commands.executeCommand(cmd);
          executedCmd = cmd;
          break;
        } catch (_) {
          // Try next candidate command if execution fails
        }
      }
    } catch (_) {
      // Ignore command query errors
    }

    const label = focusCmd.conversationTitle || focusCmd.projectName || '当前工作区';
    vscode.window.setStatusBarMessage(`⚡ 洛托姆图鉴：已定位至会话「${label}」`, 4000);

    const targetBridge = bridgeUrl || monitor.getBridgeUrl();
    if (targetBridge) {
      httpRequestJson(
        `${targetBridge}/api/focus-ack`,
        'POST',
        {
          requestId: focusCmd.requestId || null,
          conversationId: focusCmd.conversationId || null,
          windowId: IDE_INSTANCE_ID,
          appKind: 'ide-extension',
          docTitle: String(vscode.workspace.name || ''),
          phase: 'executed',
          handled: Boolean(executedCmd),
          stage: 'ide-extension',
          action: executedCmd || 'status-bar-only',
          reason: executedCmd ? `executed:${executedCmd}` : 'no-focus-command-available',
          routerSource: 'vscode-extension'
        },
        1000
      ).catch(() => {});
    }
  }

  let lastObservedRemoteTheme = '';
  let summonWatermarkInit = false;
  let lastSeenSummonTs = 0;
  let openStageWatermarkInit = false;
  let lastSeenOpenStageTs = 0;
  let lastSeenFocusRequestId = null;
  let focusWatermarkInit = false;
  const extensionBootMs = Date.now();
  context.subscriptions.push(
    monitor.onDidUpdate((snapshot) => {
      updateStatusBar(snapshot);
      sidebarProvider.postMessage({ type: 'snapshot', snapshot });
      if (arenaPanel) {
        arenaPanel.webview.postMessage({ type: 'snapshot', snapshot });
      }
      // Desktop Pet / Stage focus-session request -> focus matching IDE workspace chat/aux pane
      const focusCmd = snapshot && snapshot.lastFocusRequest;
      if (!focusWatermarkInit) {
        focusWatermarkInit = true;
        if (focusCmd && focusCmd.requestId) {
          const reqTs = parseFocusTimestampMs(focusCmd.requestedAt);
          const isRecentBootReq = reqTs > 0 && reqTs >= extensionBootMs - 2500;
          if (!isRecentBootReq) {
            lastSeenFocusRequestId = focusCmd.requestId;
          }
        }
      }
      if (focusCmd && focusCmd.requestId && focusCmd.requestId !== lastSeenFocusRequestId) {
        lastSeenFocusRequestId = focusCmd.requestId;
        const reqTs = parseFocusTimestampMs(focusCmd.requestedAt);
        const isNotStale = !focusCmd.requestedAt || reqTs >= extensionBootMs - 2500;
        if (isNotStale && matchesCurrentIdeWorkspace(focusCmd)) {
          if (!focusCmd.host || focusCmd.host === 'ide' || !focusCmd.matchedUiWindow || focusCmd.windowId === IDE_INSTANCE_ID) {
            handleIncomingFocusRequest(focusCmd, snapshot.bridgeUrl).catch(() => {});
          }
        }
      }
      // Desktop overlay's "stage / Pokédex" menu -> open the stage as an editor tab here.
      if (snapshot.openStageRequestedAt) {
        const ts = Number(snapshot.openStageRequestedAt) || 0;
        if (!openStageWatermarkInit) {
          openStageWatermarkInit = true;
          lastSeenOpenStageTs = ts;
        } else if (ts > lastSeenOpenStageTs) {
          lastSeenOpenStageTs = ts;
          openStagePanel().catch(() => {});
        }
      } else if (!openStageWatermarkInit) {
        openStageWatermarkInit = true;
      }
      if (snapshot.summonRequestedAt !== undefined && snapshot.summonRequestedAt !== null) {
        const ts =
          typeof snapshot.summonRequestedAt === 'number'
            ? snapshot.summonRequestedAt
            : Date.parse(String(snapshot.summonRequestedAt)) || 0;
        if (!summonWatermarkInit) {
          summonWatermarkInit = true;
          lastSeenSummonTs = ts;
        } else if (ts > lastSeenSummonTs) {
          lastSeenSummonTs = ts;
          launchDesktopPetOverlay({ silent: true, isAutoStartup: false, fromSummonSignal: true }).catch(() => {});
        }
      }
      if (snapshot.activeTheme) {
        const mappedSkin =
          snapshot.activeTheme === 'rotom-light' || snapshot.activeTheme === 'rotom'
            ? 'pokedex-light'
            : snapshot.activeTheme;
        if (lastObservedRemoteTheme && lastObservedRemoteTheme !== mappedSkin) {
          sidebarProvider.postMessage({ type: 'skinChanged', skin: mappedSkin });
          if (arenaPanel) {
            arenaPanel.webview.postMessage({ type: 'skinChanged', skin: mappedSkin });
          }
          // Theme picked on the stage / desktop overlay -> also switch the IDE's editor color theme
          // (the injected full-app skin follows the bridge on its own). Idempotent, so no feedback loop.
          const entry = POKEMON_THEMES.find((t) => t.skin === mappedSkin);
          const current = String(vscode.workspace.getConfiguration('workbench').get('colorTheme') || '');
          if (entry && current !== entry.label) {
            applyPokemonTheme(entry.label).catch(() => {});
          }
        }
        lastObservedRemoteTheme = mappedSkin;
      }
    })
  );

  // Sync Webview skin & spriteStyle whenever user updates VS Code settings
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((ev) => {
      if (ev.affectsConfiguration('workbench.colorTheme')) {
        const skin = getCurrentSkinKey();
        lastObservedRemoteTheme = skin;
        monitor.syncTheme(skin).catch(() => {});
        sidebarProvider.postMessage({ type: 'skinChanged', skin });
        if (arenaPanel) {
          arenaPanel.webview.postMessage({ type: 'skinChanged', skin });
        }
      }
      if (ev.affectsConfiguration('pokemonTheme.spriteStyle')) {
        const spriteMode =
          vscode.workspace.getConfiguration('pokemonTheme').get('spriteStyle') === 'authentic-pixel'
            ? 'authentic-pixel'
            : 'authentic-showdown';
        sidebarProvider.postMessage({ type: 'spriteModeChanged', spriteMode });
        if (arenaPanel) {
          arenaPanel.webview.postMessage({ type: 'spriteModeChanged', spriteMode });
        }
      }
      if (
        ev.affectsConfiguration('pokemonTheme.pollIntervalMs') ||
        ev.affectsConfiguration('pokemonTheme.bridgeUrl')
      ) {
        monitor.start();
      }
    })
  );

  // 4. Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('pokemonTheme.openPetArena', () => openStagePanel()),
    vscode.commands.registerCommand('pokemonTheme.openStage', () => openStagePanel()),
    vscode.commands.registerCommand('pokemonTheme.openLegacyArena', () => openPetArenaPanel()),

    vscode.commands.registerCommand('pokemonTheme.switchTheme', async () => {
      const current = vscode.workspace.getConfiguration('workbench').get('colorTheme');
      const items = POKEMON_THEMES.map((t) => ({
        label: t.label,
        description: t.label === current ? '当前使用中' : t.desc,
        skin: t.skin
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: '🎨 选择要切换的 IDE 配色主题（实时生效）'
      });
      if (picked) {
        await applyPokemonTheme(picked.label);
        vscode.window.showInformationMessage(`🎨 已切换为「${picked.label}」！`);
      }
    }),

    vscode.commands.registerCommand('pokemonTheme.toggleSpriteStyle', async () => {
      const cfg = vscode.workspace.getConfiguration('pokemonTheme');
      const cur = cfg.get('spriteStyle') === 'authentic-pixel' ? 'authentic-pixel' : 'authentic-showdown';
      const next = cur === 'authentic-showdown' ? 'authentic-pixel' : 'authentic-showdown';
      await cfg.update('spriteStyle', next, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(
        next === 'authentic-pixel'
          ? '👾 已切换为：像素画风！'
          : '✨ 已切换为：高清画风！'
      );
    }),

    vscode.commands.registerCommand('pokemonTheme.launchDesktopPet', () =>
      launchDesktopPetOverlay({ silent: false })
    ),

    vscode.commands.registerCommand('pokemonTheme.startMonitorBridge', () => startMonitorBridgeProcess(false)),

    vscode.commands.registerCommand('pokemonTheme.refreshAgents', async () => {
      const snap = await monitor.poll();
      vscode.window.showInformationMessage(
        `⚡ 已刷新：当前检测到 ${snap.summary.total} 个智能体（💭${snap.summary.thinking} ⚡${snap.summary.working} 💤${snap.summary.sleeping}）`
      );
    }),

    vscode.commands.registerCommand('pokemonTheme.applyGlobalSkin', () =>
      runGlobalSkinScript('apply', getCurrentSkinKey())
    ),

    vscode.commands.registerCommand('pokemonTheme.restoreGlobalSkin', () => runGlobalSkinScript('restore'))
  );

  // 4b. When this extension's own files are updated on disk (suite sync / reinstall), offer a window reload —
  // otherwise the IDE keeps running the old build until the next restart.
  let updatePromptShown = false;
  const selfFiles = [__filename, path.join(context.extensionPath, 'package.json')];
  const selfStamp = () => selfFiles.map((f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch (_) {
      return 0;
    }
  }).join('|');
  const loadedStamp = selfStamp();
  const selfUpdateTimer = setInterval(() => {
    if (updatePromptShown || selfStamp() === loadedStamp) return;
    updatePromptShown = true;
    vscode.window
      .showInformationMessage('桌宠扩展已更新，需要重新加载窗口才能生效。', '重新加载窗口', '稍后')
      .then((pick) => {
        // "稍后" / dismissed: don't nag again in this window session.
        if (pick === '重新加载窗口') vscode.commands.executeCommand('workbench.action.reloadWindow');
      });
  }, 5000);
  context.subscriptions.push({ dispose: () => clearInterval(selfUpdateTimer) });

  // 5. Start live polling & auto-bootstrap Bridge + IDE-bound Desktop Pet on Antigravity IDE startup
  monitor.start();
  const startupTimer = setTimeout(async () => {
    try {
      await ensureMonitorBridgeRunning();
      const autoSummon = vscode.workspace
        .getConfiguration('pokemonTheme')
        .get('autoSummonDesktopPetOnStartup');
      if (autoSummon !== false) {
        await launchDesktopPetOverlay({ silent: true, isAutoStartup: true });
      }
    } catch (_) {
      // keep IDE startup completely non-blocking
    }
  }, 350);

  const bridgeWatchdog = setInterval(() => {
    ensureMonitorBridgeRunning().catch(() => {});
  }, 10000);

  context.subscriptions.push({
    dispose: () => {
      clearTimeout(startupTimer);
      clearInterval(bridgeWatchdog);
      monitor.stop();
    }
  });
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
