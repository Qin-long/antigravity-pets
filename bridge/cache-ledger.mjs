/**
 * Prompt-cache ledger: real, cumulative KV-cache statistics per conversation.
 *
 * Antigravity writes exact usage on every model step in `transcript.jsonl`:
 *   input_tokens       = prompt tokens billed fresh (cache miss part)
 *   cache_read_tokens  = prompt tokens served from the prompt cache
 *   output_tokens      = generated tokens
 *
 * The old ring showed only the *last* request's ratio, which sits at ~98% forever (and never shows
 * the 0% cold starts after the cache TTL lapses). This ledger reads the transcript once, then only
 * the appended bytes on later polls, and accumulates totals across every request.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';

const CHUNK = 4 * 1024 * 1024;
const COLD_MISS_MIN_PROMPT = 4096; // a "cold start" = whole prompt re-billed (cache_read 0) on a non-trivial prompt
const RECENT_WINDOW = 5;
const MAX_LEDGERS = 300;

const ledgers = new Map();

function freshLedger() {
  return {
    offset: 0,
    pending: '',
    requests: 0,
    sumCached: 0,
    sumUncached: 0,
    sumOutput: 0,
    coldMisses: 0,
    recent: [],
    last: null
  };
}

function ingestLine(L, line) {
  if (!line || line.indexOf('_tokens"') === -1) return;
  let step;
  try {
    step = JSON.parse(line);
  } catch {
    return;
  }
  const hasIn = Number.isFinite(Number(step?.input_tokens));
  const hasCache = Number.isFinite(Number(step?.cache_read_tokens));
  if (!hasIn && !hasCache) return;
  const uncached = Math.max(0, Math.round(Number(step.input_tokens) || 0));
  const cached = Math.max(0, Math.round(Number(step.cache_read_tokens) || 0));
  const output = Math.max(0, Math.round(Number(step.output_tokens) || 0));
  const prompt = uncached + cached;
  if (prompt <= 0) return;
  const atMs = step.created_at ? Date.parse(step.created_at) : NaN;

  if (L.requests > 0 && cached === 0 && prompt >= COLD_MISS_MIN_PROMPT) L.coldMisses += 1;
  L.requests += 1;
  L.sumCached += cached;
  L.sumUncached += uncached;
  L.sumOutput += output;
  L.recent.push({ cached, prompt });
  if (L.recent.length > RECENT_WINDOW) L.recent.shift();
  L.last = { cached, uncached, output, prompt, atMs: Number.isFinite(atMs) ? atMs : null };
}

function pct(num, den) {
  return den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
}

/**
 * Returns cumulative cache stats for a transcript, or null if the file is missing.
 * `requests === 0` means no model call has finished yet (no usage data — callers must not invent a ratio).
 */
export function readCacheLedger(transcriptPath) {
  let st;
  try {
    st = statSync(transcriptPath);
  } catch {
    return null;
  }

  let L = ledgers.get(transcriptPath);
  if (!L || st.size < L.offset) {
    L = freshLedger(); // new file or truncated/rewritten: start over
    if (ledgers.size >= MAX_LEDGERS) ledgers.delete(ledgers.keys().next().value);
    ledgers.set(transcriptPath, L);
  }

  if (st.size > L.offset) {
    let fd = null;
    try {
      fd = openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(Math.min(CHUNK, st.size - L.offset));
      while (L.offset < st.size) {
        const want = Math.min(buf.length, st.size - L.offset);
        const n = readSync(fd, buf, 0, want, L.offset);
        if (n <= 0) break;
        L.offset += n;
        const text = L.pending + buf.toString('utf8', 0, n);
        const lines = text.split('\n');
        L.pending = lines.pop() || ''; // keep a partial trailing line until it is complete
        for (const line of lines) ingestLine(L, line.trim());
      }
    } catch {
      // ignore transient read errors; next poll retries from the saved offset
    } finally {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      }
    }
  }

  const prompt = L.sumCached + L.sumUncached;
  const rCached = L.recent.reduce((s, r) => s + r.cached, 0);
  const rPrompt = L.recent.reduce((s, r) => s + r.prompt, 0);
  return {
    requests: L.requests,
    sumCachedTokens: L.sumCached,
    sumUncachedTokens: L.sumUncached,
    sumPromptTokens: prompt,
    sumOutputTokens: L.sumOutput,
    cumulativeHitPct: pct(L.sumCached, prompt),
    recentHitPct: pct(rCached, rPrompt),
    lastHitPct: L.last ? pct(L.last.cached, L.last.prompt) : 0,
    coldMisses: L.coldMisses,
    lastRequestAtMs: L.last?.atMs ?? null
  };
}
