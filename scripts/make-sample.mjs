/**
 * Builds samples/gallery-wall.png: a room photo whose framed picture is a
 * true projective warp of a straight artwork. Re-run with:
 *   node scripts/make-sample.mjs
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import {
  applyHomography,
  fitFrame,
  invert3x3,
  placeOnFrame,
  planRectangle,
  rectangleTargets,
  solveHomography,
} from "../homography.js";
import { warpBuffer } from "../warp.js";

const GLYPHS = {
  W: ["10001", "10001", "10001", "10101", "10101", "01010", "10001"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
};

const roomW = 1700;
const roomH = 1140;
const quad = [
  { x: 470, y: 230 },
  { x: 1210, y: 280 },
  { x: 420, y: 820 },
  { x: 1275, y: 890 },
];

const plan = planRectangle(quad);
const artW = 1000;
const artH = Math.max(2, Math.round(artW / plan.aspect));
const art = drawArtwork(artW, artH);
const room = drawRoom(roomW, roomH);

const Hinto = solveHomography(rectangleTargets(artW, artH), quad);
const warped = warpBuffer(art, artW, artH, invert3x3(Hinto), roomW, roomH, 0, 0, roomW, roomH);
castShadow(room, warped, roomW, roomH, 18, 26);
composite(room, warped);

const back = warpBuffer(
  room,
  roomW,
  roomH,
  invert3x3(solveHomography(quad, rectangleTargets(plan.width, plan.height))),
  plan.width,
  plan.height,
  0,
  0,
  plan.width,
  plan.height,
);

const sun = [228, 164, 64];
const frame = [62, 32, 24];
const center = pixel(back, plan.width, Math.floor(plan.width / 2), Math.floor(plan.height * 0.42));
const corner = pixel(back, plan.width, 10, 10);
assertNear("corrected center", center, sun, 6);
assertNear("corrected corner", corner, frame, 6);

const mid = lineIntersection(quad[0], quad[3], quad[1], quad[2]);
const placed = pixel(room, roomW, Math.round(mid.x), Math.round(mid.y));
assertNear("warped center on the wall", placed, sun, 10);

mkdirSync(new URL("../samples/", import.meta.url), { recursive: true });
const png = encodePNG(roomW, roomH, room);
writeFileSync(new URL("../samples/gallery-wall.png", import.meta.url), png);
writeFileSync(
  new URL("../samples/gallery-wall.json", import.meta.url),
  JSON.stringify({
    width: roomW,
    height: roomH,
    corners: { topLeft: quad[0], topRight: quad[1], bottomLeft: quad[2], bottomRight: quad[3] },
    edgeAspect: Number(plan.aspect.toFixed(4)),
    artwork: { width: artW, height: artH },
  }, null, 2),
);

console.log(`wrote samples/gallery-wall.png (${png.length} bytes)`);
console.log(`quad aspect ${plan.aspect.toFixed(4)}, artwork ${artW}x${artH}, corrected ${plan.width}x${plan.height}`);
console.log(`center ${center} corner ${corner}`);
buildRoomPhoto();

function drawRoom(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  const floorAt = h - 175;
  const boardAt = floorAt - 18;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const n = ((x * 13 + y * 29) % 9) - 4;
      let r;
      let g;
      let b;
      if (y >= floorAt) {
        const u = (y - floorAt) / (h - floorAt);
        r = 156 - u * 18 + n;
        g = 118 - u * 12 + n;
        b = 84 - u * 8 + n * 0.5;
      } else if (y >= boardAt) {
        r = 86 + n;
        g = 66 + n;
        b = 48 + n * 0.4;
      } else {
        const t = y / boardAt;
        r = 242 - t * 14 + n;
        g = 236 - t * 16 + n;
        b = 226 - t * 18 + n;
      }
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return data;
}

function drawArtwork(w, h) {
  const data = new Uint8ClampedArray(w * h * 4);
  fillRect(data, w, 0, 0, w, h, 62, 32, 24, 255);
  const frame = Math.round(Math.min(w, h) * 0.055);
  const mat = Math.round(frame * 0.7);
  fillRect(data, w, frame, frame, w - frame * 2, h - frame * 2, 246, 241, 232, 255);
  const picX = frame + mat;
  const picY = frame + mat;
  const picW = w - picX * 2;
  const picH = h - picY * 2;
  for (let y = 0; y < picH; y++) {
    const t = y / picH;
    const r = 126 + t * 70;
    const g = 170 + t * 36;
    const b = 196 + t * 16;
    fillRect(data, w, picX, picY + y, picW, 1, r, g, b, 255);
  }
  fillEllipse(data, w, h, w * 0.36, picY + picH * 0.9, picW * 0.42, picH * 0.16, 122, 148, 132, 255);
  fillEllipse(data, w, h, w * 0.66, picY + picH * 1.02, picW * 0.5, picH * 0.16, 74, 102, 78, 255);
  const cx = w / 2;
  const cy = h * 0.42;
  fillCircle(data, w, h, cx, cy, Math.min(w, h) * 0.09, 228, 164, 64, 255);
  drawWord(data, w, h, "WALL", w * 0.5, picY + picH * 0.52, Math.round(picH * 0.034));
  return data;
}

function drawWord(data, w, h, word, centerX, top, scale) {
  const glyphW = 5 * scale;
  const gap = scale * 1.4;
  const total = word.length * glyphW + (word.length - 1) * gap;
  let x0 = Math.round(centerX - total / 2);
  for (const ch of word) {
    const rows = GLYPHS[ch];
    for (let gy = 0; gy < rows.length; gy++) {
      for (let gx = 0; gx < rows[gy].length; gx++) {
        if (rows[gy][gx] !== "1") continue;
        fillRect(data, w, x0 + gx * scale, top + gy * scale, scale, scale, 48, 36, 28, 255);
      }
    }
    x0 += glyphW + gap;
  }
}

function fillRect(data, w, x, y, rw, rh, r, g, b, a) {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(w, Math.ceil(x + rw));
  const y1 = Math.min(data.length / 4 / w, Math.ceil(y + rh));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const i = (yy * w + xx) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
}

function fillCircle(data, w, h, cx, cy, radius, r, g, b, a) {
  const y0 = Math.max(0, Math.floor(cy - radius));
  const y1 = Math.min(h, Math.ceil(cy + radius));
  const x0 = Math.max(0, Math.floor(cx - radius));
  const x1 = Math.min(w, Math.ceil(cx + radius));
  const rr = radius * radius;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > rr) continue;
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
}

function fillEllipse(data, w, h, cx, cy, rx, ry, r, g, b, a) {
  const y0 = Math.max(0, Math.floor(cy - ry));
  const y1 = Math.min(h, Math.ceil(cy + ry));
  const x0 = Math.max(0, Math.floor(cx - rx));
  const x1 = Math.min(w, Math.ceil(cx + rx));
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    }
  }
}

function castShadow(dst, src, w, h, ox, oy) {
  for (let y = 0; y < h; y++) {
    const sy = y - oy;
    if (sy < 0 || sy >= h) continue;
    for (let x = 0; x < w; x++) {
      const sx = x - ox;
      if (sx < 0 || sx >= w) continue;
      const a = src[(sy * w + sx) * 4 + 3];
      if (a < 20) continue;
      const i = (y * w + x) * 4;
      dst[i] = dst[i] * 0.78;
      dst[i + 1] = dst[i + 1] * 0.78;
      dst[i + 2] = dst[i + 2] * 0.76;
    }
  }
}

function composite(dst, src) {
  for (let i = 0; i < dst.length; i += 4) {
    const a = src[i + 3] / 255;
    if (a <= 0) continue;
    dst[i] = src[i] * a + dst[i] * (1 - a);
    dst[i + 1] = src[i + 1] * a + dst[i + 1] * (1 - a);
    dst[i + 2] = src[i + 2] * a + dst[i + 2] * (1 - a);
    dst[i + 3] = 255;
  }
}

function pixel(data, w, x, y) {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]].map((v) => Math.round(v));
}

function assertNear(label, got, expect, tol) {
  for (let k = 0; k < 3; k++) {
    if (Math.abs(got[k] - expect[k]) > tol) {
      throw new Error(`${label}: got ${got}, expected ${expect}`);
    }
  }
}

function lineIntersection(a, b, c, d) {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const name = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE((crc32(Buffer.concat([name, data])) >>> 0));
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}

function buildRoomPhoto() {
  const w = 1200;
  const h = 800;
  const frontal = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r;
      let g;
      let b;
      const inWindow = x >= 470 && x < 790 && y >= 230 && y < 500;
      const inFrame = x >= 448 && x < 812 && y >= 208 && y < 522;
      if (y < 150) {
        r = 168; g = 204; b = 214;
      } else if (y >= 630) {
        r = 124; g = 86; b = 56;
      } else if (x < 150) {
        r = 186; g = 154; b = 128;
      } else {
        r = 230; g = 216; b = 198;
      }
      if (inFrame) { r = 48; g = 34; b = 26; }
      if (inWindow) { r = 126; g = 176; b = 206; }
      const i = (y * w + x) * 4;
      frontal[i] = r;
      frontal[i + 1] = g;
      frontal[i + 2] = b;
      frontal[i + 3] = 255;
    }
  }
  const Hview = [1.05, 0.09, -28, -0.02, 1.03, 12, 0.00015, -0.00004, 1];
  const photo = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = applyHomography(Hview, x + 0.5, y + 0.5);
      const sx = Math.min(w - 1, Math.max(0, Math.round(p.x)));
      const sy = Math.min(h - 1, Math.max(0, Math.round(p.y)));
      const si = (sy * w + sx) * 4;
      const di = (y * w + x) * 4;
      photo[di] = frontal[si];
      photo[di + 1] = frontal[si + 1];
      photo[di + 2] = frontal[si + 2];
      photo[di + 3] = 255;
    }
  }
  const Hinv = invert3x3(Hview);
  const windowFrontal = [
    { x: 448, y: 208 },
    { x: 812, y: 208 },
    { x: 448, y: 522 },
    { x: 812, y: 522 },
  ];
  const windowPhoto = windowFrontal.map((point) => applyHomography(Hinv, point.x, point.y));
  const plan = planRectangle(windowPhoto);
  const H = solveHomography(windowPhoto, rectangleTargets(plan.width, plan.height));
  const fit = fitFrame(H, w, h);
  for (const [x, y] of [[0, 0], [w, 0], [w, h], [0, h]]) {
    const mapped = applyHomography(H, x, y);
    const placed = placeOnFrame(fit, mapped.x, mapped.y);
    if (placed.x < -1 || placed.y < -1 || placed.x > fit.width + 1 || placed.y > fit.height + 1) {
      throw new Error(`room corner cropped at ${placed.x}, ${placed.y}`);
    }
  }
  writeFileSync(new URL("../samples/room.png", import.meta.url), encodePNG(w, h, photo));
  writeFileSync(new URL("../samples/room.json", import.meta.url), JSON.stringify({
    width: w,
    height: h,
    window: windowPhoto.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })),
  }, null, 2));
  console.log(`wrote samples/room.png, window ${JSON.stringify(windowPhoto.map((p) => [Math.round(p.x), Math.round(p.y)]))}`);
}
