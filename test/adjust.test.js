import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAdjustmentsBuffer,
  buildMask,
  compositeOnWhite,
  whiteBalanceGains,
} from "../adjust.js";

test("white balance gains neutralize a warm patch", () => {
  const gains = whiteBalanceGains({ r: 200, g: 100, b: 50 });
  const balanced = [200 * gains[0], 100 * gains[1], 50 * gains[2]];
  assert.ok(Math.abs(balanced[0] - balanced[1]) < 1e-6);
  assert.ok(Math.abs(balanced[1] - balanced[2]) < 1e-6);
  assert.ok(gains[2] > gains[0]);
});

test("clarity leaves a flat field unchanged and darkens an edge", () => {
  const flat = new Uint8ClampedArray(16);
  for (let i = 0; i < flat.length; i += 4) {
    flat[i] = flat[i + 1] = flat[i + 2] = 80;
    flat[i + 3] = 255;
  }
  const same = applyAdjustmentsBuffer(flat, 2, 2, [1, 1, 1], 30);
  assert.equal(same[0], 80);

  const edge = new Uint8ClampedArray(5 * 5 * 4);
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 5; x++) {
      const i = (y * 5 + x) * 4;
      const value = x < 3 ? 40 : 220;
      edge[i] = edge[i + 1] = edge[i + 2] = value;
      edge[i + 3] = 255;
    }
  }
  const sharp = applyAdjustmentsBuffer(edge, 5, 5, [1, 1, 1], 30);
  assert.ok(sharp[(2 * 5 + 2) * 4] < 40);
});

test("mask marks empty pixels and white composite fills them", () => {
  const src = new Uint8ClampedArray([
    10, 20, 30, 255,
    0, 0, 0, 0,
  ]);
  const packed = buildMask(src, 2, 1);
  assert.equal(packed.hasEmpty, true);
  assert.equal(packed.mask[0], 255);
  assert.equal(packed.mask[4], 0);
  assert.equal(packed.mask[7], 255);
  const filled = compositeOnWhite(src);
  assert.deepEqual([filled[0], filled[1], filled[2], filled[3]], [10, 20, 30, 255]);
  assert.deepEqual([filled[4], filled[5], filled[6], filled[7]], [255, 255, 255, 255]);
});

test("a fully opaque warp reports no empty area", () => {
  const src = new Uint8ClampedArray([1, 2, 3, 255, 4, 5, 6, 255]);
  const packed = buildMask(src, 2, 1);
  assert.equal(packed.hasEmpty, false);
  assert.equal(packed.mask[0], 255);
  assert.equal(packed.mask[4], 255);
});
