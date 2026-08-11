// Generates a 1024x1024 app-icon.png (the "Trove" logo) with no dependencies:
// a violet→pink rounded tile with two overlapping cards (a collection) plus a
// small sun and mountain in the front card. Rendered at 2x and downsampled for
// clean antialiasing.
import zlib from "node:zlib";
import { writeFileSync } from "node:fs";

const OUT = 1024;
const SS = 2;
const S = OUT * SS;
const k = S / 96; // work in a 96-unit design space, scaled up

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

// Coverage (1 inside, 0 outside, soft 1px edge) of a rounded rectangle.
function rrectCov(px, py, x0, y0, x1, y1, r) {
  const w = x1 - x0;
  const h = y1 - y0;
  const lx = px - x0;
  const ly = py - y0;
  const cx = Math.min(Math.max(lx, r), w - r);
  const cy = Math.min(Math.max(ly, r), h - r);
  const dx = lx - cx;
  const dy = ly - cy;
  const d = Math.sqrt(dx * dx + dy * dy) - r;
  return clamp01(0.5 - d);
}
function circleCov(px, py, cx, cy, rr) {
  const d = Math.hypot(px - cx, py - cy) - rr;
  return clamp01(0.5 - d);
}
function inPoly(px, py, poly) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)
      c = !c;
  }
  return c;
}

const mtn = [
  [39, 71],
  [48, 61],
  [53, 66],
  [60, 57],
  [71, 68],
  [71, 71],
].map(([x, y]) => [x * k, y * k]);

// Supersampled RGBA (straight alpha).
const big = new Float32Array(S * S * 4);
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    const cov = rrectCov(x, y, 4 * k, 4 * k, 92 * k, 92 * k, 22 * k);
    const i = (y * S + x) * 4;
    if (cov <= 0) {
      big[i + 3] = 0;
      continue;
    }
    const t = (x + y) / (2 * S);
    // gradient #8b5cf6 (139,92,246) -> #ec4899 (236,72,153)
    let r = lerp(139, 236, t);
    let g = lerp(92, 72, t);
    let b = lerp(246, 153, t);

    const back = rrectCov(x, y, 25 * k, 29 * k, 57 * k, 61 * k, 7 * k) * 0.45;
    r = lerp(r, 255, back);
    g = lerp(g, 255, back);
    b = lerp(b, 255, back);

    const front = rrectCov(x, y, 39 * k, 39 * k, 71 * k, 71 * k, 7 * k);
    if (front > 0) {
      let fr = 255;
      let fg = 255;
      let fb = 255;
      const sun = circleCov(x, y, 49 * k, 48 * k, 4 * k);
      fr = lerp(fr, 249, sun);
      fg = lerp(fg, 168, sun);
      fb = lerp(fb, 212, sun);
      if (inPoly(x, y, mtn)) {
        fr = lerp(fr, 217, 0.6);
        fg = lerp(fg, 79, 0.6);
        fb = lerp(fb, 176, 0.6);
      }
      r = lerp(r, fr, front);
      g = lerp(g, fg, front);
      b = lerp(b, fb, front);
    }

    big[i] = r;
    big[i + 1] = g;
    big[i + 2] = b;
    big[i + 3] = cov * 255;
  }
}

// Downsample SSxSS -> 1x with alpha-weighted color averaging.
const buf = Buffer.alloc(OUT * OUT * 4);
for (let oy = 0; oy < OUT; oy++) {
  for (let ox = 0; ox < OUT; ox++) {
    let r = 0;
    let g = 0;
    let b = 0;
    let a = 0;
    for (let dy = 0; dy < SS; dy++) {
      for (let dx = 0; dx < SS; dx++) {
        const i = ((oy * SS + dy) * S + (ox * SS + dx)) * 4;
        const al = big[i + 3];
        a += al;
        r += big[i] * al;
        g += big[i + 1] * al;
        b += big[i + 2] * al;
      }
    }
    const oi = (oy * OUT + ox) * 4;
    if (a > 0) {
      buf[oi] = Math.round(r / a);
      buf[oi + 1] = Math.round(g / a);
      buf[oi + 2] = Math.round(b / a);
    }
    buf[oi + 3] = Math.round(a / (SS * SS));
  }
}

// ---- PNG encode (RGBA, 8-bit) ----
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
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT, 0);
ihdr.writeUInt32BE(OUT, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc(OUT * (OUT * 4 + 1));
for (let y = 0; y < OUT; y++) {
  raw[y * (OUT * 4 + 1)] = 0;
  buf.copy(raw, y * (OUT * 4 + 1) + 1, y * OUT * 4, (y + 1) * OUT * 4);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
writeFileSync(new URL("../app-icon.png", import.meta.url), png);
console.log("wrote app-icon.png", png.length, "bytes");
