/**
 * Agent Pets — skin-pack driven sprite engine (no embedded artwork).
 * File: assets/pet-sprites.js   (styles: assets/pet-sprites.css)
 *
 * Every creature, name, colour and sprite comes from the active skin pack, as described by the bridge's
 * `GET /api/pack` (see bridge/pet-packs.mjs). Pages call:
 *
 *   PetSprites.setPack(descriptor, { assetBase: 'http://127.0.0.1:17580' })   // or { mapUrl: (u) => ... }
 *   const pet = PetSprites.mountPet(el, { species, state, agentName, statusText, spriteMode, shiny });
 *   pet.setState('working'); pet.setSpecies('astra'); pet.setShiny(true); pet.destroy();
 *
 * Mounted pets re-render automatically when setPack() is called again (pack switch).
 * `spriteMode` keeps the historical ids: 'authentic-showdown' = the pack's main style,
 * 'authentic-pixel' = its pixelated style (the same style when the pack only has one).
 * Shiny: real shiny GIF from the pack when present, otherwise the pack's CSS hue filter.
 * The DOM is built without innerHTML (SVG overlays go through DOMParser).
 * Also exposed as `window.PokemonPets` for older pages.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  const g = root || globalThis;
  g.PetSprites = api;
  g.PokemonPets = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  let uidCounter = 0;
  const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const SPRITE_MODES = ['authentic-showdown', 'authentic-pixel'];

  function normalizeSpriteMode(rawMode) {
    const m = String(rawMode || '').trim().toLowerCase();
    if (m === 'authentic-pixel' || m === 'pixel' || m === 'bw' || m === 'gen5' || m === 'classic') return 'authentic-pixel';
    return 'authentic-showdown';
  }

  const STATES = {
    thinking: { id: 'thinking', cnLabel: '思考中', enLabel: 'THINKING', pillText: '💭 思考中', icon: '💭', badgeColor: '#FDE047' },
    working: { id: 'working', cnLabel: '工作中', enLabel: 'WORKING', pillText: '⚡ 工作中', icon: '⚡', badgeColor: '#38BDF8' },
    sleeping: { id: 'sleeping', cnLabel: '休眠中', enLabel: 'SLEEPING', pillText: '💤 休眠中', icon: '💤', badgeColor: '#94A3B8' },
    dragging: { id: 'dragging', cnLabel: '拖拽中', enLabel: 'DRAGGING', pillText: '🖐️ 悬空抓起', icon: '!', badgeColor: '#FB923C' },
    celebrating: { id: 'celebrating', cnLabel: '互动庆祝', enLabel: 'CELEBRATING', pillText: '✨ 开心互动', icon: '❤️', badgeColor: '#F472B6' },
    interacting: { id: 'interacting', cnLabel: '互动庆祝', enLabel: 'INTERACTING', pillText: '❤️ 开心互动', icon: '❤️', badgeColor: '#F472B6' },
    error: { id: 'error', cnLabel: '异常眩晕', enLabel: 'ERROR', pillText: '💫 异常告警', icon: '💧', badgeColor: '#FB7185' }
  };
  const CORE_STATE_IDS = ['thinking', 'working', 'sleeping', 'dragging', 'celebrating', 'error'];

  function normalizeState(rawState) {
    const s = String(rawState || '').trim().toLowerCase();
    if (!s) return 'sleeping';
    if (s === 'interacting' || s === 'happy' || s === 'done_celebrate' || s === 'success') return 'celebrating';
    if (s === 'thinking' || s === 'planning' || s === 'inferring' || s === 'reasoning') return 'thinking';
    if (s === 'working' || s === 'running' || s === 'executing' || s === 'coding' || s === 'active' || s === 'tool') return 'working';
    if (s === 'dragging' || s === 'grabbed' || s === 'held') return 'dragging';
    if (s === 'error' || s === 'failed' || s === 'stalled' || s === 'dizzy') return 'error';
    if (s === 'sleeping' || s === 'idle' || s === 'waiting' || s === 'stopped' || s === 'asleep') return 'sleeping';
    return STATES[s] ? s : 'sleeping';
  }

  // ---------------------------------------------------------------- pack state
  let pack = null;
  let assetBase = '';
  let urlMapper = null;
  const SPECIES = {};
  const SPECIES_LIST = [];
  const liveRenders = new Set();
  const packListeners = new Set();
  const FALLBACK_META = {
    id: '',
    dexNo: 0,
    cnName: '',
    enName: '',
    themeColor: '#94A3B8',
    accentColor: '#E2E8F0',
    glowColor: 'rgba(148, 163, 184, 0.45)',
    spark: '✨',
    rarity: 'N',
    creature: null
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  }

  function parseHex(hex) {
    const h = String(hex || '').replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(h)) return [148, 163, 184];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function toHex(rgb) {
    return '#' + rgb.map((n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0')).join('');
  }
  function mixHex(a, b, t) {
    const x = parseHex(a);
    const y = parseHex(b);
    return toHex(x.map((v, i) => v + (y[i] - v) * t));
  }
  function rgba(hex, alpha) {
    const [r, g, b] = parseHex(hex);
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')';
  }

  function mapUrl(u) {
    if (!u) return '';
    if (urlMapper) return urlMapper(u);
    if (/^(data:|blob:|https?:)/i.test(u)) return u;
    return assetBase + u;
  }

  function setPack(descriptor, options) {
    const opts = options || {};
    assetBase = String(opts.assetBase || '').replace(/\/+$/, '');
    urlMapper = typeof opts.mapUrl === 'function' ? opts.mapUrl : null;
    pack = descriptor && Array.isArray(descriptor.creatures) && descriptor.creatures.length ? descriptor : null;
    for (const k of Object.keys(SPECIES)) delete SPECIES[k];
    SPECIES_LIST.length = 0;
    if (pack) {
      for (const c of pack.creatures) {
        const color = /^#[0-9a-f]{6}$/i.test(String(c.color || '')) ? c.color : '#94A3B8';
        SPECIES[c.id] = {
          id: c.id,
          dexNo: Number(c.dexNo) || 0,
          cnName: String(c.name || c.id),
          enName: String(c.short || c.name || c.id),
          themeColor: color,
          accentColor: mixHex(color, '#FFFFFF', 0.5),
          glowColor: rgba(color, 0.55),
          spark: String(c.spark || '✨'),
          cheer: String(c.cheer || ''),
          rarity: String(c.rarity || 'N'),
          creature: c
        };
        SPECIES_LIST.push(c.id);
      }
    }
    liveRenders.forEach((fn) => {
      try {
        fn();
      } catch (_) {}
    });
    packListeners.forEach((fn) => {
      try {
        fn(pack);
      } catch (_) {}
    });
  }

  function onPackChange(fn) {
    packListeners.add(fn);
    return () => packListeners.delete(fn);
  }

  function metaOf(id) {
    return SPECIES[id] || Object.assign({}, FALLBACK_META, { id: id || '', cnName: id || '' });
  }

  function styleFor(mode) {
    if (!pack) return null;
    const styles = Array.isArray(pack.styles) ? pack.styles : [];
    const def = styles.find((s) => s.id === pack.defaultStyle) || styles[0] || null;
    if (normalizeSpriteMode(mode) === 'authentic-pixel') return styles.find((s) => s.pixelated) || def;
    if (def && !def.pixelated) return def;
    return styles.find((s) => !s.pixelated) || def;
  }

  /** Label of the style a sprite mode maps to, and whether the pack offers two distinct looks. */
  function styleInfo() {
    const main = styleFor('authentic-showdown');
    const pixel = styleFor('authentic-pixel');
    return {
      main: main ? { id: main.id, label: main.label || main.id } : null,
      pixel: pixel ? { id: pixel.id, label: pixel.label || pixel.id } : null,
      switchable: Boolean(main && pixel && main.id !== pixel.id)
    };
  }

  /** { src, filter, pixelated } for a creature in a sprite mode, honouring the shiny tiers. */
  function getSpriteInfo(speciesId, mode, shiny) {
    const sp = SPECIES[speciesId];
    if (!sp || !sp.creature) return { src: BLANK, filter: '', pixelated: false };
    const c = sp.creature;
    const st = styleFor(mode);
    const assets = c.assets || {};
    const a = (st && assets[st.id]) || assets[pack.defaultStyle] || assets[Object.keys(assets)[0]] || {};
    let src = a.gif || (a.frameUrls && a.frameUrls[0]) || c.artwork || '';
    let filter = '';
    if (shiny) {
      if (a.shinyGif) src = a.shinyGif;
      else if (!a.gif && a.shinyFrameUrls && a.shinyFrameUrls.length) src = a.shinyFrameUrls[0];
      else filter = (c.shiny && c.shiny.cssFilter) || 'hue-rotate(160deg)';
    }
    return { src: src ? mapUrl(src) : BLANK, filter, pixelated: Boolean(st && st.pixelated) };
  }

  function getAuthenticGifDataUri(speciesInput, styleInput, shiny) {
    return getSpriteInfo(normalizeSpecies(speciesInput), styleInput, shiny).src;
  }

  /** Known ids pass through; unknown ids are kept while no pack is loaded, else fall back to the first creature. */
  function normalizeSpecies(rawSpecies) {
    const key = String(rawSpecies || '').trim().toLowerCase();
    if (SPECIES[key]) return key;
    if (!pack) return key;
    return SPECIES_LIST[0] || '';
  }

  function resolveSpeciesForAgent(agentOrText) {
    if (agentOrText && typeof agentOrText === 'object') {
      const direct = String(agentOrText.pokemonSpecies || agentOrText.species || '').toLowerCase();
      if (SPECIES[direct]) return direct;
    }
    const probe = (
      typeof agentOrText === 'string'
        ? agentOrText
        : agentOrText
          ? [agentOrText.name, agentOrText.role, agentOrText.id].filter(Boolean).join(' ')
          : ''
    ).toLowerCase();
    if (!SPECIES_LIST.length) return '';
    for (const id of SPECIES_LIST) {
      const m = (SPECIES[id].creature && SPECIES[id].creature.match) || {};
      if (probe.indexOf(id) !== -1) return id;
      if (m.lead && /\blead\b|主控|leader/.test(probe)) return id;
      if (m.coordinator && /coordinat|orchestrat/.test(probe)) return id;
      const kws = Array.isArray(m.keywords) ? m.keywords : [];
      for (const kw of kws) if (kw && probe.indexOf(String(kw).toLowerCase()) !== -1) return id;
    }
    let hash = 0;
    for (let c = 0; c < probe.length; c++) hash = (hash * 31 + probe.charCodeAt(c)) >>> 0;
    return SPECIES_LIST[hash % SPECIES_LIST.length];
  }

  // ---------------------------------------------------------------- SVG overlays (aura, particles, state FX)
  function buildEmbeddedSvgCss(uid, state) {
    const k = (name) => uid + '-' + name;
    const parts = [
      '#' + uid + ' { overflow: visible; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; }',
      '#' + uid + ' .pk-char-motion { transform-origin: 80px 128px; }'
    ];
    if (state === 'thinking') parts.push('#' + uid + ' .pk-char-motion { animation: ' + k('think') + ' 2.3s ease-in-out infinite; } #' + uid + ' .pk-ground-shadow { animation: ' + k('shadow-float') + ' 2.3s ease-in-out infinite; }');
    if (state === 'working') parts.push('#' + uid + ' .pk-char-motion { animation: ' + k('work') + ' 0.48s cubic-bezier(0.36,0,0.66,1) infinite alternate; } #' + uid + ' .pk-ground-shadow { animation: ' + k('shadow-work') + ' 0.48s ease-in-out infinite alternate; }');
    if (state === 'sleeping') parts.push('#' + uid + ' .pk-char-motion { animation: ' + k('sleep') + ' 3.2s ease-in-out infinite; opacity: 0.9; } #' + uid + ' .pk-ground-shadow { transform: scaleX(1.12); opacity: 0.38; transform-origin: 80px 140px; }');
    if (state === 'dragging') parts.push('#' + uid + ' .pk-char-motion { animation: ' + k('drag') + ' 0.38s ease-in-out infinite alternate; } #' + uid + ' .pk-ground-shadow { transform: scale(0.62); opacity: 0.22; transform-origin: 80px 140px; }');
    if (state === 'celebrating') parts.push('#' + uid + ' .pk-char-motion { animation: ' + k('celebrate') + ' 0.68s cubic-bezier(0.25,0.85,0.35,1) infinite; } #' + uid + ' .pk-ground-shadow { animation: ' + k('shadow-jump') + ' 0.68s ease-in-out infinite; }');
    if (state === 'error') parts.push('#' + uid + ' .pk-char-motion { animation: ' + k('error') + ' 0.44s linear infinite; }');
    parts.push(
      '#' + uid + ' .pk-aura-pulse { animation: ' + k('aura') + ' 1.9s ease-in-out infinite; transform-origin: 80px 92px; }',
      '#' + uid + ' .pk-float-up-1 { animation: ' + k('rise') + ' 2.2s ease-out infinite; }',
      '#' + uid + ' .pk-float-up-2 { animation: ' + k('rise') + ' 2.2s ease-out infinite 0.72s; }',
      '#' + uid + ' .pk-float-up-3 { animation: ' + k('rise') + ' 2.2s ease-out infinite 1.44s; }',
      '#' + uid + ' .pk-spark-1 { animation: ' + k('spark') + ' 0.75s ease-in-out infinite alternate; transform-box: fill-box; transform-origin: 50% 50%; }',
      '#' + uid + ' .pk-spark-2 { animation: ' + k('spark') + ' 0.75s ease-in-out infinite alternate 0.35s; transform-box: fill-box; transform-origin: 50% 50%; }',
      '#' + uid + ' .pk-gear-spin { animation: ' + k('spin') + ' 3.2s linear infinite; transform-box: fill-box; transform-origin: 50% 50%; }',
      '#' + uid + ' .pk-sweat-drop { animation: ' + k('sweat') + ' 1.15s ease-in infinite; }',
      '#' + uid + ' .pk-dot-1 { animation: ' + k('dot') + ' 1.2s ease-in-out infinite 0s; }',
      '#' + uid + ' .pk-dot-2 { animation: ' + k('dot') + ' 1.2s ease-in-out infinite 0.22s; }',
      '#' + uid + ' .pk-dot-3 { animation: ' + k('dot') + ' 1.2s ease-in-out infinite 0.44s; }',
      '@keyframes ' + k('think') + ' { 0%,100% { transform: translateY(0px) rotate(-3.5deg); } 50% { transform: translateY(-6px) rotate(4deg); } }',
      '@keyframes ' + k('work') + ' { 0% { transform: translateY(1px) scale(1.04, 0.95); } 100% { transform: translateY(-9px) scale(0.97, 1.05); } }',
      '@keyframes ' + k('sleep') + ' { 0%,100% { transform: translateY(7px) rotate(-6deg) scale(1.05, 0.92); } 50% { transform: translateY(5px) rotate(-4deg) scale(0.98, 1.01); } }',
      '@keyframes ' + k('drag') + ' { 0% { transform: translateY(-11px) rotate(-7deg); } 100% { transform: translateY(-14px) rotate(7deg); } }',
      '@keyframes ' + k('celebrate') + ' { 0%,100% { transform: translateY(1px) scale(1.06, 0.92); } 45% { transform: translateY(-17px) scale(0.95, 1.07); } }',
      '@keyframes ' + k('error') + ' { 0%,100% { transform: translateX(0) rotate(0deg); } 25% { transform: translateX(-4px) rotate(-4deg); } 75% { transform: translateX(4px) rotate(4deg); } }',
      '@keyframes ' + k('shadow-float') + ' { 0%,100% { transform: scale(1); opacity: 0.34; transform-origin: 80px 140px; } 50% { transform: scale(0.84); opacity: 0.22; transform-origin: 80px 140px; } }',
      '@keyframes ' + k('shadow-work') + ' { 0% { transform: scale(1.06); opacity: 0.38; transform-origin: 80px 140px; } 100% { transform: scale(0.78); opacity: 0.2; transform-origin: 80px 140px; } }',
      '@keyframes ' + k('shadow-jump') + ' { 0%,100% { transform: scale(1.08); opacity: 0.4; transform-origin: 80px 140px; } 45% { transform: scale(0.66); opacity: 0.16; transform-origin: 80px 140px; } }',
      '@keyframes ' + k('aura') + ' { 0%,100% { transform: scale(0.92); opacity: 0.24; } 50% { transform: scale(1.08); opacity: 0.54; } }',
      '@keyframes ' + k('rise') + ' { 0% { opacity: 0; transform: translateY(6px) scale(0.65); } 25% { opacity: 1; } 100% { opacity: 0; transform: translateY(-24px) scale(1.15); } }',
      '@keyframes ' + k('spark') + ' { 0% { opacity: 0.35; transform: scale(0.75) rotate(-10deg); } 100% { opacity: 1; transform: scale(1.18) rotate(12deg); } }',
      '@keyframes ' + k('spin') + ' { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }',
      '@keyframes ' + k('sweat') + ' { 0% { opacity: 0; transform: translateY(-3px); } 30% { opacity: 1; } 100% { opacity: 0; transform: translateY(14px); } }',
      '@keyframes ' + k('dot') + ' { 0%,100% { opacity: 0.3; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-2px); } }'
    );
    return parts.join('\n');
  }

  function renderCharacterImage(meta, spriteMode, shiny) {
    const info = getSpriteInfo(meta.id, spriteMode, shiny);
    const boxSize = info.pixelated ? 98 : 112;
    const x = Math.round((160 - boxSize) / 2);
    const y = 136 - boxSize;
    const style = 'image-rendering:' + (info.pixelated ? 'pixelated' : 'auto') + ';' + (info.filter ? 'filter:' + info.filter + ';' : '');
    return (
      '<g class="pk-char-body-group pk-char-motion">' +
      '<image class="pk-authentic-svg-img" href="' + esc(info.src) + '" x="' + x + '" y="' + y + '" width="' + boxSize + '" height="' + boxSize +
      '" preserveAspectRatio="xMidYMax meet" style="' + esc(style) + '"/>' +
      '</g>'
    );
  }

  function renderAuraLayer(meta, state) {
    if (state === 'sleeping') return '';
    const color = state === 'error' ? '#F43F5E' : meta.themeColor;
    const legendRing =
      meta.rarity === 'SSR'
        ? '<ellipse class="pk-aura-pulse" cx="80" cy="92" rx="58" ry="20" transform="rotate(16 80 92)" fill="none" stroke="' + esc(meta.accentColor) + '" stroke-width="1.6" opacity="0.5"/>'
        : '';
    return (
      '<g class="pk-aura-group">' +
      '<circle class="pk-aura-pulse" cx="80" cy="92" r="46" fill="' + esc(color) + '" opacity="0.14"/>' +
      '<circle class="pk-aura-pulse" cx="80" cy="92" r="54" fill="none" stroke="' + esc(color) + '" stroke-width="1.5" stroke-dasharray="6 6" opacity="0.38"/>' +
      legendRing +
      '</g>'
    );
  }

  function renderWorkingParticles(meta) {
    return (
      '<path class="pk-spark-1" d="M 27 56 L 29.5 63.5 L 37 66 L 29.5 68.5 L 27 76 L 24.5 68.5 L 17 66 L 24.5 63.5 Z" fill="' + esc(meta.themeColor) + '"/>' +
      '<path class="pk-spark-2" d="M 134 50 L 136 56 L 142 58 L 136 60 L 134 66 L 132 60 L 126 58 L 132 56 Z" fill="' + esc(meta.accentColor) + '"/>' +
      '<text class="pk-float-up-2" x="128" y="92" font-size="13">' + esc(meta.spark) + '</text>'
    );
  }

  function renderStateFxOverlay(meta, state) {
    if (state === 'thinking') {
      return (
        '<g class="pk-fx-overlay-group"><g class="pk-spark-1">' +
        '<circle cx="114" cy="44" r="2.8" fill="#F8FAFC" stroke="#475569" stroke-width="1.2"/>' +
        '<circle cx="121" cy="36" r="4" fill="#F8FAFC" stroke="#475569" stroke-width="1.2"/>' +
        '<path d="M 118 26 C 114 26, 112 22, 115 19 C 116 14, 123 12, 127 15 C 132 12, 139 15, 139 20 C 143 21, 143 27, 138 28 L 120 28 Z" fill="#FFFFFF" stroke="#475569" stroke-width="1.5" stroke-linejoin="round"/>' +
        '<circle class="pk-dot-1" cx="122" cy="22" r="1.8" fill="#6366F1"/>' +
        '<circle class="pk-dot-2" cx="128" cy="22" r="1.8" fill="#6366F1"/>' +
        '<circle class="pk-dot-3" cx="134" cy="22" r="1.8" fill="#6366F1"/>' +
        '</g><text class="pk-float-up-2" x="30" y="42" font-size="17" font-weight="800" fill="#FDE047" stroke="#1E293B" stroke-width="0.8">?</text></g>'
      );
    }
    if (state === 'working') {
      return (
        '<g class="pk-fx-overlay-group">' +
        renderWorkingParticles(meta) +
        '<g transform="translate(116, 16)"><rect x="0" y="0" width="28" height="20" rx="6" fill="#0F172A" fill-opacity="0.9" stroke="#38BDF8" stroke-width="1.5"/>' +
        '<text x="14" y="13.5" text-anchor="middle" font-size="10" font-weight="800" fill="#38BDF8">&lt;/&gt;</text></g>' +
        '<g transform="translate(24, 24)"><circle class="pk-gear-spin" cx="0" cy="0" r="7" fill="none" stroke="#FACC15" stroke-width="2.4" stroke-dasharray="3.2 2.4"/></g>' +
        '</g>'
      );
    }
    if (state === 'sleeping') {
      return (
        '<g class="pk-fx-overlay-group">' +
        '<text class="pk-float-up-1" x="108" y="54" font-size="12" font-weight="800" fill="#93C5FD">z</text>' +
        '<text class="pk-float-up-2" x="118" y="42" font-size="15" font-weight="800" fill="#BAE6FD">Z</text>' +
        '<text class="pk-float-up-3" x="129" y="29" font-size="18" font-weight="900" fill="#E0F2FE">Z</text>' +
        '</g>'
      );
    }
    if (state === 'dragging') {
      return (
        '<g class="pk-fx-overlay-group"><g class="pk-spark-1">' +
        '<rect x="72" y="6" width="16" height="22" rx="8" fill="#FEF08A" stroke="#EA580C" stroke-width="2"/>' +
        '<text x="80" y="22" text-anchor="middle" font-size="16" font-weight="900" fill="#DC2626">!</text></g>' +
        '<path d="M 56 130 Q 52 138 56 145" fill="none" stroke="#94A3B8" stroke-width="1.8" stroke-linecap="round" opacity="0.65"/>' +
        '<path d="M 104 130 Q 108 138 104 145" fill="none" stroke="#94A3B8" stroke-width="1.8" stroke-linecap="round" opacity="0.65"/>' +
        '</g>'
      );
    }
    if (state === 'celebrating') {
      return (
        '<g class="pk-fx-overlay-group">' +
        '<path class="pk-float-up-1" d="M 32 48 C 32 44, 26 44, 26 48 C 26 52, 32 55, 32 58 C 32 55, 38 52, 38 48 C 38 44, 32 44, 32 48 Z" fill="#FB7185"/>' +
        '<path class="pk-float-up-2" d="M 126 42 C 126 38, 120 38, 120 42 C 120 46, 126 49, 126 52 C 126 49, 132 46, 132 42 C 132 38, 126 38, 126 42 Z" fill="#F43F5E"/>' +
        '<path class="pk-spark-1" d="M 118 20 L 120 26 L 126 28 L 120 30 L 118 36 L 116 30 L 110 28 L 116 26 Z" fill="#FDE047"/>' +
        '<path class="pk-spark-2" d="M 42 22 L 44 27 L 49 29 L 44 31 L 42 36 L 40 31 L 35 29 L 40 27 Z" fill="#FDE047"/>' +
        '</g>'
      );
    }
    if (state === 'error') {
      return (
        '<g class="pk-fx-overlay-group">' +
        '<path class="pk-sweat-drop" d="M 118 52 C 114 60, 113 65, 118 68 C 123 65, 122 60, 118 52 Z" fill="#38BDF8" stroke="#0284C7" stroke-width="1.4"/>' +
        '<path d="M 56 26 C 52 26, 50 22, 54 19 C 56 14, 64 13, 68 16 C 73 13, 81 14, 83 19 C 87 21, 86 26, 81 26 Z" fill="#334155" stroke="#F43F5E" stroke-width="1.4"/>' +
        '<path d="M 68 26 L 65 32 L 70 32 L 67 38" fill="none" stroke="#FACC15" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
        '</g>'
      );
    }
    return '';
  }

  function getSvgMarkup(speciesInput, stateInput, options) {
    const opts = options || {};
    const meta = metaOf(normalizeSpecies(speciesInput));
    const state = normalizeState(stateInput);
    const uid = opts.uid || 'pksvg-' + ++uidCounter;
    const body = opts.overlayOnly ? '' : renderCharacterImage(meta, opts.spriteMode, opts.shiny);
    const size = opts.size ? Number(opts.size) : 160;
    return (
      '<svg id="' + esc(uid) + '" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 160" width="' + size + '" height="' + size + '"' +
      ' role="img" aria-label="' + esc(meta.cnName + ' - ' + state) + '">' +
      '<style>' + buildEmbeddedSvgCss(uid, state) + '</style>' +
      '<ellipse class="pk-ground-shadow" cx="80" cy="140" rx="34" ry="7.5" fill="#020617" opacity="0.32"/>' +
      renderAuraLayer(meta, state) +
      body +
      renderStateFxOverlay(meta, state) +
      '</svg>'
    );
  }

  function getSvgDataUri(speciesInput, stateInput, options) {
    const opts = options || {};
    const svg = getSvgMarkup(speciesInput, stateInput, Object.assign({}, opts, { uid: opts.uid || 'pkuri-' + ++uidCounter }));
    if (opts.base64 && typeof btoa === 'function') return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
  }

  /** Replace a container's children with parsed SVG markup (no innerHTML). */
  function setSvgContent(layerEl, markup) {
    while (layerEl.firstChild) layerEl.removeChild(layerEl.firstChild);
    if (!markup || typeof DOMParser === 'undefined') return;
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const svg = parsed.documentElement;
    if (svg && svg.nodeName.toLowerCase() === 'svg') layerEl.appendChild(layerEl.ownerDocument.importNode(svg, true));
  }

  function injectStyles(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.head || d.getElementById('pk-pets-fallback-styles')) return;
    const links = d.querySelectorAll('link[rel="stylesheet"]');
    for (let i = 0; i < links.length; i++) {
      const href = links[i].getAttribute('href') || '';
      if (href.indexOf('pet-sprites.css') !== -1 || href.indexOf('pokemon-sprites.css') !== -1) return;
    }
    const style = d.createElement('style');
    style.id = 'pk-pets-fallback-styles';
    style.textContent = [
      '.pk-pet-root{position:relative;display:inline-flex;flex-direction:column;align-items:center;justify-content:center;user-select:none;cursor:pointer;font-family:"Segoe UI","Microsoft YaHei",sans-serif;}',
      '.pk-pet-stage{position:relative;width:var(--pk-pet-size,128px);height:var(--pk-pet-size,128px);display:flex;align-items:center;justify-content:center;}',
      '.pk-pet-svg-layer{width:100%;height:100%;}.pk-pet-svg-layer svg{width:100%;height:100%;overflow:visible;display:block;}',
      '.pk-pet-gif-layer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;}',
      '.pk-pet-gif-img{width:74%;height:74%;object-fit:contain;transform-origin:50% 85%;filter:drop-shadow(0 5px 10px rgba(0,0,0,.42));}',
      '.pk-pet-root[data-sprite-mode="authentic-pixel"] .pk-pet-gif-img{width:68%;height:68%;image-rendering:pixelated;}',
      '.pk-pet-root[data-state="thinking"] .pk-pet-gif-img{animation:pk-fb-think 2.2s ease-in-out infinite;}',
      '.pk-pet-root[data-state="working"] .pk-pet-gif-img{animation:pk-fb-work .48s ease-in-out infinite alternate;}',
      '.pk-pet-root[data-state="sleeping"] .pk-pet-gif-img{animation:pk-fb-sleep 3.2s ease-in-out infinite;}',
      '.pk-pet-root[data-state="dragging"] .pk-pet-gif-img{animation:pk-fb-drag .36s ease-in-out infinite alternate;}',
      '.pk-pet-root[data-state="celebrating"] .pk-pet-gif-img{animation:pk-fb-cel .68s ease-in-out infinite;}',
      '.pk-pet-root[data-state="error"] .pk-pet-gif-img{animation:pk-fb-err .42s linear infinite;}',
      '.pk-pet-status-bubble{max-width:185px;padding:3px 9px;margin-bottom:2px;border-radius:10px;background:rgba(15,23,42,.86);color:#f8fafc;font-size:11px;border:1px solid rgba(255,255,255,.18);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.pk-pet-status-bubble:empty,.pk-pet-status-bubble[data-hidden="true"],.pk-pet-hud[data-hidden="true"]{display:none;}',
      '.pk-pet-hud{display:flex;flex-direction:column;align-items:center;gap:2px;margin-top:-3px;pointer-events:none;}',
      '.pk-pet-badges-row{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:999px;background:rgba(15,23,42,.85);color:#f8fafc;font-size:11px;font-weight:700;border:1px solid rgba(255,255,255,.14);}',
      '.pk-pet-dot{width:7px;height:7px;border-radius:50%;background:var(--pk-theme-color,#ffd43b);}',
      '.pk-pet-state-pill{font-size:10px;font-weight:700;padding:1px 7px;border-radius:999px;background:rgba(30,41,59,.9);color:#e2e8f0;}',
      '.pk-pet-burst-layer{position:absolute;inset:0;pointer-events:none;overflow:visible;}',
      '.pk-pet-burst-item{position:absolute;left:50%;top:44%;font-size:15px;pointer-events:none;animation:pk-fb-burst .85s ease-out forwards;}',
      '@keyframes pk-fb-think{0%,100%{transform:translateY(0) rotate(-4deg);}50%{transform:translateY(-5px) rotate(5deg);}}',
      '@keyframes pk-fb-work{0%{transform:translateY(0) scale(1.03,.96);}100%{transform:translateY(-9px) scale(.97,1.05);}}',
      '@keyframes pk-fb-sleep{0%,100%{transform:translateY(7px) rotate(-6deg) scale(1.05,.92);}50%{transform:translateY(5px) rotate(-4deg) scale(.97,1.01);}}',
      '@keyframes pk-fb-drag{0%{transform:translateY(-10px) rotate(-7deg);}100%{transform:translateY(-12px) rotate(7deg);}}',
      '@keyframes pk-fb-cel{0%,100%{transform:translateY(0) scale(1.06,.92);}45%{transform:translateY(-16px) scale(.95,1.08);}}',
      '@keyframes pk-fb-err{0%,100%{transform:translateX(0);}25%{transform:translateX(-4px) rotate(-5deg);}75%{transform:translateX(4px) rotate(5deg);}}',
      '@keyframes pk-fb-burst{0%{opacity:1;transform:translate(-50%,-50%) scale(.5);}100%{opacity:0;transform:translate(calc(-50% + var(--tx,0px)),calc(-50% + var(--ty,-44px))) scale(1.25);}}'
    ].join('\n');
    d.head.appendChild(style);
  }

  // ---------------------------------------------------------------- mountPet
  function mountPet(containerEl, options) {
    if (!containerEl) throw new Error('PetSprites.mountPet requires a valid containerEl');
    const opts = options || {};
    const doc = containerEl.ownerDocument || document;
    injectStyles(doc);

    let currentSpecies = opts.species ? normalizeSpecies(opts.species) : resolveSpeciesForAgent(opts.agentName || opts.role || '');
    let baseState = normalizeState(opts.state || 'thinking');
    let isDragging = false;
    let pokeTimer = null;
    let spriteMode = normalizeSpriteMode(opts.spriteMode);
    let shiny = Boolean(opts.shiny);
    let agentName = opts.agentName != null ? String(opts.agentName) : '';
    let statusText = opts.statusText != null ? String(opts.statusText) : '';
    const showHud = opts.showHud !== false;
    const interactive = opts.interactive !== false;
    const sizePx = Number(opts.size) || 132;

    const el = (tag, cls) => {
      const n = doc.createElement(tag);
      if (cls) n.className = cls;
      return n;
    };
    const rootEl = el('div', 'pk-pet-root is-gif-ready');
    rootEl.style.setProperty('--pk-pet-size', sizePx + 'px');
    if (opts.draggable) rootEl.setAttribute('data-draggable', 'true');
    const bubbleEl = el('div', 'pk-pet-status-bubble');
    const stageEl = el('div', 'pk-pet-stage');
    const svgLayerEl = el('div', 'pk-pet-svg-layer');
    const gifLayerEl = el('div', 'pk-pet-gif-layer');
    const gifImgEl = el('img', 'pk-pet-gif-img');
    gifImgEl.alt = '';
    gifImgEl.decoding = 'async';
    gifLayerEl.appendChild(gifImgEl);
    const burstLayerEl = el('div', 'pk-pet-burst-layer');
    stageEl.append(svgLayerEl, gifLayerEl, burstLayerEl);
    const hudEl = el('div', 'pk-pet-hud');
    if (!showHud) hudEl.setAttribute('data-hidden', 'true');
    const badgeRowEl = el('div', 'pk-pet-badges-row');
    const dotEl = el('span', 'pk-pet-dot');
    const nameEl = el('span', 'pk-pet-name');
    badgeRowEl.append(dotEl, nameEl);
    const pillEl = el('div', 'pk-pet-state-pill');
    hudEl.append(badgeRowEl, pillEl);
    rootEl.append(bubbleEl, stageEl, hudEl);
    while (containerEl.firstChild) containerEl.removeChild(containerEl.firstChild);
    containerEl.appendChild(rootEl);

    let lastSpriteKey = '';
    let lastSvgKey = '';

    function getEffectiveState() {
      if (isDragging) return 'dragging';
      if (pokeTimer) return 'celebrating';
      return baseState;
    }

    function syncSprite() {
      const info = getSpriteInfo(currentSpecies, spriteMode, shiny);
      rootEl.setAttribute('data-sprite-mode', info.pixelated ? 'authentic-pixel' : 'authentic-showdown');
      rootEl.toggleAttribute('data-shiny', shiny);
      const key = info.src + '|' + info.filter;
      if (key !== lastSpriteKey) {
        lastSpriteKey = key;
        gifImgEl.src = info.src;
        gifImgEl.style.filter = info.filter ? info.filter + ' drop-shadow(0 5px 10px rgba(0,0,0,.42))' : '';
        const sc = SPECIES[currentSpecies] && SPECIES[currentSpecies].creature ? Number(SPECIES[currentSpecies].creature.scale) : 1;
        gifImgEl.style.scale = sc > 0 && sc !== 1 ? String(Math.max(0.6, Math.min(1.3, sc))) : '';
      }
    }

    function render() {
      if (pack && currentSpecies && !SPECIES[currentSpecies]) currentSpecies = normalizeSpecies(currentSpecies);
      const effectiveState = getEffectiveState();
      const meta = metaOf(currentSpecies);
      const stMeta = STATES[effectiveState] || STATES.sleeping;
      rootEl.setAttribute('data-species', currentSpecies);
      rootEl.setAttribute('data-state', effectiveState);
      rootEl.style.setProperty('--pk-theme-color', meta.themeColor);
      rootEl.style.setProperty('--pk-accent-color', meta.accentColor);
      rootEl.style.setProperty('--pk-glow-color', meta.glowColor);
      rootEl.classList.toggle('is-dragging', isDragging);
      const svgKey = currentSpecies + '|' + effectiveState + '|' + meta.themeColor;
      if (svgKey !== lastSvgKey) {
        lastSvgKey = svgKey;
        setSvgContent(svgLayerEl, getSvgMarkup(currentSpecies, effectiveState, { overlayOnly: true }));
      }
      syncSprite();
      nameEl.textContent = agentName || meta.cnName;
      pillEl.textContent = stMeta.pillText;
      bubbleEl.textContent = statusText;
      bubbleEl.setAttribute('data-hidden', statusText ? 'false' : 'true');
      if (typeof opts.onStateChange === 'function') {
        opts.onStateChange({ species: currentSpecies, state: effectiveState, spriteMode, shiny, statusText });
      }
    }

    function spawnBurstParticles(symbols) {
      const list = symbols || ['❤️', '✨', '💛', '⭐', '💖'];
      for (let i = 0; i < 6; i++) {
        const span = el('span', 'pk-pet-burst-item');
        span.textContent = list[i % list.length];
        const angle = (Math.PI * 2 * i) / 6 + (Math.random() * 0.4 - 0.2);
        const dist = 36 + Math.random() * 24;
        span.style.setProperty('--tx', Math.round(Math.cos(angle) * dist) + 'px');
        span.style.setProperty('--ty', Math.round(Math.sin(angle) * dist - 18) + 'px');
        burstLayerEl.appendChild(span);
        setTimeout(() => span.remove(), 920);
      }
    }

    function triggerPoke() {
      spawnBurstParticles(['❤️', '✨', metaOf(currentSpecies).spark, '⭐', '🎵', '✨']);
      if (pokeTimer) clearTimeout(pokeTimer);
      pokeTimer = setTimeout(() => {
        pokeTimer = null;
        render();
      }, 1500);
      render();
      if (typeof opts.onPoke === 'function') opts.onPoke({ species: currentSpecies, state: getEffectiveState(), spriteMode, agentName });
    }

    function onStageClick(ev) {
      if (!interactive || rootEl.getAttribute('data-just-dragged') === 'true') return;
      ev.stopPropagation();
      triggerPoke();
    }
    stageEl.addEventListener('click', onStageClick);

    let dragStart = null;
    function onPointerDown(ev) {
      if (!opts.draggable || ev.button !== 0) return;
      const cs = (doc.defaultView || window).getComputedStyle(containerEl);
      const rect = containerEl.getBoundingClientRect();
      const parentRect = (containerEl.offsetParent || doc.body).getBoundingClientRect();
      if (cs.position === 'static') {
        containerEl.style.position = 'absolute';
        containerEl.style.left = rect.left - parentRect.left + 'px';
        containerEl.style.top = rect.top - parentRect.top + 'px';
      }
      dragStart = {
        pointerId: ev.pointerId,
        startX: ev.clientX,
        startY: ev.clientY,
        origLeft: parseFloat(containerEl.style.left) || 0,
        origTop: parseFloat(containerEl.style.top) || 0,
        moved: false
      };
      try {
        rootEl.setPointerCapture(ev.pointerId);
      } catch (_) {}
    }
    function onPointerMove(ev) {
      if (!dragStart || ev.pointerId !== dragStart.pointerId) return;
      const dx = ev.clientX - dragStart.startX;
      const dy = ev.clientY - dragStart.startY;
      if (!dragStart.moved && Math.hypot(dx, dy) > 4) {
        dragStart.moved = true;
        isDragging = true;
        render();
      }
      if (dragStart.moved) {
        containerEl.style.left = dragStart.origLeft + dx + 'px';
        containerEl.style.top = dragStart.origTop + dy + 'px';
      }
    }
    function onPointerUp(ev) {
      if (!dragStart || ev.pointerId !== dragStart.pointerId) return;
      const wasMoved = dragStart.moved;
      dragStart = null;
      if (wasMoved) {
        isDragging = false;
        rootEl.setAttribute('data-just-dragged', 'true');
        setTimeout(() => rootEl.removeAttribute('data-just-dragged'), 120);
        render();
      }
    }
    if (opts.draggable) {
      rootEl.addEventListener('pointerdown', onPointerDown);
      rootEl.addEventListener('pointermove', onPointerMove);
      rootEl.addEventListener('pointerup', onPointerUp);
      rootEl.addEventListener('pointercancel', onPointerUp);
    }

    const onPack = () => {
      lastSpriteKey = '';
      lastSvgKey = '';
      render();
    };
    liveRenders.add(onPack);
    render();

    return {
      el: rootEl,
      getState: () => getEffectiveState(),
      getSpecies: () => currentSpecies,
      getSpriteMode: () => spriteMode,
      isShiny: () => shiny,
      setState(nextState, nextStatusText) {
        if (nextState != null) baseState = normalizeState(nextState);
        if (nextStatusText !== undefined) statusText = nextStatusText != null ? String(nextStatusText) : '';
        render();
      },
      setSpecies(nextSpecies) {
        currentSpecies = normalizeSpecies(nextSpecies);
        render();
      },
      setSpriteMode(nextMode) {
        spriteMode = normalizeSpriteMode(nextMode);
        render();
      },
      setShiny(flag) {
        if (shiny !== Boolean(flag)) {
          shiny = Boolean(flag);
          render();
        }
      },
      setAgentInfo(info) {
        if (!info) return;
        if (info.agentName !== undefined) agentName = String(info.agentName);
        if (info.statusText !== undefined) statusText = info.statusText != null ? String(info.statusText) : '';
        if (info.shiny !== undefined) shiny = Boolean(info.shiny);
        render();
      },
      setUseOnlineGif(flag) {
        spriteMode = flag ? 'authentic-pixel' : 'authentic-showdown';
        render();
      },
      setDragging(flag) {
        const next = Boolean(flag);
        if (isDragging !== next) {
          isDragging = next;
          render();
        }
      },
      triggerPoke,
      destroy() {
        liveRenders.delete(onPack);
        if (pokeTimer) clearTimeout(pokeTimer);
        stageEl.removeEventListener('click', onStageClick);
        if (opts.draggable) {
          rootEl.removeEventListener('pointerdown', onPointerDown);
          rootEl.removeEventListener('pointermove', onPointerMove);
          rootEl.removeEventListener('pointerup', onPointerUp);
          rootEl.removeEventListener('pointercancel', onPointerUp);
        }
        rootEl.remove();
      }
    };
  }

  return {
    SPRITE_MODES,
    SPECIES,
    SPECIES_LIST,
    STATES,
    CORE_STATES: CORE_STATE_IDS,
    setPack,
    getPack: () => pack,
    onPackChange,
    styleInfo,
    getSpriteInfo,
    normalizeSpecies,
    normalizeState,
    normalizeSpriteMode,
    getAuthenticGifDataUri,
    resolveSpeciesForAgent,
    getSvgMarkup,
    getSvgDataUri,
    injectStyles,
    mountPet
  };
});
