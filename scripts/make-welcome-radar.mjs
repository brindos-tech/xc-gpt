#!/usr/bin/env node
// Draws the example radar picture used in the welcome screen (a made-up
// squall line with trailing rain, in the standard NEXRAD colours) to
// assets/img/welcome-radar.png. Deterministic: same file every run.
//
//   node scripts/make-welcome-radar.mjs

import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const W = 1000;
const H = 600;

// --- seeded value noise ---
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}
function makeNoise(seed, size = 256) {
  const r = rng(seed);
  const g = Float32Array.from({ length: size * size }, r);
  const at = (x, y) => g[((y % size) + size) % size * size + (((x % size) + size) % size)];
  const smooth = (t) => t * t * (3 - 2 * t);
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const fx = smooth(x - x0);
    const fy = smooth(y - y0);
    return at(x0, y0) * (1 - fx) * (1 - fy) + at(x0 + 1, y0) * fx * (1 - fy) + at(x0, y0 + 1) * (1 - fx) * fy + at(x0 + 1, y0 + 1) * fx * fy;
  };
}
const n1 = makeNoise(11);
const n2 = makeNoise(29);
const n3 = makeNoise(47);
const fbm = (n, x, y, oct = 5) => {
  let sum = 0;
  let amp = 0.5;
  let f = 1;
  for (let i = 0; i < oct; i++, amp /= 2, f *= 2) sum += amp * n(x * f, y * f);
  return sum / (1 - 2 ** -oct); // ~0..1
};

// classic NWS reflectivity colours (dBZ -> rgb)
const PALETTE = [
  [10, 1, 159, 244], [15, 3, 0, 244], [20, 2, 253, 2], [25, 1, 197, 1], [30, 0, 142, 0], [35, 253, 248, 2],
  [40, 229, 188, 0], [45, 253, 149, 0], [50, 253, 0, 0], [55, 212, 0, 0], [60, 188, 0, 0], [65, 248, 0, 253], [70, 152, 84, 198],
];
function colour(dbz) {
  if (dbz < 10) return [0, 0, 0, 0];
  let c = PALETTE[0];
  for (const p of PALETTE) if (dbz >= p[0]) c = p;
  const edge = Math.min(1, (dbz - 10) / 6); // soft ragged outer edge
  return [c[1], c[2], c[3], Math.round(235 * edge)];
}

const pixels = Buffer.alloc(W * H * 4);
// two lines running from the lower left to the upper right: a strong one and a weaker one behind it
const ang = (-30 * Math.PI) / 180;
const ca = Math.cos(ang);
const sa = Math.sin(ang);
function line(u, v, x, y, offset, strength, seed) {
  const along = u * ca + v * sa;
  const across0 = -u * sa + v * ca - offset;
  const across = across0 - 0.05 * Math.cos(along * 5.0 + seed) + 0.07 * (fbm(n3, x / 200 + seed, y / 200, 3) - 0.5);
  const broken = Math.max(0, Math.min(1, 0.35 + 1.4 * fbm(n2, along * 4.0 + seed * 3, 2.7 + seed, 4)));
  const core = Math.exp(-((across / 0.035) ** 2)) * broken;
  const shield = across > 0 ? Math.exp(-across / 0.2) * Math.max(0, fbm(n1, x / 110 + seed, y / 110, 4) * 1.5 - 0.35) : 0;
  const lead = across < 0 ? Math.exp(-((across / 0.05) ** 2)) * 0.25 : 0;
  return { core: core * strength, shield: shield * strength, lead: lead * strength };
}
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const u = x / W - 0.5;
    const v = y / H - 0.5;
    const a = line(u, v, x, y, -0.04, 1, 0);
    const b = line(u, v, x, y, 0.3, 0.55, 5);
    const grain = fbm(n1, x / 7, y / 7, 3); // radar-pixel grain
    const cell = fbm(n2, x / 34, y / 34, 4); // convective towers inside the cores
    const scattered = Math.max(0, fbm(n3, x / 60 + 9, y / 60 + 4, 4) - 0.6) * 5;
    const dbz =
      14 * (a.shield + b.shield) * (0.7 + 0.6 * grain) * 3.6 +
      52 * (a.core + b.core) * (0.35 + 0.95 * cell) +
      16 * (a.lead + b.lead) * (0.5 + cell) +
      30 * scattered * (0.4 + cell) +
      8 * (grain - 0.5) -
      4;
    const [r, g, bl, al] = colour(dbz);
    const i = (y * W + x) * 4;
    pixels[i] = r;
    pixels[i + 1] = g;
    pixels[i + 2] = bl;
    pixels[i + 3] = al;
  }
}

// --- PNG encoder (RGBA, 8 bit) ---
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8;
ihdr[9] = 6;
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 4 + 1)] = 0;
  pixels.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
}
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
writeFileSync("assets/img/welcome-radar.png", png);
console.log(`wrote assets/img/welcome-radar.png (${(png.length / 1024).toFixed(0)} KB)`);
