import test from "node:test";
import assert from "node:assert/strict";
import { applyHomography } from "../homography.js";
import {
  QWEN_PROMPT,
  buildQwenInput,
  formatQwenError,
  previewHomography,
  validateQwenBody,
} from "../netlify/functions/qwen-frontal-logic.js";
import { replicateFailure } from "../netlify/functions/inpaint-logic.js";

test("the local preview turns the camera left when rotate_degrees is positive", () => {
  const H = previewHomography(1000, 800, {
    rotateDegrees: 25,
    verticalTilt: 0,
    moveForward: 0,
    useWideAngle: false,
    multipleAnglesStrength: 1,
  });
  const center = applyHomography(H, 500, 400);
  assert.ok(center.x > 520, `center moved to ${center.x}`);
  const tilted = previewHomography(1000, 800, {
    rotateDegrees: 0,
    verticalTilt: 1,
    moveForward: 0,
    multipleAnglesStrength: 1,
  });
  const up = applyHomography(tilted, 500, 400);
  assert.ok(up.y < 380, `tilt moved to ${up.y}`);
});

test("the Qwen input is a camera edit of the original image", () => {
  const input = buildQwenInput({
    image: "data:image/jpeg;base64,aaa",
    rotateDegrees: 30.4,
    verticalTilt: 0.26,
    moveForward: 2.2,
    useWideAngle: true,
    multipleAnglesStrength: 1.26,
  });
  assert.equal(input.prompt, QWEN_PROMPT);
  assert.equal(input.aspect_ratio, "match_input_image");
  assert.equal(input.go_fast, true);
  assert.equal(input.use_multiple_angles, true);
  assert.equal(input.output_format, "png");
  assert.equal(input.rotate_degrees, 30);
  assert.equal(input.vertical_tilt, 0.3);
  assert.equal(input.move_forward, 2);
  assert.equal(input.use_wide_angle, true);
  assert.equal(input.multiple_angles_strength, 1.26);
  const parsed = validateQwenBody({
    image: "data:image/jpeg;base64,aaa",
    rotate_degrees: 120,
    vertical_tilt: -2,
    move_forward: 9,
    use_wide_angle: false,
    multiple_angles_strength: 4,
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.rotateDegrees, 90);
  assert.equal(parsed.verticalTilt, -1);
  assert.equal(parsed.moveForward, 5);
  assert.equal(parsed.useWideAngle, false);
  assert.equal(parsed.multipleAnglesStrength, 2);
  assert.equal(formatQwenError({ status: 402, payload: replicateFailure(402, "create") }), "Replicate 402: insufficient credit");
});
