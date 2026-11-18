// lib/icon.js — a tiny PNG encoder (Node stdlib: zlib + a CRC32 table).
// Generates the agent's 128x128 icon on the fly: Concordium-teal field
// with a white gate / check mark. No image files, no dependencies.
// The ERC-8004 registration file points at /agent.png, so the image must
// be a real, servable PNG — not a dead link.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

// 128x128 RGBA. Teal background (#0f766e), white gate: two posts + a
// check stroke across the middle.
export function agentPng() {
  const W = 128;
  const H = 128;
  const bg = [15, 118, 110, 255];
  const fg = [255, 255, 255, 255];
  const px = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) px.set(bg, i * 4);
  const set = (x, y) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    px.set(fg, (y * W + x) * 4);
  };
  const bar = (x0, y0, x1, y1, w) => {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    for (let i = 0; i <= steps; i++) {
      const x = Math.round(x0 + (dx * i) / steps);
      const y = Math.round(y0 + (dy * i) / steps);
      for (let a = -w; a <= w; a++) for (let b = -w; b <= w; b++) set(x + a, y + b);
    }
  };
  // Gate posts + top bar.
  bar(28, 28, 28, 100, 3);
  bar(100, 28, 100, 100, 3);
  bar(28, 28, 100, 28, 3);
  // Check mark inside the gate.
  bar(40, 66, 58, 86, 4);
  bar(58, 86, 92, 44, 4);

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
