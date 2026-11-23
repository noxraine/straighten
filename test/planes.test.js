import test from "node:test";
import assert from "node:assert/strict";
import { applyHomography } from "../homography.js";
import { blendMasked, floorHomography, polygonMask, sideHomography } from "../planes.js";

const wall = [
  { x: 100, y: 80 },
  { x: 400, y: 90 },
  { x: 90, y: 300 },
  { x: 420, y: 310 },
];

function closeTo(actual, expected, epsilon, label) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} vs ${expected}`);
}

test("floor far edge sits on the rectified wall bottom and the near edge is symmetric", () => {
  const floor = [
    { x: 40, y: 480 },
    { x: 500, y: 490 },
    { x: 90, y: 300 },
    { x: 420, y: 310 },
  ];
  const { H, destination } = floorHomography(wall, floor, 300, 200);
  const farLeft = applyHomography(H, floor[2].x, floor[2].y);
  const farRight = applyHomography(H, floor[3].x, floor[3].y);
  const nearLeft = applyHomography(H, floor[0].x, floor[0].y);
  const nearRight = applyHomography(H, floor[1].x, floor[1].y);
  closeTo(farLeft.x, 0, 0.05, "far left x");
  closeTo(farLeft.y, 200, 0.05, "far left y");
  closeTo(farRight.x, 300, 0.05, "far right x");
  closeTo(farRight.y, 200, 0.05, "far right y");
  closeTo(nearLeft.y, nearRight.y, 0.05, "near edge level");
  closeTo((nearLeft.x + nearRight.x) / 2, 150, 0.05, "near edge centered");
  assert.ok(nearLeft.y > 200);
  assert.ok(destination[0].x < destination[1].x);
});

test("two side points share an edge with the main wall", () => {
  const outer = [
    { x: 20, y: 70 },
    { x: 15, y: 320 },
  ];
  const { H, side } = sideHomography(wall, outer, 300, 200);
  assert.equal(side, "left");
  const sharedTop = applyHomography(H, wall[0].x, wall[0].y);
  const sharedBottom = applyHomography(H, wall[2].x, wall[2].y);
  closeTo(sharedTop.x, 0, 0.05, "shared top x");
  closeTo(sharedTop.y, 0, 0.05, "shared top y");
  closeTo(sharedBottom.x, 0, 0.05, "shared bottom x");
  closeTo(sharedBottom.y, 200, 0.05, "shared bottom y");
  const outerTop = applyHomography(H, outer[0].x, outer[0].y);
  assert.ok(outerTop.x < 0);
  closeTo(outerTop.y, 0, 0.05, "outer top y");
});

test("polygon mask fills the interior and blendMasked respects it", () => {
  const mask = polygonMask(12, 10, [
    { x: 2, y: 2 },
    { x: 9, y: 2 },
    { x: 9, y: 7 },
    { x: 2, y: 7 },
  ], 0);
  assert.equal(mask[4 * 12 + 5], 255);
  assert.equal(mask[0], 0);
  const soft = polygonMask(12, 10, [
    { x: 1, y: 1 },
    { x: 10, y: 1 },
    { x: 10, y: 8 },
    { x: 1, y: 8 },
  ], 2);
  assert.ok(soft[4 * 12 + 5] === 255);
  assert.ok(soft[1 * 12 + 1] > 0 && soft[1 * 12 + 1] < 255);

  const base = new Uint8ClampedArray([0, 0, 255, 255]);
  const overlay = new Uint8ClampedArray([255, 0, 0, 255]);
  const covered = blendMasked(base, overlay, new Uint8ClampedArray([255]));
  assert.equal(covered[0], 255);
  const open = blendMasked(base, overlay, new Uint8ClampedArray([0]));
  assert.equal(open[2], 255);
});
