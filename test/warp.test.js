import test from "node:test";
import assert from "node:assert/strict";
import { invert3x3, solveHomography } from "../homography.js";
import {
  fitOutputSize,
  fitTextureSize,
  sourceRegionForTile,
  warpBuffer,
} from "../warp.js";

function solid(w, h, r, g, b, a = 255) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return data;
}

function pixel(data, w, x, y) {
  const i = (y * w + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

test("identity warp copies flat color blocks", () => {
  const w = 8;
  const h = 6;
  const src = solid(w, h, 0, 0, 0, 0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const left = x < 4;
      src[i] = left ? 200 : 10;
      src[i + 1] = left ? 20 : 180;
      src[i + 2] = y < 3 ? 30 : 220;
      src[i + 3] = 255;
    }
  }
  const Hinv = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const out = warpBuffer(src, w, h, Hinv, w, h, 0, 0, w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const got = pixel(out, w, x, y);
      const expect = pixel(src, w, x, y);
      assert.deepEqual(got, expect, `pixel ${x},${y}`);
    }
  }
});

test("samples outside the photo are transparent", () => {
  const src = solid(4, 4, 255, 0, 0, 255);
  const Hinv = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const out = warpBuffer(src, 4, 4, Hinv, 4, 4, -2, -2, 4, 4);
  assert.deepEqual(pixel(out, 4, 0, 0), [0, 0, 0, 0]);
  const inside = pixel(out, 4, 3, 3);
  assert.equal(inside[0], 255);
  assert.equal(inside[3], 255);
});

test("a scale-by-two homography keeps a flat field flat", () => {
  const src = solid(4, 4, 12, 80, 200, 255);
  const H = [2, 0, 0, 0, 2, 0, 0, 0, 1];
  const out = warpBuffer(src, 4, 4, invert3x3(H), 8, 8, 0, 0, 8, 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      const got = pixel(out, 8, x, y);
      assert.ok(Math.abs(got[0] - 12) <= 1, `r ${x},${y} = ${got[0]}`);
      assert.ok(Math.abs(got[1] - 80) <= 1, `g ${x},${y}`);
      assert.ok(Math.abs(got[2] - 200) <= 1, `b ${x},${y}`);
      assert.equal(got[3], 255);
    }
  }
});

test("inverse warp of a quad lands known colors on the rectangle", () => {
  const srcW = 60;
  const srcH = 40;
  const src = solid(srcW, srcH, 240, 240, 240, 255);
  const quad = [
    { x: 8, y: 6 },
    { x: 50, y: 8 },
    { x: 6, y: 32 },
    { x: 52, y: 34 },
  ];
  paint(src, srcW, quad, 20, 90, 160);
  const destW = 40;
  const destH = 24;
  const dst = [
    { x: 0, y: 0 },
    { x: destW, y: 0 },
    { x: 0, y: destH },
    { x: destW, y: destH },
  ];
  const H = solveHomography(quad, dst);
  const out = warpBuffer(src, srcW, srcH, invert3x3(H), destW, destH, 0, 0, destW, destH);
  const center = pixel(out, destW, destW / 2, destH / 2);
  assert.ok(Math.abs(center[0] - 20) < 8, `center r ${center}`);
  assert.ok(Math.abs(center[1] - 90) < 8, `center g ${center}`);
  assert.ok(Math.abs(center[2] - 160) < 8, `center b ${center}`);
  const outside = pixel(src, srcW, 1, 1);
  assert.equal(outside[0], 240);
});

test("fitTextureSize downscales only when needed", () => {
  const small = fitTextureSize(3000, 2000, 4096);
  assert.equal(small.scale, 1);
  assert.equal(small.width, 3000);
  const big = fitTextureSize(12000, 8000, 4096);
  assert.ok(big.width <= 4096);
  assert.ok(big.height <= 4096);
  assert.ok(Math.abs(big.width / big.height - 12000 / 8000) < 0.01);
});

test("fitOutputSize caps area and dimension", () => {
  const ok = fitOutputSize(2000, 1000);
  assert.equal(ok.capped, false);
  const wide = fitOutputSize(20000, 1000);
  assert.equal(wide.capped, true);
  assert.ok(wide.width <= 16384);
  const huge = fitOutputSize(20000, 20000);
  assert.equal(huge.capped, true);
  assert.ok(huge.width * huge.height <= 64_000_000);
});

test("sourceRegionForTile on an identity covers that tile", () => {
  const Hinv = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const region = sourceRegionForTile({
    tx: 10, ty: 20, tw: 15, th: 12,
    outW: 100, outH: 80,
    originX: 0, originY: 0, spanX: 100, spanY: 80,
    Hinv, srcW: 100, srcH: 80,
  });
  assert.ok(region.x <= 10);
  assert.ok(region.y <= 20);
  assert.ok(region.x + region.w >= 25);
  assert.ok(region.y + region.h >= 32);
  assert.ok(region.w < 40);
});

function paint(data, w, quad, r, g, b) {
  const [tl, tr, bl, br] = quad;
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < w; x++) {
      const p = { x: x + 0.5, y: y + 0.5 };
      if (!insideQuad(p, tl, tr, br, bl)) continue;
      const i = (y * w + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
}

function insideQuad(p, a, b, c, d) {
  const o1 = cross(a, b, p);
  const o2 = cross(b, c, p);
  const o3 = cross(c, d, p);
  const o4 = cross(d, a, p);
  const hasNeg = o1 < 0 || o2 < 0 || o3 < 0 || o4 < 0;
  const hasPos = o1 > 0 || o2 > 0 || o3 > 0 || o4 > 0;
  return !(hasNeg && hasPos);
}

function cross(a, b, c) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
