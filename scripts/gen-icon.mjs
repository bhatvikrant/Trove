// Generates a 1024x1024 app-icon.png with no external dependencies.
// A rounded-square gradient tile with a simple "gallery" glyph.
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const S = 1024;
const buf = Buffer.alloc(S * S * 4);

function set(x, y, r, g, b, a) {
  const i = (y * S + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

// Rounded-rect signed coverage (1 inside, 0 outside, soft edge).
function roundedCoverage(x, y, w, h, r) {
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), h - r);
  const dx = x - cx;
  const dy = y - cy;
  const d = Math.sqrt(dx * dx + dy * dy) - r;
  return Math.min(Math.max(0.5 - d, 0), 1);
}

const lerp = (a, b, t) => a + (b - a) * t;

for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cov = roundedCoverage(x, y, S, S, 220);
    if (cov <= 0) {
      set(x, y, 0, 0, 0, 0);
      continue;
    }
    // diagonal gradient blue -> violet
    const t = (x + y) / (2 * S);
    let r = Math.round(lerp(74, 124, t));
    let g = Math.round(lerp(144, 92, t));
    let b = Math.round(lerp(255, 255, t));

    // white rounded "photo" card in the middle
    const px = x - 300;
    const py = y - 300;
    const cardCov = roundedCoverage(px, py, 424, 424, 56);
    if (cardCov > 0) {
      // inside the card: draw a sun + mountain
      const lx = px;
      const ly = py;
      let cr = 245,
        cg = 247,
        cb = 252;
      // sun
      const sx = lx - 120,
        sy = ly - 120;
      if (Math.sqrt(sx * sx + sy * sy) < 52) {
        cr = 255;
        cg = 196;
        cb = 84;
      }
      // mountains (two triangles near the bottom)
      const base = 340;
      const peak1 = Math.abs(lx - 150);
      const peak2 = Math.abs(lx - 280);
      if (ly > base - peak1 * 0.9 && ly < 424) {
        cr = 90;
        cg = 150;
        cb = 255;
      }
      if (ly > base - peak2 * 1.1 && ly < 424) {
        cr = 60;
        cg = 120;
        cb = 235;
      }
      r = Math.round(lerp(r, cr, cardCov));
      g = Math.round(lerp(g, cg, cardCov));
      b = Math.round(lerp(b, cb, cardCov));
    }

    set(x, y, r, g, b, Math.round(cov * 255));
  }
}

// Encode PNG (color type 6, 8-bit RGBA).
function crc32(data) {
  let c = ~0;
  for (let i = 0; i < data.length; i++) {
    c ^= data[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
// filter byte 0 per scanline
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", idat),
  chunk("IEND", Buffer.alloc(0)),
]);

writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("wrote app-icon.png", png.length, "bytes");
