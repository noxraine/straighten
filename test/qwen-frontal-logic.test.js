import test from "node:test";
import assert from "node:assert/strict";
import {
  QWEN_PROMPT,
  buildQwenInput,
  formatQwenError,
  markerRadius,
  rotateDegreesFromMarker,
  validateQwenBody,
} from "../netlify/functions/qwen-frontal-logic.js";
import { replicateFailure } from "../netlify/functions/inpaint-logic.js";

test("rotate_degrees turns a left-side marker into a positive left rotation", () => {
  assert.equal(rotateDegreesFromMarker(0, 1000), 45);
  assert.equal(rotateDegreesFromMarker(500, 1000), 0);
  assert.equal(rotateDegreesFromMarker(1000, 1000), -45);
  assert.equal(rotateDegreesFromMarker(250, 1000), 23);
  assert.equal(rotateDegreesFromMarker(-100, 1000), 45);
  assert.equal(rotateDegreesFromMarker(5000, 1000), -45);
  assert.equal(rotateDegreesFromMarker(10, 0), 0);
});

test("the marker circle is two percent of the short side", () => {
  assert.equal(markerRadius(2000, 1000), 20);
  assert.equal(markerRadius(800, 1200), 16);
});

test("the Qwen input keeps the documented camera settings", () => {
  const input = buildQwenInput({
    image: "data:image/jpeg;base64,aaa",
    rotateDegrees: 30.4,
    multipleAnglesStrength: 1.26,
  });
  assert.equal(input.image, "data:image/jpeg;base64,aaa");
  assert.equal(input.prompt, QWEN_PROMPT);
  assert.equal(input.aspect_ratio, "match_input_image");
  assert.equal(input.go_fast, true);
  assert.equal(input.use_multiple_angles, true);
  assert.equal(input.vertical_tilt, 0);
  assert.equal(input.move_forward, 0);
  assert.equal(input.use_wide_angle, false);
  assert.equal(input.output_format, "png");
  assert.equal(input.rotate_degrees, 30);
  assert.equal(input.multiple_angles_strength, 1.26);
  assert.equal(buildQwenInput({ image: "x", rotateDegrees: 120 }).rotate_degrees, 90);
  assert.equal(buildQwenInput({ image: "x", multipleAnglesStrength: 9 }).multiple_angles_strength, 2);
});

test("Qwen requests require an image data URL and map Replicate errors", () => {
  assert.equal(validateQwenBody(null).status, 400);
  assert.match(validateQwenBody({ rotate_degrees: 10 }).error, /image/);
  const ok = validateQwenBody({
    image: "data:image/jpeg;base64,aaa",
    rotate_degrees: 12.2,
    multiple_angles_strength: 0.5,
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.rotateDegrees, 12);
  assert.equal(ok.multipleAnglesStrength, 0.5);
  const credit = replicateFailure(402, "create");
  assert.equal(formatQwenError({ status: 402, payload: credit }), "Replicate 402: insufficient credit");
  assert.match(formatQwenError({ network: true }), /Network error/);
  assert.match(formatQwenError({ timeout: true }), /Timed out/);
  assert.match(formatQwenError({ empty: true }), /no image/);
});
