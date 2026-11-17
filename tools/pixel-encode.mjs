/**
 * Tiny zero-dependency image encoders for indexed pixel art (used by the pack generators in tools/).
 *   encodePng(width, height, indices, paletteRgb)            -> Buffer (RGBA PNG, index 0 = transparent)
 *   encodeGif(width, height, frames[], paletteRgb, delaysMs) -> Buffer (looping GIF89a, index 0 = transparent)
 *   upscale(indices, width, height, factor)                  -> Uint8Array (nearest neighbour)
 * `paletteRgb` is an array of [r, g, b]; `indices` is a Uint8Array of palette indices, row-major.
 */
import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

export function encodePng(width, height, indices, paletteRgb) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const idx = indices[y * width + x];
      const o = row + 1 + x * 4;
      if (idx === 0) continue; // transparent (already zero)
      const [r, g, b] = paletteRgb[idx];
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = 255;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/** GIF LZW (variable code size, clear on table overflow). */
function lzwEncode(indices, minCodeSize) {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  const out = [];
  let acc = 0;
  let bits = 0;
  const emit = (code) => {
    acc |= code << bits;
    bits += codeSize;
    while (bits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      // The decoder adds its entry one code later, so grow after the table passes 2^codeSize.
      if (next > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear);
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = eoi + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) out.push(acc & 0xff);
  return out;
}

function subBlocks(bytes) {
  const parts = [];
  for (let i = 0; i < bytes.length; i += 255) {
    const chunk = bytes.slice(i, i + 255);
    parts.push(Buffer.from([chunk.length]), Buffer.from(chunk));
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

export function encodeGif(width, height, frames, paletteRgb, delaysMs) {
  let tableBits = 1;
  while (1 << tableBits < paletteRgb.length) tableBits++;
  const tableSize = 1 << tableBits;
  const gct = Buffer.alloc(tableSize * 3);
  paletteRgb.forEach(([r, g, b], i) => {
    gct[i * 3] = r;
    gct[i * 3 + 1] = g;
    gct[i * 3 + 2] = b;
  });
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(width, 0);
  lsd.writeUInt16LE(height, 2);
  lsd[4] = 0x80 | ((tableBits - 1) << 4) | (tableBits - 1); // global table, colour resolution, table size
  lsd[5] = 0; // background = transparent index
  const parts = [
    Buffer.from('GIF89a', 'ascii'),
    lsd,
    gct,
    Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00]) // loop forever
  ];
  const minCodeSize = Math.max(2, tableBits);
  frames.forEach((indices, f) => {
    const cs = Math.max(2, Math.round((delaysMs[f] ?? 100) / 10));
    // Graphic control: disposal 2 (restore to background) + transparent index 0.
    parts.push(Buffer.from([0x21, 0xf9, 0x04, (2 << 2) | 1, cs & 0xff, (cs >> 8) & 0xff, 0x00, 0x00]));
    const desc = Buffer.alloc(10);
    desc[0] = 0x2c;
    desc.writeUInt16LE(width, 5);
    desc.writeUInt16LE(height, 7);
    parts.push(desc, Buffer.from([minCodeSize]), subBlocks(lzwEncode(indices, minCodeSize)));
  });
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

export function upscale(indices, width, height, factor) {
  const W = width * factor;
  const out = new Uint8Array(W * height * factor);
  for (let y = 0; y < height * factor; y++) {
    for (let x = 0; x < W; x++) out[y * W + x] = indices[Math.floor(y / factor) * width + Math.floor(x / factor)];
  }
  return out;
}

export function hexToRgb(hex) {
  const h = String(hex).replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
