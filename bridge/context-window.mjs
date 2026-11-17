/**
 * Real context-window detection for Antigravity conversations.
 *
 * Antigravity's model picker defaults to a 256K context window ("256K" = server default) and offers
 * opt-in 512K / 900K tiers (`jetskiAgent/main.js`: `unn="256K"`, `{"512K":512e3,"900K":9e5}`).
 * The effective limit for each trajectory is persisted in `~/.gemini/antigravity/conversations/<cascadeId>.db`
 * → table `gen_metadata` → protobuf field path `1.9.10.4` (varint, e.g. `256000`).
 *
 * We read the newest `gen_metadata` row (read-only, cached by db mtime) and return that value.
 */
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const ANTIGRAVITY_DEFAULT_CONTEXT_TOKENS = 256_000;
export const ANTIGRAVITY_CONTEXT_TIERS = [256_000, 512_000, 900_000];

const CONVERSATIONS_DIRS = [
  join(homedir(), '.gemini', 'antigravity', 'conversations'),
  join(homedir(), '.gemini', 'antigravity-ide', 'conversations')
];
const CONTEXT_FIELD_PATH = [1, 9, 10, 4];
const CACHE_TTL_MS = 15_000;

const cache = new Map(); // cascadeId -> { checkedAtMs, mtimeKey, maxTokens }

let DatabaseSyncClass = null;
try {
  const sqliteMod = await import('node:sqlite');
  DatabaseSyncClass = sqliteMod?.DatabaseSync || null;
} catch {
  DatabaseSyncClass = null;
}

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  let byte;
  do {
    if (pos.i >= buf.length) throw new Error('eof');
    byte = buf[pos.i++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80 && shift < 64);
  return result;
}

/** Walk a protobuf message following `path` (field numbers); returns the varint at the leaf or null. */
export function readProtoVarintAtPath(buf, path) {
  let cur = buf;
  for (let depth = 0; depth < path.length; depth++) {
    const want = path[depth];
    const isLeaf = depth === path.length - 1;
    const pos = { i: 0 };
    let next = null;
    try {
      while (pos.i < cur.length) {
        const key = readVarint(cur, pos);
        const field = Math.floor(key / 8);
        const wt = key & 7;
        if (field === 0) return null;
        if (wt === 0) {
          const v = readVarint(cur, pos);
          if (isLeaf && field === want) return v;
        } else if (wt === 1) {
          pos.i += 8;
        } else if (wt === 5) {
          pos.i += 4;
        } else if (wt === 2) {
          const len = readVarint(cur, pos);
          const sub = cur.subarray(pos.i, pos.i + len);
          pos.i += len;
          if (!isLeaf && field === want) next = sub; // last occurrence wins (proto merge semantics)
        } else {
          return null;
        }
      }
    } catch {
      return null;
    }
    if (isLeaf || !next) return null;
    cur = next;
  }
  return null;
}

function locateConversationDb(cascadeId) {
  for (const dir of CONVERSATIONS_DIRS) {
    const p = join(dir, `${cascadeId}.db`);
    if (existsSync(p)) return p;
  }
  return null;
}

function mtimeKeyOf(dbPath) {
  let key = '';
  for (const suffix of ['', '-wal']) {
    try {
      const st = statSync(dbPath + suffix);
      key += `${st.size}:${st.mtimeMs};`;
    } catch {
      // ignore
    }
  }
  return key;
}

/**
 * Return the real context window (tokens) configured for a cascade/trajectory, or `null` when unknown.
 */
export function readConversationContextWindow(cascadeId, nowMs = Date.now()) {
  const id = String(cascadeId || '').trim();
  if (!id || !/^[0-9a-f-]{16,64}$/i.test(id) || !DatabaseSyncClass) return null;

  const cached = cache.get(id);
  if (cached && nowMs - cached.checkedAtMs < CACHE_TTL_MS) return cached.maxTokens;

  const dbPath = locateConversationDb(id);
  if (!dbPath) {
    cache.set(id, { checkedAtMs: nowMs, mtimeKey: '', maxTokens: null });
    return null;
  }
  const mtimeKey = mtimeKeyOf(dbPath);
  if (cached && cached.mtimeKey === mtimeKey) {
    cached.checkedAtMs = nowMs;
    return cached.maxTokens;
  }

  let maxTokens = null;
  let db = null;
  try {
    db = new DatabaseSyncClass(dbPath, { open: true, readOnly: true });
    const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx DESC LIMIT 3').all();
    for (const row of rows) {
      if (!row?.data) continue;
      const v = readProtoVarintAtPath(Buffer.from(row.data), CONTEXT_FIELD_PATH);
      if (Number.isFinite(v) && v >= 32_000 && v <= 4_000_000) {
        maxTokens = v;
        break;
      }
    }
  } catch {
    maxTokens = null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore
    }
  }

  cache.set(id, { checkedAtMs: nowMs, mtimeKey, maxTokens });
  return maxTokens;
}

/** Extract `<cascadeId>` from `.../brain/<cascadeId>/.system_generated/logs/transcript.jsonl`. */
export function cascadeIdFromTranscriptPath(transcriptPath = '') {
  const m = String(transcriptPath).replace(/\\/g, '/').match(/\/brain\/([0-9a-f-]{16,64})\//i);
  return m ? m[1] : '';
}
