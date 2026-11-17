/**
 * HTTP guard for the local bridge (127.0.0.1 only).
 *
 * Threat model: any web page open in the user's browser can fire requests at http://127.0.0.1:17580.
 * Before this guard the bridge answered every origin with `Access-Control-Allow-Origin: *`, so a random
 * site could read conversation titles / project paths and trigger writes (reset Pokédex, switch windows).
 *
 * Browser-unforgeable signals are used instead of a token, because the skin injected into the IDE renderer
 * cannot read a token file:
 *   1. Host header must be a loopback name with our port          -> blocks DNS-rebinding pages.
 *   2. API requests that carry an Origin must be allow-listed      -> blocks cross-site fetch/XHR/form/EventSource.
 *   3. API requests without Origin but with Sec-Fetch-Site of
 *      `cross-site` / `same-site` are rejected                     -> blocks <img>/<script> GET tricks.
 *   4. Native clients (extension host, PowerShell overlay, hooks) send neither header -> allowed.
 * Allowed origins: the bridge's own pages, the IDE (`vscode-file:`, `vscode-webview:`, Electron `app:`),
 * this suite's Antigravity-app sidecar panel (`plugin://pokemon-agent-pets--*`),
 * plus anything passed via `--allow-origin a,b` / POKEMON_ALLOW_ORIGINS.
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const IDE_SCHEMES = new Set(['vscode-file:', 'vscode-webview:', 'app:']);
// Antigravity app sidecar panels load from `plugin://<plugin>--<sidecar>-<port>`; the app assigns that
// authority itself, so only this suite's own plugin is trusted (other plugins stay blocked).
const PLUGIN_ORIGIN_RE = /^plugin:\/\/pokemon-agent-pets--[a-z0-9-]+$/;
const PUBLIC_PREFIXES = ['/static/', '/stage', '/packs/'];

export function createHttpGuard({ port, extraOrigins = [] } = {}) {
  const selfOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]);
  const extra = new Set(extraOrigins.map((o) => String(o).trim().replace(/\/+$/, '')).filter(Boolean));
  const denied = []; // recent denials, for /health diagnostics
  const seenAllowedOrigins = new Set();
  // Antigravity app Hub page (`https://127.0.0.1:<language-server port>`, port changes every launch).
  // Registered only by native callers (the app's main process hook) via registerHubOrigin().
  const hubOrigins = new Set();

  /** Trust the exact loopback HTTPS origin of an Antigravity app Hub window. Caller must be a native client. */
  function registerHubOrigin(origin) {
    const o = String(origin || '').trim().replace(/\/+$/, '');
    if (!/^https:\/\/127\.0\.0\.1:\d{2,5}$/.test(o) || Number(o.split(':')[2]) === Number(port)) return false;
    if (!hubOrigins.has(o)) {
      hubOrigins.add(o);
      if (hubOrigins.size > 6) hubOrigins.delete(hubOrigins.values().next().value);
    }
    return true;
  }

  function isAllowedOrigin(origin) {
    if (!origin || origin === 'null') return false;
    const o = String(origin).replace(/\/+$/, '');
    if (selfOrigins.has(o) || extra.has(o) || hubOrigins.has(o)) return true;
    if (PLUGIN_ORIGIN_RE.test(o)) return true;
    try {
      return IDE_SCHEMES.has(new URL(o).protocol);
    } catch {
      return false;
    }
  }

  function hostOk(hostHeader) {
    const h = String(hostHeader || '').trim().toLowerCase();
    if (!h) return true; // HTTP/1.0 native clients
    const m = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(h);
    if (!m) return false;
    return LOOPBACK_HOSTS.has(m[1]) && (!m[2] || Number(m[2]) === Number(port));
  }

  function deny(req, pathname, reason) {
    denied.push({
      at: new Date().toISOString(),
      method: req.method,
      path: pathname,
      origin: req.headers.origin || null,
      secFetchSite: req.headers['sec-fetch-site'] || null,
      reason
    });
    if (denied.length > 20) denied.shift();
    return { ok: false, status: 403, reason, corsOrigin: null };
  }

  /** Returns { ok, status, reason, corsOrigin } — corsOrigin is echoed in CORS headers when allowed. */
  function check(req, pathname) {
    if (!hostOk(req.headers.host)) return deny(req, pathname, 'host-not-loopback');
    const origin = req.headers.origin;
    const originAllowed = isAllowedOrigin(origin);
    if (originAllowed) {
      if (seenAllowedOrigins.size < 20) seenAllowedOrigins.add(String(origin));
    }
    const corsOrigin = originAllowed ? String(origin) : null;

    // Public static files (sprites, the stage page): readable by anyone on this machine, no secrets.
    if (req.method === 'GET' && (pathname === '/' || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p)))) {
      return { ok: true, status: 200, reason: 'public', corsOrigin };
    }
    if (origin) {
      return originAllowed ? { ok: true, status: 200, reason: 'origin-allowed', corsOrigin } : deny(req, pathname, 'origin-not-allowed');
    }
    const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (sfs && sfs !== 'same-origin' && sfs !== 'none') return deny(req, pathname, `sec-fetch-site:${sfs}`);
    return { ok: true, status: 200, reason: 'native-client', corsOrigin: null };
  }

  function publicState() {
    return {
      cors: 'allow-list',
      allowedOrigins: [...selfOrigins, ...extra, ...hubOrigins, 'vscode-file://*', 'vscode-webview://*', 'app://*', 'plugin://pokemon-agent-pets--*'],
      seenAllowedOrigins: [...seenAllowedOrigins],
      recentDenied: denied.slice(-10)
    };
  }

  return { check, isAllowedOrigin, registerHubOrigin, publicState };
}

/** Static files the bridge may serve (relative to the suite root). Everything else (source, configs) stays private. */
export const STATIC_ALLOWED_DIRS = ['desktop-pet', 'assets'];
