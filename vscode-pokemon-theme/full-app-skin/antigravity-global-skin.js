/**
 * Antigravity Full-App Global Pokemon Skin & v4.1 Shared Overlay Client Runtime
 * - Creature sprites from the active skin pack on the bridge (fetched once, shown via blob: URLs)
 * - Trusted Types Safe (Zero HTML string sinks; SVG built via createElementNS)
 * - v4.1 Single Global Shared OS Floating Window + Context/Cache Ring Gauges:
 *     * ZERO per-window `#pkmn-global-pet-strip` DOM widgets (all windows share ONE OS overlay)
 *     * Top-pill `🪟 召唤/重开全局置顶浮窗` (`POST /api/summon-overlay`)
 *     * Right-pane `Subagents` Party Squad cards with concentric SVG progress rings:
 *         - Outer 🔴 Red (`#EF4444`) = Used Context (`context.usedPct`)
 *         - Inner 🟢 Green (`#22C55E`) = Cache Hit (`context.cacheHitPct`)
 *     * Live two-way 6-theme sync (`POST /api/theme` + `POST /api/ui-sync` + SSE `theme-change`)
 *     * Multi-window telemetry registry (`POST /api/ui-sync` -> `connectedWindows`)
 *     * 3-Stage Progressive Conversation Switcher (`handleFocusSessionCommand` on SSE `focus-session`)
 */
