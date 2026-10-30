// Rasterizes the app icon (same shapes as public/icon.svg) to PNG, with no
// dependencies: flat shapes, 4×4 supersampling, a minimal PNG encoder.
// Usage: node scripts/icons.mjs   → public/icon-192.png, public/icon-512.png

import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// in a 512×512 design space, painted in order (keep in sync with icon.svg)
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const SHAPES = [
  { rect: [0, 0, 512, 512], color: hex('#201533') },
  { rect: [178, 150, 200, 250], color: hex('#fcf660') },
  { rect: [134, 112, 200, 250], color: hex('#b2d942') },
  { circle: [256, 256, 78], color: hex('#201533') },
  { circle: [256, 256, 30], color: hex('#52c33f') },
];

function colourAt(x, y) {
  let c = SHAPES[0].color;
  for (const s of SHAPES) {
    if (s.rect) {
      const [rx, ry, w, h] = s.rect;
      if (x >= rx && x < rx + w && y >= ry && y < ry + h) c = s.color;
    } else {
      const [cx, cy, r] = s.circle;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) c = s.color;
    }
  }
  return c;
}

function render(size) {
  const ss = 4;
  const k = 512 / size;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3); // filter byte 0, then RGB
    for (let x = 0; x < size; x++) {
      const acc = [0, 0, 0];
      for (let j = 0; j < ss; j++) {
        for (let i = 0; i < ss; i++) {
          const c = colourAt((x + (i + 0.5) / ss) * k, (y + (j + 0.5) / ss) * k);
          acc[0] += c[0];
          acc[1] += c[1];
          acc[2] += c[2];
        }
      }
      for (let ch = 0; ch < 3; ch++) row[1 + x * 3 + ch] = Math.round(acc[ch] / (ss * ss));
    }
    rows.push(row);
  }
  return png(size, size, Buffer.concat(rows));
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) {
  const out = new URL(`../public/icon-${size}.png`, import.meta.url);
  writeFileSync(out, render(size));
  console.log(`wrote public/icon-${size}.png`);
}
