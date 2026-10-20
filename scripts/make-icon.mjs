// Generates icon.png (128x128) for the VS Code Marketplace listing.
// Pure Node — draws a simple "browser window" glyph with SDF-style pixel
// tests, then encodes a PNG manually (no canvas dependency).
// Usage: node scripts/make-icon.mjs
import { deflateSync } from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";

const S = 128;
const px = Buffer.alloc(S * S * 4); // transparent

// --- shape helpers ---------------------------------------------------------

function insideRect(x, y, r) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

function insideRounded(x, y, r) {
  // Rounded rect: fully inside the inner box, or inside a corner circle.
  const { x: rx, y: ry, w, h } = r;
  const rad = r.r ?? Math.min(w, h) / 2;
  if (x < rx || x >= rx + w || y < ry || y >= ry + h) return false;
  const cx = x < rx + rad ? rx + rad : x >= rx + w - rad ? rx + w - rad : null;
  const cy = y < ry + rad ? ry + rad : y >= ry + h - rad ? ry + h - rad : null;
  if (cx === null || cy === null) return true;
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function insideCircle(x, y, cx, cy, rad) {
  const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function paint(pred, [r, g, b, a = 255]) {
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++)
      if (pred(x, y)) {
        const i = (y * S + x) * 4;
        px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
      }
}

// --- draw ------------------------------------------------------------------

const BG = [30, 41, 59]; // slate-800
const WIN = [226, 232, 240]; // slate-200
const BAR = [249, 115, 22]; // orange-500
const LINE = [148, 163, 184]; // slate-400
const ACCENT = [59, 130, 246]; // blue-500

// Background rounded square (transparent corners).
paint((x, y) => insideRounded(x, y, { x: 0, y: 0, w: S, h: S, r: 26 }), BG);

// Browser window body.
const win = { x: 22, y: 34, w: 84, h: 62, r: 8 };
paint((x, y) => insideRounded(x, y, win), WIN);

// Top bar (top corners rounded, bottom square): bar rect + top cap.
const bar = { x: 22, y: 34, w: 84, h: 16 };
paint(
  (x, y) =>
    (insideRect(x, y, { x: 22, y: 46, w: 84, h: 4 }) ||
      insideRounded(x, y, { x: 22, y: 34, w: 84, h: 24, r: 8 })) &&
    y < 50,
  BAR,
);

// Window dots.
for (const cx of [30, 38, 46]) paint((x, y) => insideCircle(x, y, cx, 42, 3), [255, 255, 255]);

// Content lines.
paint((x, y) => insideRect(x, y, { x: 30, y: 58, w: 68, h: 6, r: 3 }), LINE);
paint((x, y) => insideRect(x, y, { x: 30, y: 70, w: 52, h: 6, r: 3 }), LINE);
paint((x, y) => insideRect(x, y, { x: 30, y: 82, w: 40, h: 6, r: 3 }), LINE);

// Accent "action" dot (the tool's cursor) overlapping the window corner.
paint((x, y) => insideCircle(x, y, 100, 92, 18), ACCENT);
// White check-ish cursor: two bars forming a "play/click" chevron.
paint(
  (x, y) =>
    ((insideRect(x, y, { x: 92, y: 88, w: 6, h: 9, r: 3 }) && x < y + 6) ||
      (insideRect(x, y, { x: 96, y: 93, w: 10, h: 6, r: 3 }) && x > 103 - (y - 93)))
      ? insideCircle(x, y, 100, 92, 18)
      : false,
  [255, 255, 255],
);

// --- PNG encode -------------------------------------------------------------

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
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA

// Filter byte 0 per scanline.
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "icon.png");
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
