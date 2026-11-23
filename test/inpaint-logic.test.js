import test from "node:test";
import assert from "node:assert/strict";
import {
  LAMA_IMAGE_FIELD,
  LAMA_MASK_FIELD,
  compositeFill,
  fitLongSide,
  maskFromAlpha,
  validateInpaintBody,
} from "../netlify/functions/inpaint-logic.js";

test("inpaint requests require PNG data URLs for the image and the mask", () => {
  assert.equal(validateInpaintBody(null).status, 400);
  assert.match(validateInpaintBody({ image: "https://example.com/a.png" }).error, /image/);
  const missingMask = validateInpaintBody({ image: "data:image/png;base64,aaaa" });
  assert.equal(missingMask.ok, false);
  assert.match(missingMask.error, /mask/);
  const ok = validateInpaintBody({
    image: "data:image/png;base64,aaaa",
    mask: "data:image/png;base64,bbbb",
  });
  assert.equal(ok.ok, true);
  assert.equal(LAMA_IMAGE_FIELD, "image");
  assert.equal(LAMA_MASK_FIELD, "mask");
});

test("a huge data URL is rejected before it is sent", () => {
  const huge = `data:image/png;base64,${"a".repeat(4_600_000)}`;
  const result = validateInpaintBody({ image: huge, mask: "data:image/png;base64,aa" });
  assert.equal(result.status, 413);
});

test("mask from alpha is white only on empty pixels", () => {
  const rgba = new Uint8ClampedArray([
    9, 8, 7, 255,
    1, 2, 3, 0,
  ]);
  const packed = maskFromAlpha(rgba);
  assert.equal(packed.hasEmpty, true);
  assert.equal(packed.mask[0], 0);
  assert.equal(packed.mask[4], 255);
});

test("composite keeps original pixels and uses AI only on the white mask", () => {
  const original = new Uint8ClampedArray([10, 20, 30, 255, 0, 0, 0, 0]);
  const ai = new Uint8ClampedArray([1, 1, 1, 255, 200, 180, 160, 255]);
  const mask = new Uint8ClampedArray([0, 0, 0, 255, 255, 255, 255, 255]);
  const out = compositeFill(original, ai, mask);
  assert.deepEqual([...out.slice(0, 4)], [10, 20, 30, 255]);
  assert.deepEqual([...out.slice(4, 8)], [200, 180, 160, 255]);
});

test("fitLongSide shrinks the longer side and keeps the aspect", () => {
  const fitted = fitLongSide(3000, 1500, 1500);
  assert.equal(fitted.width, 1500);
  assert.equal(fitted.height, 750);
  assert.ok(fitted.scale < 1);
  const small = fitLongSide(800, 600, 1536);
  assert.equal(small.scale, 1);
  assert.equal(small.width, 800);
});
