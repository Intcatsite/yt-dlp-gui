// Generates build/icon.png (1024x1024) — a simple flat "download" glyph on a
// gradient rounded-square background. electron-builder derives .ico/.icns
// from this single source PNG at build time.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 1024;
const buf = Buffer.alloc(SIZE * SIZE * 4); // RGBA

function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // Alpha-blend onto whatever is already there (for simple AA at edges).
  const srcA = a / 255;
  const dstA = buf[i + 3] / 255;
  const outA = srcA + dstA * (1 - srcA);
  if (outA <= 0) return;
  buf[i] = (r * srcA + buf[i] * dstA * (1 - srcA)) / outA;
  buf[i + 1] = (g * srcA + buf[i + 1] * dstA * (1 - srcA)) / outA;
  buf[i + 2] = (b * srcA + buf[i + 2] * dstA * (1 - srcA)) / outA;
  buf[i + 3] = outA * 255;
}

function hex(c) {
  return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
}
const C1 = hex('#0a84ff');
const C2 = hex('#5e5ce6');

function roundedRectMask(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r || (x >= r && x <= w - r) || (y >= r && y <= h - r);
}

const RADIUS = 200;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (!roundedRectMask(x, y, SIZE, SIZE, RADIUS)) continue;
    const t = (x + y) / (2 * SIZE);
    const r = C1[0] + (C2[0] - C1[0]) * t;
    const g = C1[1] + (C2[1] - C1[1]) * t;
    const b = C1[2] + (C2[2] - C1[2]) * t;
    setPx(x, y, r, g, b, 255);
  }
}

// White "download" glyph: vertical stem + arrow head + base tray.
const cx = SIZE / 2;
const stemW = 90;
const stemTop = 260;
const stemBottom = 560;
for (let y = stemTop; y < stemBottom; y++) {
  for (let x = cx - stemW / 2; x < cx + stemW / 2; x++) setPx(Math.round(x), y, 255, 255, 255, 255);
}
// Arrow head (triangle) below the stem.
const headTop = stemBottom - 10;
const headBottom = 700;
const headHalfWidthAt = (y) => {
  const t = (y - headTop) / (headBottom - headTop);
  return 220 * Math.max(0, Math.min(1, t));
};
for (let y = headTop; y < headBottom; y++) {
  const hw = headHalfWidthAt(y);
  for (let x = cx - hw; x < cx + hw; x++) setPx(Math.round(x), y, 255, 255, 255, 255);
}
// Base tray (horizontal bar).
const trayY = 760;
const trayH = 70;
const trayHalfW = 300;
for (let y = trayY; y < trayY + trayH; y++) {
  for (let x = cx - trayHalfW; x < cx + trayHalfW; x++) setPx(Math.round(x), y, 255, 255, 255, 255);
}

// ---- Minimal PNG encoder ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf2) {
  let c = 0xffffffff;
  for (let i = 0; i < buf2.length; i++) c = CRC_TABLE[(c ^ buf2[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData), 0);
  return Buffer.concat([len, typeData, crc]);
}

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter type: none
  buf.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('Wrote', path.join(outDir, 'icon.png'), `(${png.length} bytes)`);