(function () {
  'use strict';

  var DEFAULT_THEME = 'mewtwo';
  var BRIDGE_BASE = 'http://127.0.0.1:17580';
  var SUBAGENT_IDLE_TTL_MS = 60000;
  var FOCUS_TOAST_HIDE_MS = 4200;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var WINDOW_ID = 'agy-win-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);

  if (window.__POKEMON_GLOBAL_SKIN_ACTIVE__) {
    if (typeof window.__POKEMON_GLOBAL_SKIN_REFRESH__ === 'function') {
      window.__POKEMON_GLOBAL_SKIN_REFRESH__(DEFAULT_THEME);
    }
    return;
  }
  window.__POKEMON_GLOBAL_SKIN_ACTIVE__ = true;
  window.__POKEMON_SHARED_OVERLAY_ONLY__ = true;

  // Sprites come from the active skin pack served by the bridge (GET /api/pack). The workbench CSP has no http:
  // in img-src but allows fetch() to 127.0.0.1 (connect-src), so every sprite is fetched once and shown via blob:.
  var BLANK_SPRITE = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var pack = { id: '', version: '', byId: {}, styles: {}, defaultStyle: 'showdown', loading: false, retryAt: 0 };
  var spriteBlobs = {}; // 'packId|style|species|shiny' -> blob URL | 'pending' | 'failed'
  var spriteRefreshTimer = null;

  function hexToRgbTriplet(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    return m ? parseInt(m[1], 16) + ', ' + parseInt(m[2], 16) + ', ' + parseInt(m[3], 16) : '148, 163, 184';
  }

  function metaOf(species) {
    return SPECIES_META[species] || { cn: species || '?', color: '#94a3b8', rgb: '148, 163, 184' };
  }

  function loadPack(force) {
    if (typeof window.fetch !== 'function' || pack.loading) return;
    if (!force && pack.id) return;
    if (!force && Date.now() < pack.retryAt) return;
    pack.loading = true;
    window.fetch(BRIDGE_BASE + '/api/pack', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (p) {
        pack.loading = false;
        if (!p || !p.ok || !Array.isArray(p.creatures)) { pack.retryAt = Date.now() + 15000; return; }
        var oldUrls = spriteBlobs;
        spriteBlobs = {};
        for (var k in oldUrls) {
          if (oldUrls[k] && oldUrls[k].indexOf('blob:') === 0) { try { URL.revokeObjectURL(oldUrls[k]); } catch (_e) {} }
        }
        pack.id = p.id; pack.version = p.version; pack.byId = {}; pack.styles = {};
        pack.defaultStyle = p.defaultStyle;
        for (var s = 0; s < p.styles.length; s++) pack.styles[p.styles[s].id] = p.styles[s];
        SPECIES_ORDER.length = 0;
        for (var key in SPECIES_META) delete SPECIES_META[key];
        for (var i = 0; i < p.creatures.length; i++) {
          var c = p.creatures[i];
          pack.byId[c.id] = c;
          SPECIES_ORDER.push(c.id);
          SPECIES_META[c.id] = { cn: c.short || c.name || c.id, color: c.color || '#94a3b8', rgb: hexToRgbTriplet(c.color) };
        }
        applyRootAttributes();
        refreshAllUi();
      })
      .catch(function () { pack.loading = false; pack.retryAt = Date.now() + 5000; });
  }

  function packStyleId() {
    if (pack.styles[state.spriteStyle]) return state.spriteStyle;
    if (state.spriteStyle === 'pixel') {
      for (var id in pack.styles) if (pack.styles[id].pixelated) return id;
    }
    return pack.defaultStyle;
  }

  function scheduleSpriteRefresh() {
    if (spriteRefreshTimer) return;
    spriteRefreshTimer = setTimeout(function () { spriteRefreshTimer = null; refreshAllUi(); }, 60);
  }

  // Returns a ready blob: URL, or a blank pixel while the sprite downloads (the UI refreshes once it arrives).
  function getSpriteUrl(species, shiny) {
    if (!pack.id) { loadPack(false); return BLANK_SPRITE; }
    var c = pack.byId[species] || pack.byId[SPECIES_ORDER[0]];
    if (!c) return BLANK_SPRITE;
    var styleId = packStyleId();
    var a = c.assets[styleId] || c.assets[pack.defaultStyle] || {};
    var useShinyArt = !!(shiny && a.shinyGif);
    var key = pack.id + '|' + styleId + '|' + c.id + '|' + (useShinyArt ? 1 : 0);
    var v = spriteBlobs[key];
    if (v && v !== 'pending' && v !== 'failed') return v;
    if (!v) {
      var path = (useShinyArt ? a.shinyGif : a.gif) || (a.frameUrls && a.frameUrls[0]) || c.artwork;
      if (!path) { spriteBlobs[key] = 'failed'; return BLANK_SPRITE; }
      spriteBlobs[key] = 'pending';
      var forPack = pack.id;
      window.fetch(BRIDGE_BASE + path, { cache: 'force-cache' })
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
        .then(function (blob) {
          if (forPack !== pack.id) return;
          spriteBlobs[key] = URL.createObjectURL(blob);
          scheduleSpriteRefresh();
        })
        .catch(function () { spriteBlobs[key] = 'failed'; });
    }
    return BLANK_SPRITE;
  }

  // Shiny without real shiny art in the pack: the pack's recolour as a CSS filter.
  function getSpriteFilter(species, shiny) {
    if (!shiny) return '';
    var c = pack.byId[species];
    if (!c) return '';
    var a = c.assets[packStyleId()] || {};
    return a.shinyGif ? '' : ((c.shiny && c.shiny.cssFilter) || '');
  }

  // The theme pill shows the theme's mascot when the pack has it, otherwise the pack's first creature.
  function themeSpecies() {
    var sp = getThemeInfo(state.theme).species;
    if (!pack.id || pack.byId[sp]) return sp;
    return SPECIES_ORDER[0] || sp;
  }

  var THEMES = [
    { id: 'mewtwo', label: '🔮 灵能紫', short: '灵能紫', species: 'mewtwo' },
    { id: 'pikachu', label: '⚡ 电光黄', short: '电光黄', species: 'pikachu' },
    { id: 'gengar', label: '🟣 暗影紫', short: '暗影紫', species: 'gengar' },
    { id: 'charizard', label: '🔥 烈焰橙', short: '烈焰橙', species: 'charizard' },
    { id: 'umbreon', label: '🌙 月夜黑', short: '月夜黑', species: 'umbreon' },
    { id: 'pokedex-light', label: '☀️ 晨光浅色', short: '晨光', species: 'rotom' }
  ];

  var SPECIES_META = {}; // species -> { cn, color, rgb }, from the active skin pack

  var SPECIES_ORDER = []; // creature ids of the active skin pack


  function safeGetStorage(key, fallback) {
    try {
      var val = window.localStorage.getItem(key);
      return val !== null ? val : fallback;
    } catch (_e) {
      return fallback;
    }
  }

  function safeSetStorage(key, val) {
    try {
      window.localStorage.setItem(key, val);
    } catch (_e) {}
  }

  function toBridgeThemeId(localTheme) {
    if (localTheme === 'pokedex-light') return 'rotom-light';
    return localTheme || 'mewtwo';
  }

  function fromBridgeThemeId(remoteTheme) {
    var r = String(remoteTheme || '').trim().toLowerCase();
    if (!r) return '';
    if (r === 'rotom-light' || r === 'rotom') return 'pokedex-light';
    return isValidTheme(r) ? r : '';
  }

  function isValidTheme(t) {
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === t) return true;
    }
    return false;
  }

  var prevStamp = safeGetStorage('pkmn_global_theme_stamp', '');
  if (prevStamp !== DEFAULT_THEME) {
    safeSetStorage('pkmn_global_theme_stamp', DEFAULT_THEME);
    safeSetStorage('pkmn_global_theme', DEFAULT_THEME);
  }

  var state = {
    theme: safeGetStorage('pkmn_global_theme', DEFAULT_THEME),
    spriteStyle: safeGetStorage('pkmn_sprite_style', 'showdown') === 'pixel' ? 'pixel' : 'showdown',
    partyTwoCol: safeGetStorage('pkmn_party_2col', '1') !== '0',
    menuOpen: false,
    agents: [],
    agentsById: new Map(),
    agentsByName: new Map(),
    bridgeProjects: [],
    hasV3BridgeProjects: false,
    bridgeConnected: false,
    hostPid: typeof window.__POKEMON_HOST_PID__ === 'number' ? window.__POKEMON_HOST_PID__ : 0,
    lastSeenBridgeTheme: '',
    localSubagentIdleSince: new Map(),
    localLeadIdleSince: new Map(),
    handledFocusRequestIds: new Set(),
    focusToastTimer: null,
    lastDomScan: {
      hasChatDom: false,
      workspacePath: '',
      conversationId: '',
      projectName: '',
      conversationTitle: '',
      subagents: [],
      mainAgent: null
    },
    lastUiSyncSig: '',
    lastUiSyncAt: 0
  };

  if (!isValidTheme(state.theme)) {
    state.theme = DEFAULT_THEME;
  }

  function getThemeInfo(themeId) {
    for (var i = 0; i < THEMES.length; i++) {
      if (THEMES[i].id === themeId) return THEMES[i];
    }
    return THEMES[0];
  }

  function hashSpecies(str) {
    var s = String(str || 'mewtwo');
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    if (!SPECIES_ORDER.length) return getThemeInfo(state.theme).species;
    var idx = Math.abs(h) % SPECIES_ORDER.length;
    return SPECIES_ORDER[idx];
  }

  function resolveSpecies(agentObj, fallbackName, isLead) {
    if (agentObj && agentObj.pokemonSpecies && (!pack.id || pack.byId[agentObj.pokemonSpecies])) {
      return agentObj.pokemonSpecies;
    }
    var key = String((agentObj && agentObj.name) || fallbackName || '').toLowerCase().trim();
    if (!key || key === 'main-agent' || key === 'lead-agent' || key === 'agent' || key === '主智能体') {
      return themeSpecies();
    }
    if (isLead) {
      return themeSpecies();
    }
    return hashSpecies(key);
  }


  function applyRootAttributes() {
    var root = document.documentElement;
    if (!root) return;
    if (root.getAttribute('data-pokemon-theme') !== state.theme) {
      root.setAttribute('data-pokemon-theme', state.theme);
    }
    if (root.getAttribute('data-pokemon-sprite-style') !== state.spriteStyle) {
      root.setAttribute('data-pokemon-sprite-style', state.spriteStyle);
    }
  }

  function syncThemeToBridge(localTheme) {
    if (typeof window.fetch !== 'function') return;
    var bridgeTheme = toBridgeThemeId(localTheme);
    state.lastSeenBridgeTheme = localTheme;
    window.fetch(BRIDGE_BASE + '/api/theme', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme: bridgeTheme,
        source: 'global-skin-pill:' + WINDOW_ID
      })
    }).catch(function () {});
    pushUiSyncIfNeeded(true, true);
  }

  function setTheme(themeId, broadcastToBridge) {
    if (!isValidTheme(themeId)) return;
    var changed = state.theme !== themeId;
    state.theme = themeId;
    safeSetStorage('pkmn_global_theme', themeId);
    applyRootAttributes();
    refreshAllUi();
    if (broadcastToBridge) {
      syncThemeToBridge(themeId);
    } else if (changed) {
      pushUiSyncIfNeeded(true, false);
    }
  }

  function applyRemoteThemeIfNeeded(remoteThemeRaw, forceApply) {
    var mapped = fromBridgeThemeId(remoteThemeRaw);
    if (!mapped) return;
    var prevSeen = state.lastSeenBridgeTheme;
    state.lastSeenBridgeTheme = mapped;
    if (forceApply || (prevSeen && prevSeen !== mapped)) {
      if (state.theme !== mapped) {
        state.theme = mapped;
        safeSetStorage('pkmn_global_theme', mapped);
        applyRootAttributes();
        updateTopPillAndMenu();
        decorateAllSubagentNodes();
      }
    }
  }

  function toggleSpriteStyle() {
    state.spriteStyle = state.spriteStyle === 'showdown' ? 'pixel' : 'showdown';
    safeSetStorage('pkmn_sprite_style', state.spriteStyle);
    applyRootAttributes();
    refreshAllUi();
  }

  function togglePartyColumns() {
    state.partyTwoCol = !state.partyTwoCol;
    safeSetStorage('pkmn_party_2col', state.partyTwoCol ? '1' : '0');
    refreshAllUi();
  }

  // Ensure zero legacy per-window pet strip widgets remain in any BrowserWindow DOM
  function removeLegacyInWindowPetStrip() {
    if (!document || typeof document.getElementById !== 'function') return;
    var legacy = document.getElementById('pkmn-global-pet-strip');
    if (legacy && legacy.parentNode) {
      legacy.parentNode.removeChild(legacy);
    }
  }

  // ==========================================================================
  // 1. Live Window DOM Header, Session Metadata & Agent Scanner
  // ==========================================================================

  function detectAppKind() {
    var href = String((window.location && window.location.href) || '');
    if (href.indexOf('workbench-jetski-agent') !== -1) return 'jetski';
    if (href.indexOf('workbench.html') !== -1 || (document && document.querySelector && document.querySelector('.monaco-workbench'))) {
      return 'workbench';
    }
    return 'hub';
  }

  function extractWorkerNameFromText(rawTitle) {
    if (!rawTitle) return '';
    var txt = String(rawTitle).trim();
    var mRole = txt.match(/(?:Swarm\s+Worker|Subagent|Worker|Agent)\s*\(([^()]+)\)/i);
    if (mRole && mRole[1]) return mRole[1].trim();
    var mParen = txt.match(/\(([^()]+)\)\s*$/);
    if (mParen && mParen[1]) return mParen[1].trim();
    return txt;
  }

  function getReactSpans(node) {
    var raw = node.querySelectorAll('span:not(.pkmn-party-badge)');
    var list = [];
    for (var i = 0; i < raw.length; i++) {
      var s = raw[i];
      if (s.closest && s.closest('div[data-pkmn-party-deco="1"]')) continue;
      list.push(s);
    }
    return list;
  }

  function isHiddenOrExiting(el) {
    if (!el) return true;
    if (el.closest && (
      el.closest('[aria-hidden="true"]') ||
      el.closest('[inert]') ||
      el.closest('[data-ending-style]') ||
      el.closest('#pkmn-focus-session-toast') ||
      el.closest('#pkmn-global-skin-pill') ||
      el.closest('#pkmn-global-skin-menu')
    )) {
      return true;
    }
    return false;
  }

  function extractWorkspacePathHint() {
    try {
      if (window.location && window.location.search) {
        var params = new URLSearchParams(window.location.search);
        var folderUri = params.get('folder') || params.get('workspace') || '';
        if (folderUri) return folderUri;
        var configRaw = params.get('config');
        if (configRaw) {
          var cfg = JSON.parse(configRaw);
          if (cfg && (cfg.folderUri || cfg.workspaceUri)) {
            return String(cfg.folderUri || cfg.workspaceUri);
          }
        }
      }
    } catch (_e) {}
    return '';
  }

  function extractWindowSessionMeta() {
    var projectName = '';
    var conversationTitle = '';
    var conversationId = '';
    var workspacePath = extractWorkspacePathHint();

    var viewingSubagentTab = false;
    var subTabTitleEl = document.querySelector('[data-testid="subagent-tab-header-title"]');
    if (subTabTitleEl && !isHiddenOrExiting(subTabTitleEl)) {
      viewingSubagentTab = true;
    }

    // 1. Breadcrumb segments in Antigravity Hub & workbench-jetski-agent (`span[data-testid="breadcrumb-segment"]`)
    var rawSegs = document.querySelectorAll('span[data-testid="breadcrumb-segment"]');
    var segs = [];
    for (var i = 0; i < rawSegs.length; i++) {
      if (isHiddenOrExiting(rawSegs[i])) continue;
      var t = (rawSegs[i].textContent || '').trim();
      if (t) segs.push(t);
    }
    if (segs.length >= 2 && segs[0] !== 'Customizations' && segs[0] !== 'Command Center') {
      projectName = segs[0];
      conversationTitle = (viewingSubagentTab && segs.length >= 3) ? segs[1] : segs[segs.length - 1];
    } else if (segs.length === 1 && segs[0] !== 'Customizations' && segs[0] !== 'Command Center') {
      conversationTitle = segs[0];
    }

    // 2. Split-pane embedded header fallback (`h3.flex.items-center.text-sm.truncate`)
    if (!projectName && !conversationTitle) {
      var splitHeaders = document.querySelectorAll('h3');
      for (var hIdx = 0; hIdx < splitHeaders.length; hIdx++) {
        var h3 = splitHeaders[hIdx];
        if (isHiddenOrExiting(h3)) continue;
        var hCls = String(h3.className || '');
        if (hCls.indexOf('truncate') === -1 && hCls.indexOf('items-center') === -1) continue;
        var opSpan = h3.querySelector('span.opacity-50');
        var curSpans = h3.querySelectorAll('span.cursor-pointer, span.truncate');
        if (opSpan) projectName = (opSpan.textContent || '').trim();
        if (curSpans.length > 0) {
          conversationTitle = (curSpans[curSpans.length - 1].textContent || '').trim();
        }
        if (projectName || conversationTitle) break;
      }
    }

    // 3. Selected conversation row in left sidebar (`div[data-testid^="conversation-row-"][data-selected="true"]`)
    var selectedRow = document.querySelector(
      'div[data-testid="conversation-row-sidebar"][data-selected="true"], div[data-testid="conversation-row-history"][data-selected="true"]'
    );
    if (selectedRow && !isHiddenOrExiting(selectedRow)) {
      var rowCid = (selectedRow.getAttribute('data-cascade-id') || '').trim();
      if (rowCid) conversationId = rowCid;
      if (!conversationTitle) {
        var linkEl = selectedRow.querySelector('a[aria-label]');
        if (linkEl) {
          conversationTitle = (linkEl.getAttribute('aria-label') || '').trim();
        }
      }
      if (!projectName) {
        var subtxt = (selectedRow.getAttribute('data-subtext') || '').trim();
        if (subtxt && subtxt.length < 64) projectName = subtxt;
      }
    }

    // 4. URL UUID extraction when not viewing a subagent tab
    if (!conversationId && !viewingSubagentTab && window.location) {
      var locStr = String(window.location.pathname || '') + ' ' + String(window.location.hash || '');
      var uuidMatch = locStr.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      if (uuidMatch) conversationId = uuidMatch[0];
    }

    // 5. Classic VS Code `workbench.html` `document.title` fallback ("<file> - <projectName> - Antigravity")
    var docTitle = String(document.title || '').trim();
    if (docTitle) {
      var parts = docTitle.split(/\s+[-—]\s+/);
      if (parts.length >= 2 && /Antigravity|VS Code|Code/i.test(parts[parts.length - 1])) {
        var candidateProj = parts[parts.length - 2].trim();
        if (!projectName && candidateProj && !/^(Antigravity|Welcome|Untitled)/i.test(candidateProj)) {
          projectName = candidateProj;
        }
        if (!conversationTitle && parts.length >= 3) {
          conversationTitle = parts[0].trim();
        }
      }
    }

    return {
      workspacePath: workspacePath,
      conversationId: conversationId,
      projectName: projectName,
      conversationTitle: conversationTitle,
      viewingSubagentTab: viewingSubagentTab
    };
  }

  function classifyNodeState(subText, hasSpinner, isKilled, bridgeAgent) {
    var txt = String(subText || '').toLowerCase();
    if (isKilled || txt.indexOf('killed') !== -1 || txt.indexOf('failed') !== -1 || txt.indexOf('terminated') !== -1 || txt.indexOf('canceled') !== -1) {
      return 'killed';
    }
    if (txt.indexOf('thinking') !== -1 || txt.indexOf('planning') !== -1 || txt.indexOf('reasoning') !== -1) {
      return 'thinking';
    }
    if (hasSpinner || txt.indexOf('working') !== -1 || txt.indexOf('running') !== -1 || txt.indexOf('executing') !== -1) {
      if (bridgeAgent && bridgeAgent.state === 'thinking') return 'thinking';
      return 'working';
    }
    if (bridgeAgent && bridgeAgent.state) {
      var bs = String(bridgeAgent.state).toLowerCase();
      if (bs === 'thinking') return 'thinking';
      if (bs === 'working' || bs === 'celebrating') return 'working';
      if (bs === 'error') return 'killed';
    }
    return 'sleeping';
  }

  function scanLiveDomAgents() {
    var meta = extractWindowSessionMeta();
    var byKey = new Map();
    var order = [];

    function upsertSubagent(entry) {
      if (!entry || !entry.name) return;
      var normName = entry.name.toLowerCase().trim();
      if (!normName) return;
      var key = entry.id ? ('id:' + entry.id) : ('name:' + normName);
      var existingKey = null;
      if (byKey.has(key)) {
        existingKey = key;
      } else if (entry.id && byKey.has('name:' + normName)) {
        existingKey = 'name:' + normName;
      } else {
        byKey.forEach(function (val, k) {
          if (val.name.toLowerCase() === normName) existingKey = k;
        });
      }

      if (!existingKey) {
        byKey.set(key, entry);
        order.push(key);
        return;
      }

      var cur = byKey.get(existingKey);
      if (entry.id && !cur.id) cur.id = entry.id;
      if (entry.activeInTray) {
        cur.activeInTray = true;
        if (cur.state === 'sleeping') {
          cur.state = entry.state || 'working';
        }
      }
      if (entry.state === 'thinking' || (entry.state === 'working' && cur.state === 'sleeping') || entry.state === 'killed') {
        if (!cur.activeInTray || entry.state !== 'killed') {
          cur.state = entry.state;
        }
      }
      if (entry.statusText && (!cur.statusText || entry.fromSidebar)) {
        cur.statusText = entry.statusText;
      }
    }

    // A1. Composer Running Items Panel (`N subagent(s) running` tray above input box)
    var runningPanels = document.querySelectorAll('[data-testid="running-items-panel"], [data-testid="running-items-card"], [data-testid="running-items-subagents"]');
    var foundRunningTray = false;

    for (var pIdx = 0; pIdx < runningPanels.length; pIdx++) {
      var panel = runningPanels[pIdx];
      var cls = String(panel.className || '');
      if (cls.indexOf('grid-rows-[0fr]') !== -1) continue;
      if (isHiddenOrExiting(panel)) continue;
      foundRunningTray = true;

      var tooltipItems = panel.querySelectorAll('[data-tooltip-id^="label-subagent-"]');
      for (var tIdx = 0; tIdx < tooltipItems.length; tIdx++) {
        var itemEl = tooltipItems[tIdx];
        if (isHiddenOrExiting(itemEl)) continue;
        var tid = itemEl.getAttribute('data-tooltip-id') || '';
        var convId = tid.slice('label-subagent-'.length);
        var firstSpan = itemEl.querySelector('span');
        var rawLabel = (firstSpan ? firstSpan.textContent : itemEl.textContent) || '';
        var workerName = extractWorkerNameFromText(rawLabel);
        if (!workerName) continue;
        var isThinkingLabel = /thinking|planning|reasoning/i.test(rawLabel);
        upsertSubagent({
          id: convId,
          name: workerName,
          role: 'worker',
          isLead: false,
          state: isThinkingLabel ? 'thinking' : 'working',
          statusText: rawLabel.trim(),
          activeInTray: true
        });
      }

      var textCandidates = panel.querySelectorAll('button, span, div, li');
      for (var cIdx = 0; cIdx < textCandidates.length; cIdx++) {
        var cEl = textCandidates[cIdx];
        if (cEl.children && cEl.children.length > 3) continue;
        if (isHiddenOrExiting(cEl)) continue;
        var cTxt = (cEl.textContent || '').trim();
        var mWorker = cTxt.match(/^(?:Swarm\s+Worker|Subagent)\s*\(([^()]+)\)$/i);
        if (mWorker && mWorker[1]) {
          upsertSubagent({
            id: '',
            name: mWorker[1].trim(),
            role: 'worker',
            isLead: false,
            state: /thinking|planning/i.test(cTxt) ? 'thinking' : 'working',
            statusText: cTxt,
            activeInTray: true
          });
        }
      }
    }

    // A2. Generic composer tray fallback outside message history
    if (order.length === 0) {
      var allEls = document.querySelectorAll('button, span, div');
      for (var gIdx = 0; gIdx < allEls.length; gIdx++) {
        var gEl = allEls[gIdx];
        if (gEl.children && gEl.children.length > 2) continue;
        if (isHiddenOrExiting(gEl)) continue;
        if (gEl.closest && (
          gEl.closest('[data-testid="turn-cards-container"]') ||
          gEl.closest('[data-testid="user-message-bubble"]') ||
          gEl.closest('[data-testid="agent-response"]')
        )) {
          continue;
        }
        var hdrTxt = (gEl.textContent || '').trim();
        if (/^\d+\s+subagents?(?:\/tasks)?\s+running\b/i.test(hdrTxt)) {
          foundRunningTray = true;
          var trayRoot = (gEl.parentElement && gEl.parentElement.parentElement) || gEl.parentElement;
          if (trayRoot) {
            var trayRows = trayRoot.querySelectorAll('span, div, button, li');
            for (var rIdx = 0; rIdx < trayRows.length; rIdx++) {
              var rEl = trayRows[rIdx];
              if (isHiddenOrExiting(rEl)) continue;
              var rTxt = (rEl.textContent || '').trim();
              var rMatch = rTxt.match(/(?:Swarm\s+Worker|Subagent)\s*\(([^()]+)\)/i);
              if (rMatch && rMatch[1] && rTxt.length < 90) {
                upsertSubagent({
                  id: '',
                  name: rMatch[1].trim(),
                  role: 'worker',
                  isLead: false,
                  state: /thinking|planning/i.test(rTxt) ? 'thinking' : 'working',
                  statusText: rTxt,
                  activeInTray: true
                });
              }
            }
          }
          break;
        }
      }
    }

    // B. Right Auxiliary Pane Subagents nodes (`div[data-testid="subagent-node"]`)
    var subNodes = document.querySelectorAll('div[data-testid="subagent-node"]');
    for (var sIdx = 0; sIdx < subNodes.length; sIdx++) {
      var sNode = subNodes[sIdx];
      if (isHiddenOrExiting(sNode)) continue;
      var sConvId = sNode.getAttribute('data-cascade-id') || '';
      var spans = getReactSpans(sNode);
      var titleText = spans.length > 0 ? (spans[0].textContent || '') : '';
      var subText = spans.length > 1 ? (spans[spans.length - 1].textContent || '') : '';
      var wName = extractWorkerNameFromText(titleText);
      if (!wName) continue;

      var hasSpinner = !!sNode.querySelector('[data-testid="status-loading-spinner"], [data-testid="subagent-stop"]');
      var isKilled = !!sNode.querySelector('[data-testid="agent-status-killed"]');
      var domState = classifyNodeState(subText, hasSpinner, isKilled, null);

      upsertSubagent({
        id: sConvId,
        name: wName,
        role: 'worker',
        isLead: false,
        state: domState,
        statusText: (subText || titleText || '').trim(),
        activeInTray: hasSpinner,
        fromSidebar: true
      });
    }

    // C. Main Chat / Lead Agent live state in current window
    var hasChatDom = foundRunningTray || subNodes.length > 0 || !!document.querySelector(
      '[data-testid="conversation-view"], [data-testid="agent-input-box"], [data-testid="turn-cards-container"], [data-testid="idle-status-text"]'
    );

    var cancelBtn = document.querySelector(
      'button[data-tooltip-id="input-send-button-cancel-tooltip"], button[aria-label^="Cancel ("], button[aria-label*="Stop" i], [data-testid="send-button-pending"], [data-testid="stop-button"], [data-testid="cancel-button"]'
    );
    var agentLoadingEl = document.querySelector('[data-testid="agent-loading"]');
    if (agentLoadingEl && isHiddenOrExiting(agentLoadingEl)) agentLoadingEl = null;
    var loadingTxt = agentLoadingEl ? (agentLoadingEl.textContent || '').trim() : '';

    var thinkingTriggers = document.querySelectorAll('[data-testid="thinking-collapsible-trigger"]');
    var activeThinkingTxt = '';
    if (thinkingTriggers.length > 0) {
      var lastTrig = thinkingTriggers[thinkingTriggers.length - 1];
      if (!isHiddenOrExiting(lastTrig)) {
        var trigTxt = (lastTrig.textContent || '').trim();
        if (/^Thinking\b/i.test(trigTxt)) {
          activeThinkingTxt = trigTxt;
        }
      }
    }

    var activeToolGroupLabel = '';
    var toolGroups = document.querySelectorAll('[data-testid="tool-group-collapsible"]');
    if (toolGroups.length > 0) {
      var lastGroup = toolGroups[toolGroups.length - 1];
      if (!isHiddenOrExiting(lastGroup)) {
        var ga = (lastGroup.getAttribute('aria-label') || '').trim();
        if (/^Thinking\b/i.test(ga)) {
          activeThinkingTxt = activeThinkingTxt || ga;
        } else if (/^(?:Working|Running|Editing|Exploring|Reading|Searching|Writing)\b/i.test(ga)) {
          activeToolGroupLabel = ga;
        }
      }
    }
    if (!activeThinkingTxt) {
      var pulseSpans = document.querySelectorAll('span.animate-pulse');
      for (var psIdx = 0; psIdx < pulseSpans.length; psIdx++) {
        var ps = pulseSpans[psIdx];
        if (isHiddenOrExiting(ps)) continue;
        var psTxt = (ps.textContent || '').trim();
        if (/^Thinking/i.test(psTxt)) {
          activeThinkingTxt = psTxt;
          break;
        }
      }
    }

    var convSpinners = document.querySelectorAll(
      '[data-testid="conversation-view"] [data-testid="status-loading-spinner"], [data-testid="turn-cards-container"] [data-testid="status-loading-spinner"]'
    );
    var hasMainSpinner = false;
    for (var spIdx = 0; spIdx < convSpinners.length; spIdx++) {
      var sp = convSpinners[spIdx];
      if (!sp.closest('div[data-testid="subagent-node"]') && !isHiddenOrExiting(sp)) {
        hasMainSpinner = true;
        break;
      }
    }

    var mainState = 'sleeping';
    var mainStatus = '💤 领队待命中 · 单击看会话/双击弹起';
    if (activeThinkingTxt || /thinking|reasoning|planning/i.test(loadingTxt)) {
      mainState = 'thinking';
      mainStatus = '💭 ' + (activeThinkingTxt || loadingTxt || '正在思考推理...');
    } else if (cancelBtn || agentLoadingEl || hasMainSpinner || activeToolGroupLabel) {
      mainState = 'working';
      mainStatus = '⚡ ' + (activeToolGroupLabel || loadingTxt || '正在执行任务...');
    }

    var subList = [];
    for (var kIdx = 0; kIdx < order.length; kIdx++) {
      var item = byKey.get(order[kIdx]);
      if (item) subList.push(item);
    }

    var mainId = meta.conversationId || ('main-' + WINDOW_ID);
    var mainAgentObj = hasChatDom ? {
      id: mainId,
      name: '主智能体',
      role: 'main-agent',
      isLead: true,
      state: mainState,
      statusText: mainStatus
    } : null;

    var result = {
      hasChatDom: hasChatDom,
      workspacePath: meta.workspacePath,
      conversationId: meta.conversationId,
      projectName: meta.projectName,
      conversationTitle: meta.conversationTitle,
      viewingSubagentTab: meta.viewingSubagentTab,
      leadAgent: mainAgentObj,
      subagents: subList,
      mainAgent: mainAgentObj
    };
    state.lastDomScan = result;
    return result;
  }

  // ==========================================================================
  // 2. Effective Project-Grouped Queue Data Model (for Top Pill Count & QA Hooks)
  // ==========================================================================

  function computeSubagentIdleMs(sub, convKey, now) {
    var key = String(sub.id || (convKey + ':' + (sub.name || 'sub'))).toLowerCase();
    var st = String(sub.state || 'sleeping').toLowerCase();
    if (st !== 'sleeping') {
      state.localSubagentIdleSince.delete(key);
      return 0;
    }
    if (typeof sub.idleMs === 'number' && isFinite(sub.idleMs)) {
      return Math.max(0, sub.idleMs);
    }
    if (sub.idleSince) {
      var parsedTs = typeof sub.idleSince === 'number' ? sub.idleSince : Date.parse(sub.idleSince);
      if (isFinite(parsedTs) && parsedTs > 0) {
        return Math.max(0, now - parsedTs);
      }
    }
    if (!state.localSubagentIdleSince.has(key)) {
      state.localSubagentIdleSince.set(key, now);
    }
    return Math.max(0, now - state.localSubagentIdleSince.get(key));
  }

  function computeLeadIdleMs(lead, convKey, now) {
    var key = String(lead.id || ('lead:' + convKey)).toLowerCase();
    var st = String(lead.state || 'sleeping').toLowerCase();
    if (st !== 'sleeping') {
      state.localLeadIdleSince.delete(key);
      return 0;
    }
    if (typeof lead.idleMs === 'number' && isFinite(lead.idleMs)) {
      return Math.max(0, lead.idleMs);
    }
    if (lead.idleSince) {
      var parsedTs = typeof lead.idleSince === 'number' ? lead.idleSince : Date.parse(lead.idleSince);
      if (isFinite(parsedTs) && parsedTs > 0) {
        return Math.max(0, now - parsedTs);
      }
    }
    if (!state.localLeadIdleSince.has(key)) {
      state.localLeadIdleSince.set(key, now);
    }
    return Math.max(0, now - state.localLeadIdleSince.get(key));
  }

  function normalizeStateValue(rawState) {
    var s = String(rawState || 'sleeping').toLowerCase();
    if (s === 'thinking') return 'thinking';
    if (s === 'working' || s === 'celebrating') return 'working';
    if (s === 'killed') return 'killed';
    if (s === 'error') return 'error';
    return 'sleeping';
  }

  function findBridgeMatch(domAgent) {
    if (!domAgent) return null;
    if (domAgent.id && state.agentsById.has(domAgent.id)) {
      return state.agentsById.get(domAgent.id);
    }
    var key = String(domAgent.name || '').toLowerCase().trim();
    if (key && state.agentsByName.has(key)) {
      return state.agentsByName.get(key);
    }
    return null;
  }

  function formatTokenShort(numVal) {
    var n = Math.max(0, Math.round(Number(numVal) || 0));
    if (n >= 1000000) {
      return (Math.round((n / 1000000) * 10) / 10).toString().replace(/\.0$/, '') + 'M';
    }
    if (n >= 100000) {
      return Math.round(n / 1000) + 'k';
    }
    if (n >= 1000) {
      return (Math.round((n / 1000) * 10) / 10).toString().replace(/\.0$/, '') + 'k';
    }
    return String(n);
  }

  function normalizeAgentContext(rawCtx, agentLike) {
    var c = (rawCtx && typeof rawCtx === 'object') ? rawCtx : {};
    var a = (agentLike && typeof agentLike === 'object') ? agentLike : {};
    var maxTokens = Number(c.maxTokens || c.contextMaxTokens || a.contextMaxTokens || 200000);
    if (!isFinite(maxTokens) || maxTokens <= 0) maxTokens = 200000;

    var rawUsed = c.usedTokens !== undefined ? c.usedTokens : (c.contextUsedTokens !== undefined ? c.contextUsedTokens : a.contextUsedTokens);
    var usedTokens = Math.max(0, Math.round(Number(rawUsed) || 0));

    var rawUsedPct = c.usedPct !== undefined ? c.usedPct : (c.contextUsedPct !== undefined ? c.contextUsedPct : a.contextUsedPct);
    var usedPct = (typeof rawUsedPct === 'number' && isFinite(rawUsedPct))
      ? Math.max(0, Math.min(100, rawUsedPct))
      : Math.max(0, Math.min(100, (usedTokens / maxTokens) * 100));

    var rawCached = c.cachedTokens !== undefined ? c.cachedTokens : (c.cacheHitTokens !== undefined ? c.cacheHitTokens : a.cacheHitTokens);
    var cachedTokens = Math.max(0, Math.round(Number(rawCached) || 0));

    var rawCachePct = c.cacheHitPct !== undefined ? c.cacheHitPct : a.cacheHitPct;
    var cacheHitPct = (typeof rawCachePct === 'number' && isFinite(rawCachePct))
      ? Math.max(0, Math.min(100, rawCachePct))
      : (usedTokens > 0 ? Math.max(0, Math.min(100, (cachedTokens / usedTokens) * 100)) : 0);

    var rawUncached = c.uncachedTokens !== undefined ? c.uncachedTokens : Math.max(0, usedTokens - cachedTokens);
    var uncachedTokens = Math.max(0, Math.round(Number(rawUncached) || 0));
    var usedRound = Math.round(usedPct * 10) / 10;
    var cacheRound = Math.round(cacheHitPct * 10) / 10;
    var usedLbl = c.usedTokensLabel || formatTokenShort(usedTokens);
    var maxLbl = c.maxTokensLabel || formatTokenShort(maxTokens);

    return {
      usedTokens: usedTokens,
      remainingTokens: Math.max(0, maxTokens - usedTokens),
      maxTokens: maxTokens,
      usedPct: usedRound,
      cachedTokens: cachedTokens,
      cacheHitPct: cacheRound,
      cacheKnown: c.cacheKnown !== false,
      cacheWarm: c.cacheWarm !== false,
      cacheLastRequestPct: c.cacheLastRequestPct !== undefined ? Number(c.cacheLastRequestPct) : cacheRound,
      cacheRecentPct: c.cacheRecentPct !== undefined ? Number(c.cacheRecentPct) : cacheRound,
      cacheRequests: Number(c.cacheRequests) || 0,
      uncachedTokens: uncachedTokens,
      promptTokens: Math.max(0, Math.round(Number(c.promptTokens) || (cachedTokens + uncachedTokens))),
      outputTokens: Math.max(0, Math.round(Number(c.outputTokens) || 0)),
      tps: (c.tps !== null && c.tps !== undefined && isFinite(Number(c.tps))) ? Number(c.tps) : null,
      avgTps: (c.avgTps !== null && c.avgTps !== undefined && isFinite(Number(c.avgTps))) ? Number(c.avgTps) : null,
      ttfpMs: (c.ttfpMs !== null && c.ttfpMs !== undefined && isFinite(Number(c.ttfpMs))) ? Number(c.ttfpMs) : null,
      lastTurnDurationMs: (c.lastTurnDurationMs !== null && c.lastTurnDurationMs !== undefined && isFinite(Number(c.lastTurnDurationMs))) ? Number(c.lastTurnDurationMs) : null,
      totalOutputTokens: (c.totalOutputTokens !== null && c.totalOutputTokens !== undefined && isFinite(Number(c.totalOutputTokens))) ? Number(c.totalOutputTokens) : 0,
      usedTokensLabel: String(usedLbl),
      maxTokensLabel: String(maxLbl),
      usedLabel: String(c.usedLabel || (usedLbl + ' / ' + maxLbl)),
      badgeText: String(c.badgeText || ('🔴 ' + Math.round(usedRound) + '% · 🟢 ' + Math.round(cacheRound) + '%')),
      tooltipText: String(c.tooltipText || (
        '🔴 已用上下文: ' + usedLbl + ' / ' + maxLbl + ' (' + usedRound + '%) | 🟢 缓存命中: ' +
        formatTokenShort(cachedTokens) + ' (' + Math.round(cacheRound) + '%)'
      )),
      modelContextLabel: String(c.modelContextLabel || (maxLbl + ' ctx'))
    };
  }

  function formatContextTooltip(ctx) {
    var norm = normalizeAgentContext(ctx, null);
    return norm.tooltipText;
  }

  function enrichSubagentWithBridge(domSub, convKey, now) {
    var b = findBridgeMatch(domSub);
    var species = resolveSpecies(b, domSub.name, false);
    var mergedState = normalizeStateValue(domSub.state);
    var mergedStatus = domSub.statusText || '';
    var explicitIdleMs = domSub.idleMs;
    var explicitIdleSince = domSub.idleSince;

    if (b) {
      var bState = normalizeStateValue(b.state);
      if (domSub.activeInTray) {
        if (bState === 'thinking') mergedState = 'thinking';
        else if (bState === 'working') mergedState = 'working';
      } else if (mergedState !== 'killed') {
        if (bState === 'thinking' || bState === 'working') {
          mergedState = bState;
        }
      }
      if (b.statusText && (bState === mergedState || (domSub.activeInTray && (bState === 'thinking' || bState === 'working')))) {
        mergedStatus = b.statusText;
      }
      if (mergedState === 'sleeping') {
        if (typeof b.idleMs === 'number') explicitIdleMs = b.idleMs;
        if (b.idleSince) explicitIdleSince = b.idleSince;
      }
    }

    var candidate = {
      id: (b && b.id) || domSub.id || (convKey + ':' + domSub.name),
      name: domSub.name,
      role: domSub.role || 'worker',
      isLead: false,
      species: species,
      state: mergedState,
      statusText: mergedStatus,
      idleMs: explicitIdleMs,
      idleSince: explicitIdleSince,
      context: normalizeAgentContext((b && b.context) || domSub.context, b || domSub)
    };
    candidate.idleMs = computeSubagentIdleMs(candidate, convKey, now);
    return candidate;
  }

  function normalizeQueueRecord(rawQ, now, fallbackProjName) {
    if (!rawQ) return null;
    var convId = String(rawQ.conversationId || rawQ.id || ('queue-' + Math.random().toString(36).slice(2, 8)));
    var projName = String(rawQ.projectName || fallbackProjName || '全局会话').trim() || '全局会话';
    var convTitle = String(rawQ.conversationTitle || rawQ.headerTitle || rawQ.swarmTitle || '当前智能体会话').trim() || '当前智能体会话';

    var rawSubs = Array.isArray(rawQ.subagents) ? rawQ.subagents : [];
    var keptSubs = [];
    for (var i = 0; i < rawSubs.length; i++) {
      var rs = rawSubs[i];
      if (!rs) continue;
      var sState = normalizeStateValue(rs.state);
      if (sState === 'killed') continue;
      var sIdleMs = computeSubagentIdleMs({
        id: rs.id,
        name: rs.name,
        state: sState,
        idleMs: rs.idleMs,
        idleSince: rs.idleSince
      }, convId, now);
      if (sState === 'sleeping' && sIdleMs > SUBAGENT_IDLE_TTL_MS) {
        continue;
      }
      var sSpecies = resolveSpecies(rs, rs.name, false);
      keptSubs.push({
        id: rs.id || (convId + ':sub-' + (i + 1)),
        name: rs.name || ('sub-' + (i + 1)),
        role: rs.role || 'worker',
        isLead: false,
        queueIndex: keptSubs.length + 1,
        conversationId: convId,
        conversationTitle: convTitle,
        projectName: projName,
        species: sSpecies,
        state: sState,
        statusText: rs.statusText || '',
        idleMs: sIdleMs,
        remainingTtlMs: sState === 'sleeping' ? Math.max(0, SUBAGENT_IDLE_TTL_MS - sIdleMs) : null,
        context: normalizeAgentContext(rs.context, rs)
      });
    }

    var hasActiveSubagent = false;
    for (var a = 0; a < keptSubs.length; a++) {
      if (keptSubs[a].state !== 'sleeping') {
        hasActiveSubagent = true;
        break;
      }
    }

    var rawLead = rawQ.leadAgent || {
      id: convId + ':lead',
      name: metaOf(themeSpecies()).cn,
      role: 'main-agent',
      state: 'sleeping',
      statusText: '💤 领队待命中 · 单击看会话/双击弹起'
    };
    var leadState = normalizeStateValue(rawLead.state);
    if (leadState === 'killed') leadState = 'sleeping';
    var leadIdleMs = computeLeadIdleMs({
      id: rawLead.id || convId,
      state: leadState,
      idleMs: rawLead.idleMs,
      idleSince: rawLead.idleSince
    }, convId, now);
    var leadSpecies = resolveSpecies(rawLead, rawLead.name, true);
    var leadDisplayName = rawLead.name || metaOf(leadSpecies).cn;
    if (leadDisplayName === 'main-agent' || leadDisplayName === 'lead-agent' || leadDisplayName === '主智能体') {
      leadDisplayName = metaOf(leadSpecies).cn;
    }

    var leadObj = {
      id: rawLead.id || convId,
      name: leadDisplayName,
      role: rawLead.role || 'main-agent',
      isLead: true,
      queueIndex: 0,
      conversationId: convId,
      conversationTitle: convTitle,
      projectName: projName,
      species: leadSpecies,
      state: leadState,
      statusText: rawLead.statusText || '💤 领队待命中 · 单击看会话/双击弹起',
      idleMs: leadIdleMs,
      context: normalizeAgentContext(rawLead.context, rawLead)
    };

    var retirableStale = (
      !hasActiveSubagent &&
      keptSubs.length === 0 &&
      leadObj.state === 'sleeping' &&
      leadIdleMs > SUBAGENT_IDLE_TTL_MS &&
      !rawQ.isFocusedUi &&
      !rawQ.isLocalWindowQueue
    );

    return {
      conversationId: convId,
      conversationTitle: convTitle,
      projectName: projName,
      projectId: String(rawQ.projectId || projName.toLowerCase()),
      hasActiveSubagent: hasActiveSubagent,
      isFocusedUi: !!rawQ.isFocusedUi,
      isLocalWindowQueue: !!rawQ.isLocalWindowQueue,
      retirableStale: retirableStale,
      leadAgent: leadObj,
      subagents: keptSubs
    };
  }

  function buildLocalWindowQueue(scan, now) {
    if (!scan || (!scan.hasChatDom && scan.subagents.length === 0)) return null;
    var convId = scan.conversationId || ('local-' + WINDOW_ID);
    var projName = scan.projectName || '全局会话';
    var convTitle = scan.conversationTitle || '当前智能体会话';

    var enrichedSubs = [];
    for (var i = 0; i < scan.subagents.length; i++) {
      var s = scan.subagents[i];
      if (s.state === 'killed') continue;
      enrichedSubs.push(enrichSubagentWithBridge(s, convId, now));
    }

    var leadSpecies = themeSpecies();
    var effLeadState = scan.mainAgent ? scan.mainAgent.state : 'sleeping';
    var effLeadStatus = scan.mainAgent ? scan.mainAgent.statusText : '💤 领队待命中 · 单击看会话/双击弹起';

    return normalizeQueueRecord({
      conversationId: convId,
      conversationTitle: convTitle,
      projectName: projName,
      isFocusedUi: true,
      isLocalWindowQueue: true,
      leadAgent: {
        id: (scan.mainAgent && scan.mainAgent.id) || (convId + ':lead'),
        name: metaOf(leadSpecies).cn,
        role: 'main-agent',
        isLead: true,
        pokemonSpecies: leadSpecies,
        state: effLeadState,
        statusText: effLeadStatus
      },
      subagents: enrichedSubs
    }, now, projName);
  }

  function queuesMatchWindow(bq, localQ, scan) {
    if (!bq || !localQ) return false;
    if (scan.conversationId && bq.conversationId === scan.conversationId) return true;
    if (localQ.subagents.length > 0 && bq.subagents.length > 0) {
      for (var i = 0; i < localQ.subagents.length; i++) {
        var ls = localQ.subagents[i];
        for (var j = 0; j < bq.subagents.length; j++) {
          var bs = bq.subagents[j];
          if ((ls.id && bs.id && ls.id === bs.id) || (ls.name && bs.name && ls.name.toLowerCase() === bs.name.toLowerCase())) {
            return true;
          }
        }
      }
    }
    if (scan.conversationTitle && bq.conversationTitle === scan.conversationTitle && (!scan.projectName || bq.projectName === scan.projectName)) {
      return true;
    }
    return false;
  }

  function getEffectiveProjects(nowOverride) {
    var now = typeof nowOverride === 'number' ? nowOverride : Date.now();
    var scan = scanLiveDomAgents();
    var localQ = buildLocalWindowQueue(scan, now);

    var bridgeNormQueues = [];
    if (state.hasV3BridgeProjects && Array.isArray(state.bridgeProjects)) {
      for (var pIdx = 0; pIdx < state.bridgeProjects.length; pIdx++) {
        var proj = state.bridgeProjects[pIdx];
        if (!proj || !Array.isArray(proj.queues)) continue;
        for (var qIdx = 0; qIdx < proj.queues.length; qIdx++) {
          var nq = normalizeQueueRecord(proj.queues[qIdx], now, proj.projectName);
          if (nq) bridgeNormQueues.push(nq);
        }
      }
    }

    var combinedQueues = [];
    if (bridgeNormQueues.length > 0) {
      var localHasActiveWork = !!(localQ && (localQ.hasActiveSubagent || localQ.subagents.length > 0 || localQ.leadAgent.state !== 'sleeping'));
      var matchedIdx = -1;
      if (localQ) {
        for (var m = 0; m < bridgeNormQueues.length; m++) {
          if (queuesMatchWindow(bridgeNormQueues[m], localQ, scan)) {
            matchedIdx = m;
            break;
          }
        }
      }

      if (matchedIdx !== -1 && localQ) {
        var targetQ = bridgeNormQueues[matchedIdx];
        targetQ.isLocalWindowQueue = true;
        targetQ.isFocusedUi = true;
        targetQ.retirableStale = false;
        if (scan.projectName) targetQ.projectName = scan.projectName;
        if (scan.conversationTitle) targetQ.conversationTitle = scan.conversationTitle;
        targetQ.leadAgent.projectName = targetQ.projectName;
        targetQ.leadAgent.conversationTitle = targetQ.conversationTitle;
        if (localQ.leadAgent.state !== 'sleeping' && targetQ.leadAgent.state === 'sleeping') {
          targetQ.leadAgent.state = localQ.leadAgent.state;
          targetQ.leadAgent.statusText = localQ.leadAgent.statusText;
        }
        if (localQ.subagents.length > 0) {
          var existingByName = new Map();
          for (var es = 0; es < targetQ.subagents.length; es++) {
            existingByName.set(targetQ.subagents[es].name.toLowerCase(), targetQ.subagents[es]);
          }
          for (var lsIdx = 0; lsIdx < localQ.subagents.length; lsIdx++) {
            var lSub = localQ.subagents[lsIdx];
            var exSub = existingByName.get(lSub.name.toLowerCase());
            if (!exSub) {
              lSub.conversationId = targetQ.conversationId;
              lSub.conversationTitle = targetQ.conversationTitle;
              lSub.projectName = targetQ.projectName;
              lSub.queueIndex = targetQ.subagents.length + 1;
              targetQ.subagents.push(lSub);
            } else if ((lSub.state === 'working' || lSub.state === 'thinking') && exSub.state === 'sleeping') {
              exSub.state = lSub.state;
              exSub.idleMs = 0;
              if (lSub.statusText) exSub.statusText = lSub.statusText;
            }
          }
          targetQ.hasActiveSubagent = targetQ.subagents.some(function (s) { return s.state !== 'sleeping'; });
        }
        combinedQueues = bridgeNormQueues;
      } else if (localHasActiveWork && localQ) {
        combinedQueues = [localQ].concat(bridgeNormQueues);
      } else {
        combinedQueues = bridgeNormQueues;
      }
    } else if (localQ) {
      combinedQueues = [localQ];
    } else if (!scan.hasChatDom && state.agents && state.agents.length > 0) {
      var leadCand = null;
      var subCands = [];
      for (var k = 0; k < state.agents.length; k++) {
        var ba = state.agents[k];
        if (!ba || ba.state === 'killed') continue;
        if (!leadCand && (ba.isLead || k === 0)) {
          leadCand = ba;
        } else {
          subCands.push(ba);
        }
      }
      var v2Q = normalizeQueueRecord({
        conversationId: 'bridge-v2-session',
        projectName: scan.projectName || '全局会话',
        conversationTitle: scan.conversationTitle || '活跃智能体会话',
        isFocusedUi: true,
        leadAgent: leadCand,
        subagents: subCands
      }, now, scan.projectName || '全局会话');
      if (v2Q) combinedQueues = [v2Q];
    }

    var activeOrFocused = [];
    for (var cIdx = 0; cIdx < combinedQueues.length; cIdx++) {
      if (!combinedQueues[cIdx].retirableStale) {
        activeOrFocused.push(combinedQueues[cIdx]);
      }
    }
    var finalQueues = activeOrFocused;
    if (finalQueues.length === 0) {
      if (localQ) {
        localQ.retirableStale = false;
        finalQueues = [localQ];
      } else if (combinedQueues.length > 0) {
        combinedQueues[0].retirableStale = false;
        finalQueues = [combinedQueues[0]];
      } else {
        var fallbackSp = themeSpecies();
        finalQueues = [normalizeQueueRecord({
          conversationId: 'idle-' + WINDOW_ID,
          projectName: scan.projectName || '全局会话',
          conversationTitle: scan.conversationTitle || '当前智能体会话',
          isFocusedUi: true,
          isLocalWindowQueue: true,
          leadAgent: {
            id: 'idle-lead-' + WINDOW_ID,
            name: metaOf(fallbackSp).cn,
            role: 'main-agent',
            isLead: true,
            pokemonSpecies: fallbackSp,
            state: 'sleeping',
            statusText: '💤 领队待命中 · 单击看会话/双击弹起'
          },
          subagents: []
        }, now, scan.projectName || '全局会话')];
      }
    }

    var projectOrder = [];
    var projectMap = new Map();
    for (var fqIdx = 0; fqIdx < finalQueues.length; fqIdx++) {
      var q = finalQueues[fqIdx];
      var pKey = q.projectName || '全局会话';
      if (!projectMap.has(pKey)) {
        var grp = {
          projectId: q.projectId || pKey.toLowerCase(),
          projectName: pKey,
          queues: []
        };
        projectMap.set(pKey, grp);
        projectOrder.push(grp);
      }
      projectMap.get(pKey).queues.push(q);
    }

    return projectOrder;
  }

  function getEffectiveQueues(nowOverride) {
    var projects = getEffectiveProjects(nowOverride);
    var list = [];
    for (var i = 0; i < projects.length; i++) {
      for (var j = 0; j < projects[i].queues.length; j++) {
        list.push(projects[i].queues[j]);
      }
    }
    return list;
  }

  function getEffectiveCompanionList(nowOverride) {
    var queues = getEffectiveQueues(nowOverride);
    var flat = [];
    for (var i = 0; i < queues.length; i++) {
      var q = queues[i];
      if (q.leadAgent) flat.push(q.leadAgent);
      for (var j = 0; j < q.subagents.length; j++) {
        flat.push(q.subagents[j]);
      }
    }
    return flat;
  }

  // Push live multi-window telemetry & theme to Bridge v4.0 (`connectedWindows` 8s TTL)
  function pushUiSyncIfNeeded(force, themeChanged) {
    if (typeof window.fetch !== 'function') return;
    var scan = state.lastDomScan || scanLiveDomAgents();
    var isFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true;

    var subPayloads = [];
    for (var i = 0; i < scan.subagents.length; i++) {
      var s = scan.subagents[i];
      if (s.state === 'killed') continue;
      subPayloads.push({
        id: s.id || undefined,
        name: s.name,
        role: s.role || 'worker',
        isLead: false,
        state: s.state,
        statusText: s.statusText || ''
      });
    }

    var leadPayload = scan.mainAgent ? {
      id: scan.conversationId || scan.mainAgent.id,
      name: 'main-agent',
      role: 'main-agent',
      isLead: true,
      state: scan.mainAgent.state,
      statusText: scan.mainAgent.statusText || ''
    } : null;

    var winTitle = String(document.title || 'Antigravity');
    var hasWindowIdentity = !!(
      leadPayload ||
      subPayloads.length > 0 ||
      scan.conversationId ||
      scan.conversationTitle ||
      scan.projectName ||
      scan.workspacePath ||
      winTitle
    );

    if (!hasWindowIdentity) return;

    var detectedPid = state.hostPid || (typeof window.__POKEMON_HOST_PID__ === 'number' ? window.__POKEMON_HOST_PID__ : 0);
    var syncBody = {
      windowId: WINDOW_ID,
      appKind: detectAppKind(),
      pid: detectedPid > 0 ? detectedPid : undefined,
      windowTitle: winTitle,
      workspacePath: scan.workspacePath || undefined,
      projectName: scan.projectName || undefined,
      conversationId: scan.conversationId || undefined,
      conversationTitle: scan.conversationTitle || undefined,
      focused: isFocused,
      theme: toBridgeThemeId(state.theme),
      themeChanged: themeChanged ? true : undefined,
      leadAgent: leadPayload,
      subagents: subPayloads
    };

    var sig = JSON.stringify(syncBody);
    var now = Date.now();
    // Keep 3.2s heartbeat well inside Bridge's 8.0s `UI_SYNC_TTL_MS` even for unfocused background windows!
    if (!force && !themeChanged && sig === state.lastUiSyncSig && (now - state.lastUiSyncAt) < 3200) {
      return;
    }
    state.lastUiSyncSig = sig;
    state.lastUiSyncAt = now;

    window.fetch(BRIDGE_BASE + '/api/ui-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: sig
    })
      .then(function (res) { return res && res.ok ? res.json() : null; })
      .then(function (data) {
        if (data) ingestBridgePayload(data);
      })
      .catch(function () {});
  }

  // ==========================================================================
  // 3. v4.0 Double-Click `leadAgent` -> In-App Conversation & Project Switcher
  //    (`handleFocusSessionCommand(cmd)` + Glowing Toast, Zero HTML Sinks)
  // ==========================================================================

  var focusToastEl = null;
  var focusToastTitleEl = null;
  var focusToastMetaEl = null;

  function ensureFocusToastDom() {
    if (!document.body) return;
    if (focusToastEl && document.body.contains(focusToastEl)) return;

    focusToastEl = document.createElement('div');
    focusToastEl.id = 'pkmn-focus-session-toast';
    focusToastEl.hidden = true;

    var body = document.createElement('div');
    body.className = 'pkmn-focus-toast-body';

    focusToastTitleEl = document.createElement('div');
    focusToastTitleEl.className = 'pkmn-focus-toast-title';

    focusToastMetaEl = document.createElement('div');
    focusToastMetaEl.className = 'pkmn-focus-toast-meta';

    body.appendChild(focusToastTitleEl);
    body.appendChild(focusToastMetaEl);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pkmn-focus-toast-close';
    closeBtn.textContent = '×';
    closeBtn.title = '关闭提示';
    closeBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (focusToastEl) focusToastEl.hidden = true;
    });

    focusToastEl.appendChild(body);
    focusToastEl.appendChild(closeBtn);
    document.body.appendChild(focusToastEl);
  }

  function showFocusSessionToast(cmd, succeeded) {
    ensureFocusToastDom();
    if (!focusToastEl || !focusToastTitleEl || !focusToastMetaEl) return;

    var title = String((cmd && (cmd.conversationTitle || cmd.headerTitle || cmd.swarmTitle)) || '当前智能体会话').trim();
    var proj = String((cmd && cmd.projectName) || '').trim();

    if (succeeded === false) {
      focusToastTitleEl.textContent = '⚠️ 已唤起窗口（未在当前列表中定位到该对话）';
      focusToastMetaEl.textContent = (proj ? ('📁 ' + proj + ' · ') : '') + '💬 ' + title;
      focusToastEl.setAttribute('data-status', 'warn');
    } else {
      focusToastTitleEl.textContent = '⚡ 已自动跳转至会话：' + title;
      focusToastMetaEl.textContent = proj ? ('📁 所属项目：' + proj) : '✨ 已由桌宠浮窗唤醒';
      focusToastEl.removeAttribute('data-status');
    }
    focusToastEl.hidden = false;

    if (state.focusToastTimer) {
      clearTimeout(state.focusToastTimer);
    }
    state.focusToastTimer = setTimeout(function () {
      state.focusToastTimer = null;
      if (focusToastEl) focusToastEl.hidden = true;
    }, FOCUS_TOAST_HIDE_MS);
  }

  function findConversationRowElement(cmd, selector) {
    if (!cmd || !document || typeof document.querySelectorAll !== 'function') return null;
    var rows = document.querySelectorAll(selector || 'div[data-testid^="conversation-row-"]');
    if (!rows || rows.length === 0) return null;

    var targetConvId = String(cmd.conversationId || '').trim();
    if (targetConvId) {
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (isHiddenOrExiting(r)) continue;
        if ((r.getAttribute('data-cascade-id') || '').trim() === targetConvId) {
          return r;
        }
      }
    }

    // With an exact conversation id, a title match could land on a different conversation that shares
    // a similar name, so only fall back to titles when no id is known.
    if (targetConvId) return null;

    var titleCandidates = [];
    if (cmd.headerTitle) titleCandidates.push(String(cmd.headerTitle).trim().toLowerCase());
    if (cmd.conversationTitle) titleCandidates.push(String(cmd.conversationTitle).trim().toLowerCase());
    if (cmd.swarmTitle) titleCandidates.push(String(cmd.swarmTitle).trim().toLowerCase());

    if (titleCandidates.length > 0) {
      for (var j = 0; j < rows.length; j++) {
        var row = rows[j];
        if (isHiddenOrExiting(row)) continue;
        var link = row.querySelector('a[aria-label]');
        var ariaTxt = link ? String(link.getAttribute('aria-label') || '').trim().toLowerCase() : '';
        var rowTxt = String(row.textContent || '').trim().toLowerCase();
        for (var c = 0; c < titleCandidates.length; c++) {
          var cand = titleCandidates[c];
          if (!cand) continue;
          if (ariaTxt === cand || (ariaTxt && ariaTxt.indexOf(cand) !== -1) || rowTxt === cand) {
            return row;
          }
        }
      }
    }

    return null;
  }

  // CRITICAL: React attaches `onActivate` to inner `<a href>` (`ButtonLink`), NOT outer `div`!
  function activateConversationRow(row) {
    if (!row) return 'missing';
    var inSubagentTab = false;
    var subTabEl = document.querySelector('[data-testid="subagent-tab-header-title"]');
    if (subTabEl && !isHiddenOrExiting(subTabEl)) {
      inSubagentTab = true;
    }
    if (row.getAttribute('data-selected') === 'true' && !inSubagentTab) {
      return 'already-selected';
    }
    var clickTarget = row.querySelector('a[href]') || row.querySelector('a') || row;
    if (clickTarget && typeof clickTarget.click === 'function') {
      clickTarget.click();
      return 'clicked';
    }
    return 'no-click-target';
  }

  function setReactInputValue(inputEl, text) {
    if (!inputEl) return;
    try {
      var proto = window.HTMLInputElement && window.HTMLInputElement.prototype;
      var desc = proto ? Object.getOwnPropertyDescriptor(proto, 'value') : null;
      if (desc && typeof desc.set === 'function') {
        desc.set.call(inputEl, text);
      } else {
        inputEl.value = text;
      }
      if (typeof window.Event === 'function') {
        inputEl.dispatchEvent(new window.Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new window.Event('change', { bubbles: true }));
      }
    } catch (_e) {
      inputEl.value = text;
    }
  }

  function doesFocusCommandMatchThisWindow(cmd, scan) {
    if (!cmd || typeof cmd !== 'object') return false;

    var appKind = detectAppKind();
    var isHubApp = appKind === 'hub';

    // 0. The bridge names the program that owns the jump: "app" (Antigravity.exe Hub) or "ide".
    if (cmd.host) {
      var myHost = isHubApp ? 'app' : 'ide';
      if (cmd.host !== myHost) return false;
    }

    // 1. Explicit window match from Bridge `ui-sync` registry
    if (cmd.windowId) {
      if (cmd.windowId === WINDOW_ID) return true;
      if (cmd.matchedUiWindow === true && cmd.windowId !== WINDOW_ID) {
        return false;
      }
    }

    // 1b. Antigravity 2.0 Hub window hosts all projects and conversations across routes (Settings/Plugins/etc.)
    if (isHubApp && cmd.host !== 'ide' && !cmd.windowId) {
      return true;
    }

    // 2. Direct conversationId match (currently open or present in sidebar)
    if (cmd.conversationId) {
      if (scan.conversationId && scan.conversationId === cmd.conversationId) return true;
      if (findConversationRowElement(cmd, 'div[data-testid^="conversation-row-"]')) return true;
    }

    // 3. Workspace / Project match
    if (cmd.workspacePath && scan.workspacePath) {
      var normA = String(cmd.workspacePath).replace(/\\/g, '/').toLowerCase();
      var normB = String(scan.workspacePath).replace(/\\/g, '/').toLowerCase();
      if (normA === normB || normB.indexOf(normA) !== -1 || normA.indexOf(normB) !== -1) {
        return true;
      }
    }
    if (cmd.projectName && cmd.projectName !== '全局会话' && scan.projectName) {
      if (String(scan.projectName).toLowerCase() === String(cmd.projectName).toLowerCase()) {
        return true;
      }
    }

    // 4. Window title match
    var docTitle = String(document.title || '').trim();
    if (docTitle && cmd.windowTitle && docTitle === cmd.windowTitle) {
      return true;
    }
    if (docTitle && Array.isArray(cmd.candidateWindowTitles)) {
      var lowerDoc = docTitle.toLowerCase();
      for (var i = 0; i < cmd.candidateWindowTitles.length; i++) {
        var cwt = String(cmd.candidateWindowTitles[i] || '').trim().toLowerCase();
        if (cwt && lowerDoc.indexOf(cwt) !== -1) return true;
      }
    }

    // 5a. Agent-manager windows route conversations by id, so they can open any conversation directly
    if (cmd.conversationId && !cmd.matchedUiWindow && getConversationRouter()) {
      return true;
    }

    // 5b. App A Hub fallback when no strict window mismatch
    if (isHubApp && cmd.host !== 'ide' && !cmd.matchedUiWindow) {
      return true;
    }

    // 5. App A Hub / Jetski global window with sidebar toggle or history button when no project specified
    if ((!cmd.projectName || cmd.projectName === '全局会话') && !cmd.matchedUiWindow) {
      if (document.querySelector('button[data-testid="sidebar-toggle"], [data-testid="history-button"]')) {
        return true;
      }
    }

    return false;
  }

  // Antigravity's agent manager is a TanStack Router app that exposes its router as `self.__TSR_ROUTER__`,
  // with conversations routed at `/c/$cascadeId`. Navigating there opens the exact conversation even when
  // its sidebar row is collapsed inside a project group or virtualised out of view.
  // The IDE workbench (`workbench.desktop.main.js`) bundles an older TanStack build that does NOT publish
  // `__TSR_ROUTER__`, so we fall back to reading the router from the React fiber tree (upward walk from
  // mounted agent-panel nodes + bounded downward BFS from React root). Read-only: nothing is modified.
  var cachedFiberRouter = null;
  var lastRouterSource = '';

  function isTanStackRouter(cand) {
    return !!(cand && typeof cand === 'object' && typeof cand.navigate === 'function' &&
      ((cand.state && cand.state.location) || ((typeof cand.buildLocation === 'function' || cand.routesById) && cand.history)));
  }

  function extractRouterFromFiberNode(f) {
    if (!f || typeof f !== 'object') return null;
    var p = f.memoizedProps;
    if (p && typeof p === 'object') {
      if (isTanStackRouter(p.value)) return p.value;
      if (isTanStackRouter(p.router)) return p.router;
      if (isTanStackRouter(p.ctx)) return p.ctx;
    }
    var ms = f.memoizedState;
    for (var mSteps = 0; ms && typeof ms === 'object' && mSteps < 24; mSteps++) {
      var val = ms.memoizedState;
      if (val && typeof val === 'object') {
        if (isTanStackRouter(val)) return val;
        if (isTanStackRouter(val.current)) return val.current;
        if (isTanStackRouter(val.router)) return val.router;
        if (isTanStackRouter(val.value)) return val.value;
        if (val.memoizedState && isTanStackRouter(val.memoizedState)) return val.memoizedState;
      }
      ms = ms.next;
    }
    var deps = f.dependencies;
    var ctx = deps && deps.firstContext;
    for (var cSteps = 0; ctx && typeof ctx === 'object' && cSteps < 24; cSteps++) {
      if (isTanStackRouter(ctx.memoizedValue)) return ctx.memoizedValue;
      if (ctx.context && isTanStackRouter(ctx.context._currentValue)) return ctx.context._currentValue;
      ctx = ctx.next;
    }
    return null;
  }

  function findRouterInFiber(el) {
    if (!el) return null;
    var fiberKey = null;
    try {
      var keys = Object.keys(el);
      for (var k = 0; k < keys.length; k++) {
        if (keys[k].indexOf('__reactFiber$') === 0) { fiberKey = keys[k]; break; }
      }
    } catch (_e) { return null; }
    if (!fiberKey) return null;
    var f = el[fiberKey];
    for (var depth = 0; f && depth < 3000; depth++, f = f.return) {
      var r = extractRouterFromFiberNode(f);
      if (r) return r;
    }
    return null;
  }

  function getRootFiberFromElement(el) {
    if (!el || typeof el !== 'object') return null;
    try {
      if (el._reactRootContainer) {
        var irc = el._reactRootContainer._internalRoot || el._reactRootContainer;
        if (irc && irc.current) return irc.current;
      }
      var keys = Object.keys(el);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (k.indexOf('__reactContainer$') === 0 || k.indexOf('__reactFiber$') === 0) {
          var v = el[k];
          if (v && typeof v === 'object') {
            return (v.current && typeof v.current === 'object') ? v.current : v;
          }
        }
      }
    } catch (_e) {}
    return null;
  }

  function findRouterDownwardFromRoots() {
    var rootEls = [];
    try {
      if (document.getElementById('root')) rootEls.push(document.getElementById('root'));
      if (document.getElementById('app')) rootEls.push(document.getElementById('app'));
      if (document.body && document.body.firstElementChild) rootEls.push(document.body.firstElementChild);
      if (document.body) rootEls.push(document.body);
    } catch (_e) {}

    var seenEls = typeof Set === 'function' ? new Set() : null;
    for (var i = 0; i < rootEls.length; i++) {
      var el = rootEls[i];
      if (!el || (seenEls && seenEls.has(el))) continue;
      if (seenEls) seenEls.add(el);
      var startFiber = getRootFiberFromElement(el);
      if (!startFiber) continue;

      var queue = [startFiber];
      var visited = typeof Set === 'function' ? new Set([startFiber]) : null;
      var steps = 0;
      while (queue.length > 0 && steps < 600) {
        var node = queue.shift();
        steps++;
        var found = extractRouterFromFiberNode(node);
        if (found) return found;
        if (node.child && (!visited || !visited.has(node.child))) {
          if (visited) visited.add(node.child);
          queue.push(node.child);
        }
        if (node.sibling && (!visited || !visited.has(node.sibling))) {
          if (visited) visited.add(node.sibling);
          queue.push(node.sibling);
        }
      }
    }
    return null;
  }

  function getConversationRouter() {
    try {
      var router = window.__TSR_ROUTER__;
      if (router && typeof router.navigate === 'function') { lastRouterSource = 'tsr-global'; return router; }
    } catch (_e) {}
    if (cachedFiberRouter && typeof cachedFiberRouter.navigate === 'function' && (cachedFiberRouter.history || (cachedFiberRouter.state && cachedFiberRouter.state.location))) {
      lastRouterSource = 'react-fiber-cached';
      return cachedFiberRouter;
    }
    try {
      var probes = document.querySelectorAll(
        '[data-testid^="conversation-row-"], [data-testid="history-button"], [data-testid="sidebar-toggle"], [data-testid="subagent-node"], [data-cascade-id], a[href^="/c/"]'
      );
      for (var i = 0; i < probes.length && i < 40; i++) {
        var r = findRouterInFiber(probes[i]);
        if (r) { cachedFiberRouter = r; lastRouterSource = 'react-fiber'; return r; }
      }
    } catch (_e2) {}
    try {
      var bfsRouter = findRouterDownwardFromRoots();
      if (bfsRouter) { cachedFiberRouter = bfsRouter; lastRouterSource = 'react-fiber-bfs'; return bfsRouter; }
    } catch (_e3) {}
    lastRouterSource = 'none';
    return null;
  }

  function currentRouterConversationId(router) {
    try {
      var pathName = String((router.state && router.state.location && router.state.location.pathname) || '');
      var m = pathName.match(/^\/c\/([^/?#]+)/);
      return m ? decodeURIComponent(m[1]) : '';
    } catch (_e) {
      return '';
    }
  }

  function navigateToConversationViaRouter(convId) {
    var router = getConversationRouter();
    if (!router || !convId) return 'no-router';
    if (currentRouterConversationId(router) === convId) return 'already-selected';
    var encodedPath = '/c/' + encodeURIComponent(convId);
    var attempted = false;
    try {
      var p1 = router.navigate({ to: '/c/$cascadeId', params: { cascadeId: convId } });
      if (p1 && typeof p1.catch === 'function') p1.catch(function () {});
      attempted = true;
    } catch (_e1) {}
    if (currentRouterConversationId(router) !== convId) {
      try {
        var p2 = router.navigate({ to: encodedPath });
        if (p2 && typeof p2.catch === 'function') p2.catch(function () {});
        attempted = true;
      } catch (_e2) {}
    }
    if (!attempted && router.history && typeof router.history.push === 'function') {
      try {
        router.history.push(encodedPath);
        attempted = true;
      } catch (_e3) {}
    }
    return attempted ? 'navigated' : 'router-error';
  }

  function detectAppKindForAck() {
    var p = String((window.location && window.location.pathname) || '');
    if (p.indexOf('workbench-jetski-agent') !== -1) return 'jetski-agent';
    if (p.indexOf('workbench') !== -1) return 'workbench';
    return 'hub';
  }

  function currentLocationForAck() {
    try {
      var r = cachedFiberRouter || window.__TSR_ROUTER__;
      if (r && r.state && r.state.location) return String(r.state.location.pathname || '');
    } catch (_e) {}
    return '';
  }

  // Report each focus-session execution result back to the bridge (`GET /api/focus-ack` to inspect)
  function reportFocusResult(cmd, result, phase) {
    try {
      if (!cmd || !result || result.duplicate || typeof window.fetch !== 'function') return;
      window.fetch(BRIDGE_BASE + '/api/focus-ack', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requestId: cmd.requestId || null,
          conversationId: cmd.conversationId || null,
          windowId: WINDOW_ID,
          appKind: detectAppKindForAck(),
          docTitle: String(document.title || '').slice(0, 200),
          phase: phase || 'sync',
          handled: !!result.handled,
          stage: result.stage || null,
          action: result.action || null,
          reason: result.reason || null,
          routerSource: lastRouterSource || null,
          location: currentLocationForAck()
        })
      }).catch(function () {});
    } catch (_e) {}
  }

  function expandCollapsedProjectFolder(projectName) {
    var proj = String(projectName || '').trim().toLowerCase();
    if (!proj || proj === '全局会话' || !document || typeof document.querySelectorAll !== 'function') {
      return false;
    }
    var candidates = document.querySelectorAll('[aria-expanded="false"], [data-state="closed"]');
    var exactTarget = null;
    var partialTarget = null;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      if (!el || isHiddenOrExiting(el)) continue;
      if (el.getAttribute('data-testid') === 'sidebar-toggle') continue;
      var txt = String(el.textContent || '').trim().toLowerCase();
      if (!txt || txt.length > 160) continue;
      if (txt === proj) {
        exactTarget = el;
        break;
      }
      if (!partialTarget && txt.indexOf(proj) !== -1) {
        partialTarget = el;
      }
    }
    var target = exactTarget || partialTarget;
    if (!target) return false;
    var clickEl = (target.matches && target.matches('button, [role="button"]'))
      ? target
      : (target.querySelector('button, [role="button"]') || target);
    if (clickEl && typeof clickEl.click === 'function') {
      clickEl.click();
      return true;
    }
    return false;
  }

  function handleFocusSessionCommand(cmd, options) {
    var res = handleFocusSessionCommandCore(cmd, options);
    reportFocusResult(cmd, res, 'sync');
    return res;
  }

  function handleFocusSessionCommandCore(cmd, options) {
    if (!cmd || typeof cmd !== 'object') {
      return { handled: false, reason: 'invalid-command' };
    }
    var forceHandle = !!(options && options.force);
    var isInternalRetry = !!(options && (options.skipRouter || options.skipFolderExpand));
    var reqKey = String(cmd.requestId || (String(cmd.conversationId || '') + ':' + String(cmd.requestedAt || '')));
    if (!isInternalRetry && reqKey && reqKey !== ':') {
      if (state.handledFocusRequestIds.has(reqKey)) {
        return { handled: false, duplicate: true, requestId: reqKey };
      }
    }

    var scan = scanLiveDomAgents();
    if (!forceHandle && !doesFocusCommandMatchThisWindow(cmd, scan)) {
      return { handled: false, reason: 'window-mismatch' };
    }

    if (reqKey && reqKey !== ':') {
      if (state.handledFocusRequestIds.size > 64) {
        state.handledFocusRequestIds.clear();
      }
      state.handledFocusRequestIds.add(reqKey);
    }

    try {
      if (typeof window.focus === 'function') window.focus();
    } catch (_e) {}

    // Stage 1: Direct hit in mounted Sidebar or open History list
    var directRow = findConversationRowElement(cmd, 'div[data-testid^="conversation-row-"]');
    if (directRow) {
      var action1 = activateConversationRow(directRow);
      var ok1 = action1 === 'clicked' || action1 === 'already-selected';
      showFocusSessionToast(cmd, ok1);
      setTimeout(function () {
        scanLiveDomAgents();
        pushUiSyncIfNeeded(true, false);
      }, 200);
      return { handled: ok1, stage: 'direct', action: action1 };
    }

    // Stage 1b: exact navigation through the app router (works for collapsed / virtualised rows)
    if (cmd.conversationId && !(options && options.skipRouter)) {
      var targetId = String(cmd.conversationId);
      var routed = navigateToConversationViaRouter(targetId);
      if (routed === 'already-selected') {
        showFocusSessionToast(cmd, true);
        setTimeout(function () {
          scanLiveDomAgents();
          pushUiSyncIfNeeded(true, false);
        }, 200);
        return { handled: true, stage: 'router', action: 'already-selected' };
      }
      if (routed === 'navigated') {
        var finalizeRouterVerify = function (rVerify) {
          var nowId = rVerify ? currentRouterConversationId(rVerify) : '';
          if (nowId === targetId) {
            showFocusSessionToast(cmd, true);
            reportFocusResult(cmd, { handled: true, stage: 'router', action: 'router-verified' }, 'verify');
            setTimeout(function () {
              scanLiveDomAgents();
              pushUiSyncIfNeeded(true, false);
            }, 120);
          } else {
            var fb = handleFocusSessionCommandCore(cmd, { force: true, skipRouter: true });
            fb.reason = 'router-no-effect(now=' + (nowId || '-') + ')';
            reportFocusResult(cmd, fb, 'router-fallback');
          }
        };
        setTimeout(function () {
          var r2 = getConversationRouter();
          var nowId = r2 ? currentRouterConversationId(r2) : '';
          if (nowId === targetId) {
            finalizeRouterVerify(r2);
            return;
          }
          if (r2 && r2.history && typeof r2.history.push === 'function') {
            try { r2.history.push('/c/' + encodeURIComponent(targetId)); } catch (_ehp) {}
            setTimeout(function () {
              finalizeRouterVerify(getConversationRouter());
            }, 240);
            return;
          }
          finalizeRouterVerify(r2);
        }, 220);
        return { handled: true, stage: 'router', action: 'navigated' };
      }
    }

    // Already active in current main view (when sidebar is collapsed)
    if (cmd.conversationId && scan.conversationId === cmd.conversationId && !scan.viewingSubagentTab) {
      showFocusSessionToast(cmd, true);
      return { handled: true, stage: 'already-active', action: 'already-selected' };
    }

    // Stage 2a: Collapsed project folder inside already-expanded sidebar
    if (!(options && options.skipFolderExpand) && cmd.projectName && cmd.projectName !== '全局会话') {
      if (expandCollapsedProjectFolder(cmd.projectName)) {
        setTimeout(function () {
          var rowAfterFolder = findConversationRowElement(cmd, 'div[data-testid^="conversation-row-"]');
          if (rowAfterFolder) {
            var folderAct = activateConversationRow(rowAfterFolder);
            var folderOk = folderAct === 'clicked' || folderAct === 'already-selected';
            reportFocusResult(cmd, { handled: folderOk, stage: 'project-folder-expand', action: folderAct }, 'async');
            showFocusSessionToast(cmd, folderOk);
            setTimeout(function () {
              scanLiveDomAgents();
              pushUiSyncIfNeeded(true, false);
            }, 220);
          } else {
            var fb2 = handleFocusSessionCommandCore(cmd, { force: true, skipRouter: true, skipFolderExpand: true });
            reportFocusResult(cmd, fb2, 'project-folder-fallback');
          }
        }, 180);
        return { handled: true, stage: 'project-folder-expand', action: 'expanding-project' };
      }
    }

    // Stage 2b: Collapsed Left Sidebar in App A Hub & App B `workbench-jetski-agent.html`
    var sbToggle = document.querySelector('button[data-testid="sidebar-toggle"]');
    if (sbToggle && sbToggle.getAttribute('aria-expanded') === 'false') {
      sbToggle.click();
      setTimeout(function () {
        var rowAfterExpand = findConversationRowElement(cmd, 'div[data-testid^="conversation-row-"]');
        if (rowAfterExpand) {
          var expandAct = activateConversationRow(rowAfterExpand);
          var expandOk = expandAct === 'clicked' || expandAct === 'already-selected';
          reportFocusResult(cmd, { handled: expandOk, stage: 'sidebar-expand', action: expandAct }, 'async');
          showFocusSessionToast(cmd, expandOk);
          setTimeout(function () {
            scanLiveDomAgents();
            pushUiSyncIfNeeded(true, false);
          }, 220);
          return;
        }
        if (cmd.projectName && cmd.projectName !== '全局会话' && expandCollapsedProjectFolder(cmd.projectName)) {
          setTimeout(function () {
            var rowAfterProj = findConversationRowElement(cmd, 'div[data-testid^="conversation-row-"]');
            var projAct = rowAfterProj ? activateConversationRow(rowAfterProj) : 'row-not-found';
            var projOk = !!rowAfterProj && (projAct === 'clicked' || projAct === 'already-selected');
            reportFocusResult(cmd, { handled: projOk, stage: 'sidebar-project-expand', action: projAct }, 'async');
            showFocusSessionToast(cmd, projOk);
            setTimeout(function () {
              scanLiveDomAgents();
              pushUiSyncIfNeeded(true, false);
            }, 220);
          }, 180);
          return;
        }
        reportFocusResult(cmd, { handled: false, stage: 'sidebar-expand', action: 'row-not-found' }, 'async');
        showFocusSessionToast(cmd, false);
      }, 170);
      return { handled: true, stage: 'sidebar-expand', action: 'expanding' };
    }

    // Stage 3: Classic VS Code `workbench.html` History Popover (`[data-testid="history-button"]`)
    var histBtn = document.querySelector('[data-testid="history-button"]');
    if (histBtn) {
      var histAlreadyOpen = !!document.querySelector('[data-testid="history-search-input"], div[data-testid="conversation-row-history"]');
      if (!histAlreadyOpen) {
        histBtn.click();
      }
      setTimeout(function () {
        var histRow = findConversationRowElement(cmd, 'div[data-testid="conversation-row-history"], div[data-testid^="conversation-row-"]');
        if (histRow) {
          var histAct = activateConversationRow(histRow);
          var histOk = histAct === 'clicked' || histAct === 'already-selected';
          reportFocusResult(cmd, { handled: histOk, stage: 'history-popover', action: histAct }, 'async');
          showFocusSessionToast(cmd, histOk);
          setTimeout(function () {
            scanLiveDomAgents();
            pushUiSyncIfNeeded(true, false);
          }, 220);
          return;
        }
        var searchQuery = String(cmd.headerTitle || cmd.conversationTitle || '').trim();
        var searchInput = document.querySelector('[data-testid="history-search-input"]');
        if (searchInput && searchQuery) {
          setReactInputValue(searchInput, searchQuery);
          setTimeout(function () {
            var filteredRow = findConversationRowElement(cmd, 'div[data-testid="conversation-row-history"], div[data-testid^="conversation-row-"]');
            var filtAct = filteredRow ? activateConversationRow(filteredRow) : 'row-not-found-after-search';
            var filtOk = !!filteredRow && (filtAct === 'clicked' || filtAct === 'already-selected');
            reportFocusResult(cmd, { handled: filtOk, stage: 'history-search', action: filtAct }, 'async');
            showFocusSessionToast(cmd, filtOk);
            setTimeout(function () {
              scanLiveDomAgents();
              pushUiSyncIfNeeded(true, false);
            }, 220);
          }, 140);
        } else {
          reportFocusResult(cmd, { handled: false, stage: 'history-popover', action: 'row-not-found', reason: searchInput ? 'no-search-query' : 'no-history-search-input' }, 'async');
          showFocusSessionToast(cmd, false);
        }
      }, histAlreadyOpen ? 40 : 190);
      return { handled: true, stage: 'history-popover', action: 'opening-history' };
    }

    showFocusSessionToast(cmd, false);
    return { handled: false, stage: 'window-focus-only', action: 'row-not-found', reason: 'no-row/no-router(' + (lastRouterSource || '-') + ')/no-history-button' };
  }

  // ==========================================================================
  // 4. Subagents Right-Sidebar -> Pokemon Party Squad Decorator (100% React-Safe)
  // ==========================================================================

  function formatBadgeLabel(st, species) {
    var meta = metaOf(species);
    if (st === 'working') return '⚡ ' + meta.cn + '·出战';
    if (st === 'thinking') return '💭 ' + meta.cn + '·思考';
    if (st === 'killed') return '✖ ' + meta.cn + '·退场';
    return '💤 ' + meta.cn + '·待命';
  }

  function findSubagentListContainer(firstNode) {
    if (!firstNode || !firstNode.parentElement) return null;
    var p1 = firstNode.parentElement;
    var directNodes = 0;
    for (var i = 0; i < p1.children.length; i++) {
      if (p1.children[i].getAttribute && p1.children[i].getAttribute('data-testid') === 'subagent-node') {
        directNodes++;
      }
    }
    if (directNodes > 1) return p1;
    var p2 = p1.parentElement;
    if (p2 && p2.children.length >= 1) {
      var wrappedCount = p2.querySelectorAll('div[data-testid="subagent-node"]').length;
      if (wrappedCount >= 1) return p2;
    }
    return p1;
  }

  function ensureSubagentHeaderToggle(listContainer) {
    if (!listContainer || !listContainer.parentElement) return;
    var sectionRoot = listContainer.parentElement;
    var prevHeader = listContainer.previousElementSibling || sectionRoot.firstElementChild;
    if (!prevHeader || prevHeader === listContainer) return;

    var existing = prevHeader.querySelector('.pkmn-party-layout-btn');
    var labelText = state.partyTwoCol ? '🎴 并排2列' : '📋 单列编队';
    if (existing) {
      if (existing.textContent !== labelText) {
        existing.textContent = labelText;
      }
      return;
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pkmn-party-layout-btn';
    btn.textContent = labelText;
    btn.title = '切换队伍栏布局：双列并排 / 单列列表';
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ev.preventDefault();
      togglePartyColumns();
    });
    prevHeader.appendChild(btn);
  }

  var PARTY_RING_R_RED = 21.5;
  var PARTY_RING_C_RED = 2 * Math.PI * PARTY_RING_R_RED;
  var PARTY_RING_R_GREEN = 18;
  var PARTY_RING_C_GREEN = 2 * Math.PI * PARTY_RING_R_GREEN;

  function createSvgCircle(clsName, radius) {
    var c = document.createElementNS(SVG_NS, 'circle');
    c.setAttribute('class', clsName);
    c.setAttribute('cx', '24');
    c.setAttribute('cy', '24');
    c.setAttribute('r', String(radius));
    return c;
  }

  function decorateSingleSubagentNode(node, index) {
    var cascadeId = node.getAttribute('data-cascade-id') || '';
    var spans = getReactSpans(node);
    var titleText = spans.length > 0 ? (spans[0].textContent || '') : '';
    var subText = spans.length > 1 ? (spans[spans.length - 1].textContent || '') : '';
    var workerName = extractWorkerNameFromText(titleText);

    var bridgeAgent = (cascadeId && state.agentsById.get(cascadeId)) ||
                      (workerName && state.agentsByName.get(workerName.toLowerCase())) ||
                      null;

    var hasSpinner = !!node.querySelector('[data-testid="status-loading-spinner"], [data-testid="subagent-stop"]');
    var isKilled = !!node.querySelector('[data-testid="agent-status-killed"]');
    var species = resolveSpecies(bridgeAgent, workerName || ('slot-' + index), false);
    var meta = metaOf(species);
    var cardState = classifyNodeState(subText, hasSpinner, isKilled, bridgeAgent);
    var ctx = normalizeAgentContext(bridgeAgent && bridgeAgent.context, bridgeAgent);

    node.style.setProperty('--pkmn-species-color', meta.color);
    node.style.setProperty('--pkmn-species-rgb', meta.rgb);
    if (node.getAttribute('data-pkmn-state') !== cardState) {
      node.setAttribute('data-pkmn-state', cardState);
    }
    if (node.getAttribute('data-pkmn-species') !== species) {
      node.setAttribute('data-pkmn-species', species);
    }

    var deco = node.querySelector('div[data-pkmn-party-deco="1"]');
    var imgEl, badgeEl, redRingEl, greenRingEl, ctxRedSpan, ctxGreenSpan;
    if (!deco) {
      deco = document.createElement('div');
      deco.setAttribute('data-pkmn-party-deco', '1');

      var slot = document.createElement('div');
      slot.className = 'pkmn-party-sprite-slot';

      var svgEl = document.createElementNS(SVG_NS, 'svg');
      svgEl.setAttribute('viewBox', '0 0 48 48');
      svgEl.setAttribute('class', 'pkmn-party-ctx-svg');
      svgEl.setAttribute('aria-hidden', 'true');

      var redTrackEl = createSvgCircle('pkmn-party-ring-track-red', PARTY_RING_R_RED);
      redRingEl = createSvgCircle('pkmn-party-ring-red', PARTY_RING_R_RED);
      redRingEl.setAttribute('stroke-dasharray', PARTY_RING_C_RED.toFixed(2));
      redRingEl.setAttribute('stroke-dashoffset', PARTY_RING_C_RED.toFixed(2));

      var greenTrackEl = createSvgCircle('pkmn-party-ring-track-green', PARTY_RING_R_GREEN);
      greenRingEl = createSvgCircle('pkmn-party-ring-green', PARTY_RING_R_GREEN);
      greenRingEl.setAttribute('stroke-dasharray', PARTY_RING_C_GREEN.toFixed(2));
      greenRingEl.setAttribute('stroke-dashoffset', PARTY_RING_C_GREEN.toFixed(2));

      svgEl.appendChild(redTrackEl);
      svgEl.appendChild(redRingEl);
      svgEl.appendChild(greenTrackEl);
      svgEl.appendChild(greenRingEl);
      slot.appendChild(svgEl);

      imgEl = document.createElement('img');
      imgEl.className = 'pkmn-party-sprite-img';
      imgEl.alt = meta.cn;
      slot.appendChild(imgEl);

      badgeEl = document.createElement('div');
      badgeEl.className = 'pkmn-party-badge';

      var ctxLabelEl = document.createElement('div');
      ctxLabelEl.className = 'pkmn-party-ctx-label';
      ctxRedSpan = document.createElement('span');
      ctxRedSpan.className = 'pkmn-party-ctx-red';
      ctxGreenSpan = document.createElement('span');
      ctxGreenSpan.className = 'pkmn-party-ctx-green';
      ctxLabelEl.appendChild(ctxRedSpan);
      ctxLabelEl.appendChild(ctxGreenSpan);

      var hpTrack = document.createElement('div');
      hpTrack.className = 'pkmn-party-hp-track';
      var hpFill = document.createElement('div');
      hpFill.className = 'pkmn-party-hp-fill';
      hpTrack.appendChild(hpFill);

      deco.appendChild(slot);
      deco.appendChild(badgeEl);
      deco.appendChild(ctxLabelEl);
      deco.appendChild(hpTrack);
      node.appendChild(deco);
    } else {
      imgEl = deco.querySelector('.pkmn-party-sprite-img');
      badgeEl = deco.querySelector('.pkmn-party-badge');
      redRingEl = deco.querySelector('.pkmn-party-ring-red');
      greenRingEl = deco.querySelector('.pkmn-party-ring-green');
      ctxRedSpan = deco.querySelector('.pkmn-party-ctx-red');
      ctxGreenSpan = deco.querySelector('.pkmn-party-ctx-green');
    }

    var isShiny = !!(bridgeAgent && bridgeAgent.shiny);
    var targetSrc = getSpriteUrl(species, isShiny);
    if (imgEl && imgEl.getAttribute('data-src-key') !== targetSrc) {
      imgEl.src = targetSrc;
      imgEl.setAttribute('data-src-key', targetSrc);
    }
    var wantFilter = getSpriteFilter(species, isShiny);
    if (imgEl && imgEl.style.filter !== wantFilter) imgEl.style.filter = wantFilter;
    var desiredBadge = formatBadgeLabel(cardState, species);
    if (badgeEl && badgeEl.textContent !== desiredBadge) {
      badgeEl.textContent = desiredBadge;
    }

    var effRedPct = (ctx.usedPct > 0 || ctx.usedTokens > 0) ? Math.max(2.5, Math.min(100, ctx.usedPct)) : 0;
    var effGreenPct = ctx.cacheKnown && (ctx.cacheHitPct > 0 || ctx.cachedTokens > 0) ? Math.max(2.5, Math.min(100, ctx.cacheHitPct)) : 0;
    var redOffset = (PARTY_RING_C_RED * (1 - effRedPct / 100)).toFixed(2);
    var greenOffset = (PARTY_RING_C_GREEN * (1 - effGreenPct / 100)).toFixed(2);

    if (redRingEl && redRingEl.getAttribute('stroke-dashoffset') !== redOffset) {
      redRingEl.setAttribute('stroke-dashoffset', redOffset);
    }
    if (greenRingEl && greenRingEl.getAttribute('stroke-dashoffset') !== greenOffset) {
      greenRingEl.setAttribute('stroke-dashoffset', greenOffset);
    }

    var usedPctInt = Math.round(ctx.usedPct);
    var cachePctInt = Math.round(ctx.cacheHitPct);
    var nextRedTxt = '🔴 ' + formatTokenShort(ctx.usedTokens) + ' (' + usedPctInt + '%)';
    var nextGreenTxt = '· 🟢 ' + (ctx.cacheKnown ? cachePctInt + '%' : '—');
    if (ctxRedSpan && ctxRedSpan.textContent !== nextRedTxt) {
      ctxRedSpan.textContent = nextRedTxt;
    }
    if (ctxGreenSpan && ctxGreenSpan.textContent !== nextGreenTxt) {
      ctxGreenSpan.textContent = nextGreenTxt;
    }

    var nextUsedAttr = String(usedPctInt);
    var nextCacheAttr = String(cachePctInt);
    if (node.getAttribute('data-ctx-used-pct') !== nextUsedAttr) {
      node.setAttribute('data-ctx-used-pct', nextUsedAttr);
    }
    if (node.getAttribute('data-ctx-cache-pct') !== nextCacheAttr) {
      node.setAttribute('data-ctx-cache-pct', nextCacheAttr);
    }

    var tooltipStr = (workerName ? ('🐾 ' + workerName + ' (' + meta.cn + ') | ') : '') + formatContextTooltip(ctx);
    if (node.getAttribute('title') !== tooltipStr) {
      node.setAttribute('title', tooltipStr);
    }
  }

  function decorateAllSubagentNodes() {
    var nodes = document.querySelectorAll('div[data-testid="subagent-node"]');
    if (!nodes || nodes.length === 0) return;

    // Group nodes by their own list container so expanding the chat-tray subagent drawer
    // never breaks width/layout of the right-hand Overview Subagents panel (and vice versa).
    var seenContainers = [];
    var nodeContainerMap = [];
    for (var i = 0; i < nodes.length; i++) {
      var lc = findSubagentListContainer(nodes[i]);
      nodeContainerMap.push(lc);
      if (lc && seenContainers.indexOf(lc) === -1) {
        seenContainers.push(lc);
      }
    }

    for (var c = 0; c < seenContainers.length; c++) {
      var container = seenContainers[c];
      var cntInContainer = 0;
      for (var j = 0; j < nodeContainerMap.length; j++) {
        if (nodeContainerMap[j] === container) cntInContainer++;
      }
      var containerTwoCol = !!(state.partyTwoCol && cntInContainer >= 2);
      if (containerTwoCol) {
        container.classList.add('pkmn-party-grid-2col');
      } else {
        container.classList.remove('pkmn-party-grid-2col');
        container.style.setProperty('width', '100%', 'important');
        container.style.setProperty('max-width', '100%', 'important');
        container.style.setProperty('align-items', 'stretch', 'important');
      }
      if (container.parentElement) {
        container.parentElement.style.setProperty('width', '100%', 'important');
        container.parentElement.style.setProperty('max-width', '100%', 'important');
        container.parentElement.style.setProperty('align-items', 'stretch', 'important');
      }
      ensureSubagentHeaderToggle(container);
    }

    for (var k = 0; k < nodes.length; k++) {
      var n = nodes[k];
      var ownContainer = nodeContainerMap[k];
      var ownTwoCol = !!(ownContainer && ownContainer.classList && ownContainer.classList.contains('pkmn-party-grid-2col'));
      if (n.parentElement && n.parentElement !== ownContainer) {
        n.parentElement.style.setProperty('width', '100%', 'important');
        n.parentElement.style.setProperty('max-width', '100%', 'important');
        n.parentElement.style.setProperty('min-width', '0', 'important');
        n.parentElement.style.setProperty('display', 'block', 'important');
      }
      if (ownTwoCol) {
        n.style.setProperty('width', '100%', 'important');
        n.style.setProperty('max-width', '100%', 'important');
      } else {
        n.style.setProperty('width', 'calc(100% - 12px)', 'important');
        n.style.setProperty('max-width', 'calc(100% - 12px)', 'important');
        n.style.setProperty('min-width', '0', 'important');
        n.style.setProperty('box-sizing', 'border-box', 'important');
      }
      decorateSingleSubagentNode(n, k);
    }
  }

  // ==========================================================================
  // 5. Top-Bar Global Theme Switcher Pill & Menu (Syncs with Shared OS Overlay)
  // ==========================================================================

  var pillEl = null;
  var pillSpriteEl = null;
  var pillLabelEl = null;
  var pillCountEl = null;
  var menuEl = null;
  var themeOptButtons = {};
  var btnStyleToggle = null;
  var btnPartyToggle = null;
  var btnSummonOverlay = null;

  function showOverlaySummonToast(titleMsg, metaMsg) {
    ensureFocusToastDom();
    if (!focusToastEl || !focusToastTitleEl || !focusToastMetaEl) return;
    focusToastTitleEl.textContent = titleMsg || '🪟 正在召唤桌宠浮窗...';
    focusToastMetaEl.textContent = metaMsg || '✨ 已发送静默唤醒信号，桌面唯一置顶浮窗即将显现';
    focusToastEl.hidden = false;
    if (state.focusToastTimer) {
      clearTimeout(state.focusToastTimer);
    }
    state.focusToastTimer = setTimeout(function () {
      state.focusToastTimer = null;
      if (focusToastEl) focusToastEl.hidden = true;
    }, FOCUS_TOAST_HIDE_MS);
  }

  function summonSharedOverlayFromUi() {
    if (state.menuOpen && menuEl) {
      state.menuOpen = false;
      menuEl.hidden = true;
    }
    showOverlaySummonToast(
      '🪟 正在召唤/重开全局置顶浮窗...',
      '🔴 红圈=已用上下文 · 🟢 绿圈=缓存命中 · 单击👑看会话 · 双击弹起项目'
    );
    if (typeof window.fetch !== 'function') {
      return Promise.resolve({ ok: false });
    }
    return window.fetch(BRIDGE_BASE + '/api/summon-overlay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        theme: toBridgeThemeId(state.theme),
        spriteStyle: state.spriteStyle,
        source: 'global-skin-menu:' + WINDOW_ID
      })
    })
      .then(function (res) {
        return res && res.ok ? res.json() : { ok: false, status: res ? res.status : 0 };
      })
      .then(function (data) {
        if (data && data.ok) {
          showOverlaySummonToast(
            '✅ 已唤醒全局唯一置顶桌宠浮窗！',
            '🔴 外圈红条=已用上下文 · 🟢 内圈绿条=缓存命中 · 按住伙伴可自由拖拽'
          );
        }
        return data;
      })
      .catch(function () {
        showOverlaySummonToast(
          '🛰️ 正在连接 17580 状态桥并唤醒置顶浮窗...',
          '请稍候 1~2 秒，主进程静默守护器将自动拉起'
        );
        return { ok: false };
      });
  }

  function ensureTopPillAndMenu() {
    if (!document.body) return;
    if (pillEl && document.body.contains(pillEl)) return;

    pillEl = document.createElement('div');
    pillEl.id = 'pkmn-global-skin-pill';
    pillEl.title = '点击切换全局配色主题，或召唤桌宠浮窗';

    pillSpriteEl = document.createElement('img');
    pillSpriteEl.className = 'pkmn-pill-sprite';
    pillSpriteEl.alt = 'Agent Pets';

    pillLabelEl = document.createElement('span');
    pillCountEl = document.createElement('span');
    pillCountEl.className = 'pkmn-pill-count';

    pillEl.appendChild(pillSpriteEl);
    pillEl.appendChild(pillLabelEl);
    pillEl.appendChild(pillCountEl);

    pillEl.addEventListener('click', function (ev) {
      ev.stopPropagation();
      state.menuOpen = !state.menuOpen;
      if (menuEl) {
        menuEl.hidden = !state.menuOpen;
      }
    });

    menuEl = document.createElement('div');
    menuEl.id = 'pkmn-global-skin-menu';
    menuEl.hidden = true;
    menuEl.addEventListener('click', function (ev) {
      ev.stopPropagation();
    });

    var title1 = document.createElement('div');
    title1.className = 'pkmn-menu-title';
    title1.textContent = '🎨 全局配色主题（与桌宠浮窗同步）';
    menuEl.appendChild(title1);

    var grid = document.createElement('div');
    grid.className = 'pkmn-theme-grid';
    themeOptButtons = {};

    for (var i = 0; i < THEMES.length; i++) {
      (function (t) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'pkmn-theme-opt';
        b.textContent = t.label;
        b.addEventListener('click', function () {
          setTheme(t.id, true);
        });
        themeOptButtons[t.id] = b;
        grid.appendChild(b);
      })(THEMES[i]);
    }
    menuEl.appendChild(grid);

    var title2 = document.createElement('div');
    title2.className = 'pkmn-menu-title';
    title2.textContent = '🐾 编队卡片与全局唯一共享浮窗';
    menuEl.appendChild(title2);

    btnSummonOverlay = document.createElement('button');
    btnSummonOverlay.type = 'button';
    btnSummonOverlay.id = 'pkmn-menu-summon-overlay-btn';
    btnSummonOverlay.className = 'pkmn-menu-summon-btn';
    btnSummonOverlay.textContent = '🪟 召唤/重开全局置顶浮窗';
    btnSummonOverlay.title = '唤醒桌宠浮窗（解除「收回」并置顶显示）';
    btnSummonOverlay.addEventListener('click', function (ev) {
      ev.stopPropagation();
      summonSharedOverlayFromUi();
    });
    menuEl.appendChild(btnSummonOverlay);

    var row1 = document.createElement('div');
    row1.className = 'pkmn-menu-row';
    btnPartyToggle = document.createElement('button');
    btnPartyToggle.type = 'button';
    btnPartyToggle.className = 'pkmn-menu-action';
    btnPartyToggle.addEventListener('click', togglePartyColumns);

    row1.appendChild(btnPartyToggle);
    menuEl.appendChild(row1);

    var infoNote = document.createElement('div');
    infoNote.style.marginTop = '8px';
    infoNote.style.padding = '5px 8px';
    infoNote.style.borderRadius = '8px';
    infoNote.style.fontSize = '10.5px';
    infoNote.style.opacity = '0.86';
    infoNote.style.border = '1px solid var(--pkmn-border)';
    infoNote.textContent = '🔴 外圈=已用上下文 · 🟢 内圈=缓存命中 · 单击👑领队看会话 · 双击领队弹起项目';
    menuEl.appendChild(infoNote);

    document.addEventListener('click', function () {
      if (state.menuOpen && menuEl) {
        state.menuOpen = false;
        menuEl.hidden = true;
      }
    });

    document.body.appendChild(pillEl);
    document.body.appendChild(menuEl);
  }

  function updateTopPillAndMenu(companions) {
    if (!pillEl) return;
    var info = getThemeInfo(state.theme);
    var spUrl = getSpriteUrl(themeSpecies());
    if (pillSpriteEl && pillSpriteEl.getAttribute('data-key') !== spUrl) {
      pillSpriteEl.src = spUrl;
      pillSpriteEl.setAttribute('data-key', spUrl);
    }
    if (pillLabelEl) {
      pillLabelEl.textContent = info.short + '皮肤';
    }
    var list = companions || getEffectiveCompanionList();
    var activeCnt = 0;
    for (var i = 0; i < list.length; i++) {
      if (list[i].state === 'working' || list[i].state === 'thinking') activeCnt++;
    }
    if (pillCountEl) {
      var nextCountTxt = activeCnt > 0 ? ('⚡' + activeCnt + '/' + list.length) : ('🐾' + list.length);
      if (pillCountEl.textContent !== nextCountTxt) {
        pillCountEl.textContent = nextCountTxt;
      }
    }

    for (var tid in themeOptButtons) {
      themeOptButtons[tid].setAttribute('data-active', tid === state.theme ? '1' : '0');
    }
    if (btnPartyToggle) {
      var ptTxt = state.partyTwoCol ? '🎴 Subagents: 2列' : '📋 Subagents: 1列';
      if (btnPartyToggle.textContent !== ptTxt) btnPartyToggle.textContent = ptTxt;
    }
  }

  // ==========================================================================
  // 5b. Composer Model Context Ring & Telemetry Hover Popover
  // ==========================================================================

  var ctxRingEl = null;
  var ctxRingArcEl = null;
  var ctxRingPctEl = null;
  var ctxPopoverEl = null;
  var ctxPopoverHideTimer = null;
  var ctxPopoverRefs = null;
  var ctxPopoverHovering = false;
  var ctxModelNameCache = '';

  function formatDurationCompact(ms) {
    if (ms === null || ms === undefined || !isFinite(Number(ms))) return '—';
    var v = Number(ms);
    if (v < 1000) return '<1.0s';
    if (v < 60000) return (Math.round(v / 100) / 10).toFixed(1) + 's';
    var mins = Math.floor(v / 60000);
    var secs = Math.round((v % 60000) / 1000);
    return mins + 'm ' + secs + 's';
  }

  function findComposerModelButton() {
    var modelRx = /\b(orchestrator|carbon|argon|hydrogen|oxygen|nitrogen|helium|neon|silicon|claude|opus|sonnet|haiku|gemini|gpt|o[134]-?|deepseek|qwen|grok|codex|kimi|glm|llama|mistral)\b/i;
    var excludeRx = /^(turbo|planning|fast|send|stop|new conversation|open ide|review|automations|customizations|settings|ask|agent|edit|\+)$/i;
    var excludeSubRx = /\b(turbo|planning|fast|new conversation|open ide|automations|customizations|settings)\b/i;
    var winH = window.innerHeight || 900;

    // Find active bottom composer editor bounding rect so we match toolbar buttons right beneath it.
    var edRect = null;
    var editors = document.querySelectorAll('textarea, [contenteditable="true"]');
    for (var ei = 0; ei < editors.length; ei++) {
      var ed = editors[ei];
      if (!ed || isHiddenOrExiting(ed)) continue;
      var er = ed.getBoundingClientRect ? ed.getBoundingClientRect() : null;
      if (!er || er.width < 120 || er.top < winH * 0.45) continue;
      if (!edRect || er.top > edRect.top) edRect = er;
    }

    var buttons = document.querySelectorAll('button, [role="button"], [role="combobox"]');
    var bestBtn = null;
    var bestScore = -1;
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (!btn || btn.id === 'pkmn-composer-ctx-ring' || btn.closest('#pkmn-composer-ctx-popover')) continue;
      var txt = (btn.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 64) continue;
      if (excludeRx.test(txt) || excludeSubRx.test(txt)) continue;
      var rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
      if (!rect || rect.width <= 0 || rect.height <= 0 || rect.height > 44 || rect.width > 340) continue;
      if (rect.top < winH * 0.52) continue;

      var inComposerBand = edRect
        ? (rect.top >= edRect.top - 10 && rect.top <= edRect.bottom + 110 && rect.left >= edRect.left - 80 && rect.left <= edRect.right + 40)
        : (rect.top > winH * 0.68);
      if (edRect && !inComposerBand) continue;

      var isKnownModel = modelRx.test(txt);
      var hasChevron = !!btn.querySelector('svg');
      if (!isKnownModel && !(inComposerBand && hasChevron && txt.length >= 3)) continue;

      var score = inComposerBand ? 12 : 2;
      if (isKnownModel) score += 20;
      if (hasChevron) score += 5;
      if (score > bestScore) {
        bestScore = score;
        bestBtn = btn;
      }
    }
    return bestBtn;
  }

  function resolveActiveSessionContext() {
    var projects = getEffectiveProjects();
    var allQueues = [];
    for (var i = 0; i < projects.length; i++) {
      var qs = projects[i] && projects[i].queues;
      if (!Array.isArray(qs)) continue;
      for (var j = 0; j < qs.length; j++) {
        if (qs[j] && qs[j].leadAgent) allQueues.push(qs[j]);
      }
    }
    if (allQueues.length === 0) return null;

    var liveMeta = extractWindowSessionMeta();
    var domTitle = String((liveMeta && liveMeta.conversationTitle) || (state.lastDomScan && state.lastDomScan.conversationTitle) || '').trim();
    var domTitleLower = domTitle.toLowerCase();
    var domProjLower = String((liveMeta && liveMeta.projectName) || '').trim().toLowerCase();

    // Blank / New Conversation: never bleed progress from a previously opened session.
    if (!domTitleLower || /^(new conversation|新建对话|new chat|start a new conversation|command center)$/i.test(domTitleLower)) {
      return null;
    }

    var chosen = null;
    for (var k = 0; k < allQueues.length; k++) {
      var q = allQueues[k];
      var qt = String(q.conversationTitle || q.headerTitle || '').trim().toLowerCase();
      var qp = String(q.projectName || '').trim().toLowerCase();
      if (!qt) continue;
      var titleMatches = (qt === domTitleLower || qt.indexOf(domTitleLower) !== -1 || domTitleLower.indexOf(qt) !== -1);
      if (titleMatches && (!domProjLower || !qp || qp === domProjLower)) {
        chosen = q;
        break;
      }
    }
    if (!chosen) {
      for (var k2 = 0; k2 < allQueues.length; k2++) {
        var qt2 = String(allQueues[k2].conversationTitle || allQueues[k2].headerTitle || '').trim().toLowerCase();
        if (qt2 && (qt2 === domTitleLower || qt2.indexOf(domTitleLower) !== -1 || domTitleLower.indexOf(qt2) !== -1)) {
          chosen = allQueues[k2];
          break;
        }
      }
    }
    // If the currently open conversation does not match any active queue (e.g. brand-new or unstarted),
    // return null so it renders 0% instead of leaking another session's telemetry.
    if (!chosen) return null;

    return {
      queue: chosen,
      context: normalizeAgentContext(chosen.leadAgent && chosen.leadAgent.context, chosen.leadAgent)
    };
  }

  function ensureComposerCtxPopover() {
    if (ctxPopoverEl && document.body && document.body.contains(ctxPopoverEl)) {
      return ctxPopoverEl;
    }
    var pop = document.createElement('div');
    pop.id = 'pkmn-composer-ctx-popover';
    pop.hidden = true;

    var head = document.createElement('div');
    head.className = 'pkmn-ctx-pop-head';
    var modelEl = document.createElement('div');
    modelEl.className = 'pkmn-ctx-pop-model';
    var badgeEl = document.createElement('div');
    badgeEl.className = 'pkmn-ctx-pop-badge';
    head.appendChild(modelEl);
    head.appendChild(badgeEl);
    pop.appendChild(head);

    var barWrap = document.createElement('div');
    barWrap.className = 'pkmn-ctx-pop-bar-wrap';
    var barRow = document.createElement('div');
    barRow.className = 'pkmn-ctx-pop-bar-row';
    var barLblLeft = document.createElement('span');
    var barLblRight = document.createElement('span');
    barLblRight.style.fontWeight = '700';
    barRow.appendChild(barLblLeft);
    barRow.appendChild(barLblRight);
    var barTrack = document.createElement('div');
    barTrack.className = 'pkmn-ctx-pop-bar-track';
    var barFill = document.createElement('div');
    barFill.className = 'pkmn-ctx-pop-bar-fill';
    barTrack.appendChild(barFill);
    barWrap.appendChild(barRow);
    barWrap.appendChild(barTrack);
    pop.appendChild(barWrap);

    var grid = document.createElement('div');
    grid.className = 'pkmn-ctx-pop-grid';
    var makeCell = function (label) {
      var cell = document.createElement('div');
      cell.className = 'pkmn-ctx-pop-cell';
      var k = document.createElement('div');
      k.className = 'pkmn-ctx-pop-k';
      k.textContent = label;
      var v = document.createElement('div');
      v.className = 'pkmn-ctx-pop-v';
      var sub = document.createElement('div');
      sub.className = 'pkmn-ctx-pop-sub';
      cell.appendChild(k);
      cell.appendChild(v);
      cell.appendChild(sub);
      grid.appendChild(cell);
      return { v: v, sub: sub };
    };

    var cellTps = makeCell('生成速度 (TPS)');
    var cellTtfp = makeCell('首步延迟 (TTFP)');
    var cellCache = makeCell('缓存命中 (Cache)');
    var cellTok = makeCell('本步 Token');
    pop.appendChild(grid);

    pop.addEventListener('mouseenter', function () {
      ctxPopoverHovering = true;
      if (ctxPopoverHideTimer) {
        clearTimeout(ctxPopoverHideTimer);
        ctxPopoverHideTimer = null;
      }
    });
    pop.addEventListener('mouseleave', function () {
      ctxPopoverHovering = false;
      scheduleHideComposerCtxPopover();
    });

    document.body.appendChild(pop);
    ctxPopoverEl = pop;
    ctxPopoverRefs = {
      model: modelEl,
      badge: badgeEl,
      barLeft: barLblLeft,
      barRight: barLblRight,
      barFill: barFill,
      tps: cellTps,
      ttfp: cellTtfp,
      cache: cellCache,
      tok: cellTok
    };
    return pop;
  }

  function positionComposerCtxPopover() {
    if (!ctxRingEl || !ctxPopoverEl || ctxPopoverEl.hidden) return;
    var r = ctxRingEl.getBoundingClientRect();
    var popW = 288;
    var popH = ctxPopoverEl.offsetHeight || 180;
    var left = Math.max(8, Math.min((window.innerWidth || 1200) - popW - 8, r.left - 16));
    var top = r.top - popH - 8;
    if (top < 8) top = r.bottom + 8;
    ctxPopoverEl.style.left = Math.round(left) + 'px';
    ctxPopoverEl.style.top = Math.round(top) + 'px';
  }

  function showComposerCtxPopover() {
    if (ctxPopoverHideTimer) {
      clearTimeout(ctxPopoverHideTimer);
      ctxPopoverHideTimer = null;
    }
    var pop = ensureComposerCtxPopover();
    updateComposerContextRing();
    pop.hidden = false;
    positionComposerCtxPopover();
  }

  function scheduleHideComposerCtxPopover() {
    if (ctxPopoverHideTimer) clearTimeout(ctxPopoverHideTimer);
    ctxPopoverHideTimer = setTimeout(function () {
      ctxPopoverHideTimer = null;
      if (!ctxPopoverHovering && ctxPopoverEl) {
        ctxPopoverEl.hidden = true;
      }
    }, 140);
  }

  function resolveHorizontalInsertTarget(modelBtn) {
    var anchor = modelBtn;
    var parent = modelBtn ? modelBtn.parentElement : null;
    for (var depth = 0; depth < 4 && parent; depth++) {
      var cs = window.getComputedStyle ? window.getComputedStyle(parent) : null;
      var disp = cs ? cs.display : '';
      var dir = cs ? cs.flexDirection : '';
      var isHorizontalFlex = (disp === 'flex' || disp === 'inline-flex') && dir !== 'column' && dir !== 'column-reverse';
      if (isHorizontalFlex) {
        return { parent: parent, anchor: anchor };
      }
      anchor = parent;
      parent = parent.parentElement;
    }
    return { parent: modelBtn.parentElement, anchor: modelBtn };
  }

  function ensureComposerContextRing(modelBtn) {
    if (!modelBtn || !modelBtn.parentElement) return null;
    var target = resolveHorizontalInsertTarget(modelBtn);
    var hostParent = target.parent;
    var anchorNode = target.anchor;
    if (!hostParent || !anchorNode) return null;

    if (hostParent.style && hostParent.getAttribute('data-pkmn-ctx-row') !== '1') {
      hostParent.setAttribute('data-pkmn-ctx-row', '1');
      if (hostParent.style.flexWrap !== 'nowrap') {
        hostParent.style.flexWrap = 'nowrap';
      }
    }

    if (ctxRingEl && ctxRingEl.parentElement === hostParent && anchorNode.nextSibling === ctxRingEl) {
      return ctxRingEl;
    }
    if (ctxRingEl && ctxRingEl.parentNode) {
      ctxRingEl.parentNode.removeChild(ctxRingEl);
    }

    var ringBtn = document.createElement('button');
    ringBtn.id = 'pkmn-composer-ctx-ring';
    ringBtn.type = 'button';
    ringBtn.setAttribute('aria-label', '当前会话上下文与性能参数');

    var svgNs = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 20 20');

    var bgCircle = document.createElementNS(svgNs, 'circle');
    bgCircle.setAttribute('cx', '10');
    bgCircle.setAttribute('cy', '10');
    bgCircle.setAttribute('r', '7.2');
    bgCircle.setAttribute('fill', 'none');
    bgCircle.setAttribute('stroke', 'rgba(255,255,255,0.16)');
    bgCircle.setAttribute('stroke-width', '2.4');

    var arcCircle = document.createElementNS(svgNs, 'circle');
    arcCircle.setAttribute('cx', '10');
    arcCircle.setAttribute('cy', '10');
    arcCircle.setAttribute('r', '7.2');
    arcCircle.setAttribute('fill', 'none');
    arcCircle.setAttribute('stroke', '#38bdf8');
    arcCircle.setAttribute('stroke-width', '2.4');
    arcCircle.setAttribute('stroke-linecap', 'round');
    var circ = 2 * Math.PI * 7.2;
    arcCircle.setAttribute('stroke-dasharray', circ.toFixed(2));
    arcCircle.setAttribute('stroke-dashoffset', circ.toFixed(2));

    svg.appendChild(bgCircle);
    svg.appendChild(arcCircle);

    var pctSpan = document.createElement('span');
    pctSpan.className = 'pkmn-ctx-ring-pct';
    pctSpan.textContent = '0%';

    ringBtn.appendChild(svg);
    ringBtn.appendChild(pctSpan);

    ringBtn.addEventListener('mouseenter', function () {
      ctxPopoverHovering = true;
      showComposerCtxPopover();
    });
    ringBtn.addEventListener('mouseleave', function () {
      ctxPopoverHovering = false;
      scheduleHideComposerCtxPopover();
    });
    ringBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var pop = ensureComposerCtxPopover();
      if (pop.hidden) showComposerCtxPopover();
      else pop.hidden = true;
    });

    if (anchorNode.nextSibling) {
      hostParent.insertBefore(ringBtn, anchorNode.nextSibling);
    } else {
      hostParent.appendChild(ringBtn);
    }
    ctxRingEl = ringBtn;
    ctxRingArcEl = arcCircle;
    ctxRingPctEl = pctSpan;
    return ringBtn;
  }

  function updateComposerContextRing() {
    var modelBtn = findComposerModelButton();
    if (!modelBtn) return;
    var btnTxt = (modelBtn.textContent || '').replace(/\s+/g, ' ').trim();
    ctxModelNameCache = btnTxt || 'Current Model';
    ensureComposerContextRing(modelBtn);
    if (!ctxRingArcEl || !ctxRingPctEl) return;

    var active = resolveActiveSessionContext();
    var ctx = active ? active.context : normalizeAgentContext(null, null);
    var pct = Math.max(0, Math.min(100, Number(ctx.usedPct) || 0));
    var circ = 2 * Math.PI * 7.2;
    var offset = circ * (1 - pct / 100);
    var ringColor = pct >= 82 ? '#ef4444' : (pct >= 60 ? '#f59e0b' : '#38bdf8');

    ctxRingArcEl.setAttribute('stroke-dashoffset', offset.toFixed(2));
    ctxRingArcEl.setAttribute('stroke', ringColor);
    var pctText = Math.round(pct) + '%';
    if (ctxRingPctEl.textContent !== pctText) {
      ctxRingPctEl.textContent = pctText;
    }

    if (ctxPopoverRefs) {
      ctxPopoverRefs.model.textContent = ctxModelNameCache;
      ctxPopoverRefs.badge.setAttribute('data-warm', ctx.cacheWarm ? '1' : '0');
      ctxPopoverRefs.badge.textContent = ctx.cacheKnown
        ? (ctx.cacheWarm ? '🟢 缓存预热中' : '🟡 缓存已过期')
        : '⚪ 等待首轮';

      ctxPopoverRefs.barLeft.textContent = '已用上下文 · ' + ctx.usedTokensLabel + ' / ' + ctx.maxTokensLabel;
      ctxPopoverRefs.barRight.textContent = pct.toFixed(1) + '% (剩 ' + formatTokenShort(ctx.remainingTokens) + ')';
      ctxPopoverRefs.barFill.style.width = Math.max(2, Math.min(100, pct)) + '%';
      ctxPopoverRefs.barFill.style.backgroundColor = ringColor;

      ctxPopoverRefs.tps.v.textContent = ctx.tps !== null ? (ctx.tps + ' tok/s') : '—';
      ctxPopoverRefs.tps.sub.textContent = ctx.avgTps !== null ? ('近段均值 ' + ctx.avgTps + ' tok/s') : '等待生成样本';

      ctxPopoverRefs.ttfp.v.textContent = formatDurationCompact(ctx.ttfpMs);
      ctxPopoverRefs.ttfp.sub.textContent = ctx.lastTurnDurationMs !== null
        ? ('本轮耗时 ' + formatDurationCompact(ctx.lastTurnDurationMs))
        : '首步响应延迟';

      ctxPopoverRefs.cache.v.textContent = ctx.cacheKnown ? (ctx.cacheHitPct + '%') : '—';
      ctxPopoverRefs.cache.sub.textContent = ctx.cacheRequests > 0
        ? ('近5次 ' + Math.round(ctx.cacheRecentPct) + '% · ' + ctx.cacheRequests + '次请求')
        : ('命中 ' + formatTokenShort(ctx.cachedTokens));

      ctxPopoverRefs.tok.v.textContent = formatTokenShort(ctx.outputTokens) + ' out';
      ctxPopoverRefs.tok.sub.textContent = '命中 ' + formatTokenShort(ctx.cachedTokens) + ' · 新增 ' + formatTokenShort(ctx.uncachedTokens);
    }
  }

  function refreshAllUi() {
    removeLegacyInWindowPetStrip();
    applyRootAttributes();
    ensureTopPillAndMenu();
    var projects = getEffectiveProjects();
    var companions = [];
    for (var i = 0; i < projects.length; i++) {
      for (var j = 0; j < projects[i].queues.length; j++) {
        var q = projects[i].queues[j];
        companions.push(q.leadAgent);
        for (var k = 0; k < q.subagents.length; k++) companions.push(q.subagents[k]);
      }
    }
    updateTopPillAndMenu(companions);
    decorateAllSubagentNodes();
    updateComposerContextRing();
    pushUiSyncIfNeeded(false, false);
  }

  // ==========================================================================
  // 6. Live Telemetry Bridge v4.0 Sync (SSE `snapshot`, `focus-session`, `theme-change`)
  // ==========================================================================

  function indexAgentForLookup(a) {
    if (!a) return;
    if (a.id) state.agentsById.set(String(a.id), a);
    if (a.name) state.agentsByName.set(String(a.name).toLowerCase(), a);
  }

  function ingestBridgePayload(data, mergeOnly) {
    if (!data || typeof data !== 'object') return;

    if (data.activeTheme) {
      applyRemoteThemeIfNeeded(data.activeTheme, false);
    }
    if (data.pack && data.pack.id && (data.pack.id !== pack.id || data.pack.version !== pack.version)) {
      loadPack(true);
    }

    if (!(state.agentsById instanceof Map) || (!mergeOnly && state.agentsById.size > 96)) {
      state.agentsById = new Map();
    }
    if (!(state.agentsByName instanceof Map) || (!mergeOnly && state.agentsByName.size > 96)) {
      state.agentsByName = new Map();
    }

    if (Array.isArray(data.agents)) {
      if (!mergeOnly) state.agents = data.agents;
      for (var i = 0; i < data.agents.length; i++) {
        indexAgentForLookup(data.agents[i]);
      }
    }

    if (Array.isArray(data.projects)) {
      state.bridgeProjects = data.projects;
      state.hasV3BridgeProjects = true;
      for (var p = 0; p < data.projects.length; p++) {
        var qs = data.projects[p] && data.projects[p].queues;
        if (!Array.isArray(qs)) continue;
        for (var q = 0; q < qs.length; q++) {
          indexAgentForLookup(qs[q].leadAgent);
          var subs = qs[q].subagents;
          if (Array.isArray(subs)) {
            for (var s = 0; s < subs.length; s++) indexAgentForLookup(subs[s]);
          }
        }
      }
    } else if (Array.isArray(data.queues)) {
      var groupedMap = new Map();
      var groupedList = [];
      for (var qi = 0; qi < data.queues.length; qi++) {
        var rq = data.queues[qi];
        if (!rq) continue;
        indexAgentForLookup(rq.leadAgent);
        if (Array.isArray(rq.subagents)) {
          for (var si = 0; si < rq.subagents.length; si++) indexAgentForLookup(rq.subagents[si]);
        }
        var pn = rq.projectName || '全局会话';
        if (!groupedMap.has(pn)) {
          var gObj = { projectId: pn.toLowerCase(), projectName: pn, queues: [] };
          groupedMap.set(pn, gObj);
          groupedList.push(gObj);
        }
        groupedMap.get(pn).queues.push(rq);
      }
      state.bridgeProjects = groupedList;
      state.hasV3BridgeProjects = true;
    } else if (Array.isArray(data.agents)) {
      state.bridgeProjects = [];
      state.hasV3BridgeProjects = false;
    }

    // Fallback polling support for `lastFocusRequest` / `latestFocusCommand` when SSE is reconnecting
    var focusCmd = data.lastFocusRequest || data.latestFocusCommand;
    if (focusCmd && typeof focusCmd === 'object') {
      handleFocusSessionCommand(focusCmd);
    }

    state.bridgeConnected = true;
    var companions = getEffectiveCompanionList();
    updateTopPillAndMenu(companions);
    decorateAllSubagentNodes();
    updateComposerContextRing();
  }

  function pollBridgeOnce() {
    if (typeof window.fetch !== 'function') return;
    window.fetch(BRIDGE_BASE + '/api/agents', { cache: 'no-store' })
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data) ingestBridgePayload(data, false);
      })
      .catch(function () {
        state.bridgeConnected = false;
      });
  }

  var sseSource = null;
  var sseRetryTimer = null;
  function connectBridgeSse() {
    if (typeof window.EventSource !== 'function') return;
    if (sseSource) return;
    try {
      sseSource = new window.EventSource(BRIDGE_BASE + '/api/events');
      var onSsePayload = function (ev) {
        try {
          if (!ev || !ev.data) return;
          var parsed = JSON.parse(ev.data);
          var hasLocalChat = state.lastDomScan && (state.lastDomScan.hasChatDom || state.lastDomScan.subagents.length > 0);
          ingestBridgePayload(parsed, !!hasLocalChat && !Array.isArray(parsed.projects));
        } catch (_e) {}
      };
      sseSource.addEventListener('snapshot', onSsePayload);
      sseSource.addEventListener('focus-session', function (ev) {
        try {
          if (!ev || !ev.data) return;
          var cmd = JSON.parse(ev.data);
          handleFocusSessionCommand(cmd);
        } catch (_e) {}
      });
      sseSource.addEventListener('pack-change', function () { loadPack(true); });
      sseSource.addEventListener('theme-change', function (ev) {
        try {
          if (!ev || !ev.data) return;
          var evt = JSON.parse(ev.data);
          if (evt && evt.theme && String(evt.source || '') !== ('global-skin-pill:' + WINDOW_ID)) {
            applyRemoteThemeIfNeeded(evt.theme, true);
          }
        } catch (_e) {}
      });
      sseSource.onmessage = onSsePayload;
      sseSource.onerror = function () {
        if (sseSource) {
          sseSource.close();
          sseSource = null;
        }
        if (!sseRetryTimer) {
          sseRetryTimer = setTimeout(function () {
            sseRetryTimer = null;
            connectBridgeSse();
          }, 3000);
        }
      };
    } catch (_err) {}
  }

  var rafScheduled = false;
  var domRefreshTimer = null;
  var lastDomRefreshAt = 0;
  function scheduleDomRefresh() {
    if (rafScheduled || domRefreshTimer) return;
    var elapsed = Date.now() - lastDomRefreshAt;
    var waitMs = elapsed >= 250 ? 0 : (250 - elapsed);
    domRefreshTimer = setTimeout(function () {
      domRefreshTimer = null;
      if (rafScheduled) return;
      rafScheduled = true;
      window.requestAnimationFrame(function () {
        rafScheduled = false;
        lastDomRefreshAt = Date.now();
        refreshAllUi();
      });
    }, waitMs);
  }

  function boot() {
    loadPack(false);
    applyRootAttributes();
    removeLegacyInWindowPetStrip();
    if (!document.body) {
      window.addEventListener('DOMContentLoaded', boot, { once: true });
      return;
    }
    refreshAllUi();
    pushUiSyncIfNeeded(true, false);

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var t = mutations[i].target;
        if (t && t.closest && (
          t.closest('#pkmn-focus-session-toast') ||
          t.closest('#pkmn-global-skin-pill') ||
          t.closest('#pkmn-global-skin-menu') ||
          t.closest('div[data-pkmn-party-deco="1"]') ||
          t.closest('.monaco-editor')
        )) {
          continue;
        }
        scheduleDomRefresh();
        break;
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    window.addEventListener('focus', function () {
      pushUiSyncIfNeeded(true, false);
      pollBridgeOnce();
    });

    window.addEventListener('blur', function () {
      pushUiSyncIfNeeded(true, false);
    });

    document.addEventListener('visibilitychange', function () {
      pushUiSyncIfNeeded(true, false);
    });

    window.addEventListener('beforeunload', function () {
      try {
        if (typeof window.fetch === 'function') {
          window.fetch(BRIDGE_BASE + '/api/ui-sync?windowId=' + encodeURIComponent(WINDOW_ID), {
            method: 'DELETE',
            keepalive: true
          }).catch(function () {});
        }
      } catch (_e) {}
    });

    pollBridgeOnce();
    connectBridgeSse();
    setInterval(refreshAllUi, 2500);
    setInterval(function () {
      if (!sseSource || sseSource.readyState !== 1) {
        pollBridgeOnce();
      }
    }, 10000);
  }

  // Expose diagnostic hooks for live verification & QA
  window.__POKEMON_GET_WINDOW_ID__ = function () { return WINDOW_ID; };
  window.__POKEMON_SET_HOST_PID__ = function (pid) {
    var numPid = Number(pid);
    if (isFinite(numPid) && numPid > 0 && state.hostPid !== numPid) {
      window.__POKEMON_HOST_PID__ = numPid;
      state.hostPid = numPid;
      pushUiSyncIfNeeded(true, false);
    }
  };
  window.__POKEMON_SCAN_LIVE_DOM_AGENTS__ = scanLiveDomAgents;
  window.__POKEMON_GET_EFFECTIVE_PROJECTS__ = getEffectiveProjects;
  window.__POKEMON_GET_EFFECTIVE_QUEUES__ = getEffectiveQueues;
  window.__POKEMON_GET_EFFECTIVE_COMPANIONS__ = getEffectiveCompanionList;
  window.__POKEMON_INGEST_BRIDGE_PAYLOAD__ = ingestBridgePayload;
  window.__POKEMON_HANDLE_FOCUS_SESSION__ = handleFocusSessionCommand;
  window.__POKEMON_SUMMON_OVERLAY__ = summonSharedOverlayFromUi;
  window.__POKEMON_NORMALIZE_CONTEXT__ = normalizeAgentContext;

  window.__POKEMON_GLOBAL_SKIN_REFRESH__ = function (newDefaultTheme) {
    removeLegacyInWindowPetStrip();
    if (newDefaultTheme && isValidTheme(newDefaultTheme)) {
      var stamp = safeGetStorage('pkmn_global_theme_stamp', '');
      if (stamp !== newDefaultTheme) {
        safeSetStorage('pkmn_global_theme_stamp', newDefaultTheme);
        setTheme(newDefaultTheme, true);
        return;
      }
    }
    scheduleDomRefresh();
  };

  boot();
})();
