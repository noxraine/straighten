import test from "node:test";
import assert from "node:assert/strict";
import {
  HomographyError,
  applyHomography,
  blendTowardIdentity,
  fitFrame,
  invert3x3,
  maxInscribedRect,
  measureQuad,
  multiply3x3,
  placeOnFrame,
  planRectangle,
  quadProblem,
  rectangleTargets,
  solveHomography,
  transformedImageBounds,
} from "../homography.js";

function closeTo(actual, expected, epsilon, label) {
  assert.ok(
    Math.abs(actual - expected) <= epsilon,
    `${label}: ${actual} not within ${epsilon} of ${expected}`,
  );
}

function pointsClose(actual, expected, epsilon) {
  closeTo(actual.x, expected.x, epsilon, "x");
  closeTo(actual.y, expected.y, epsilon, "y");
}

test("invert3x3 undoes multiply", () => {
  const A = [1.2, -0.4, 3, 0.2, 2, -1, 0.01, -0.02, 1];
  const I = multiply3x3(A, invert3x3(A));
  for (let i = 0; i < 9; i++) {
    const expect = i % 4 === 0 ? 1 : 0;
    closeTo(I[i], expect, 1e-9, `I[${i}]`);
  }
});

test("applyHomography translates", () => {
  const H = [1, 0, 40, 0, 1, -15, 0, 0, 1];
  pointsClose(applyHomography(H, 10, 25), { x: 50, y: 10 }, 1e-9);
});

test("solveHomography recovers a scale and translation", () => {
  const src = [
    { x: 10, y: 20 },
    { x: 110, y: 20 },
    { x: 10, y: 70 },
    { x: 110, y: 70 },
  ];
  const dst = src.map((p) => ({ x: p.x * 2 + 5, y: p.y * 2 - 8 }));
  const H = solveHomography(src, dst);
  for (const p of [...src, { x: 40, y: 45 }, { x: 90, y: 60 }]) {
    pointsClose(applyHomography(H, p.x, p.y), { x: p.x * 2 + 5, y: p.y * 2 - 8 }, 1e-4);
  }
  const back = invert3x3(H);
  pointsClose(applyHomography(back, 25, 32), { x: 10, y: 20 }, 1e-4);
});

test("solveHomography maps a skewed quad onto a rectangle", () => {
  const src = [
    { x: 80, y: 40 },
    { x: 360, y: 70 },
    { x: 50, y: 280 },
    { x: 390, y: 310 },
  ];
  const width = 500;
  const height = 320;
  const dst = rectangleTargets(width, height);
  const H = solveHomography(src, dst);

  pointsClose(applyHomography(H, src[0].x, src[0].y), dst[0], 1e-3);
  pointsClose(applyHomography(H, src[1].x, src[1].y), dst[1], 1e-3);
  pointsClose(applyHomography(H, src[2].x, src[2].y), dst[2], 1e-3);
  pointsClose(applyHomography(H, src[3].x, src[3].y), dst[3], 1e-3);

  const crossing = lineIntersection(src[0], src[3], src[1], src[2]);
  pointsClose(applyHomography(H, crossing.x, crossing.y), { x: width / 2, y: height / 2 }, 1e-2);
});

test("solveHomography recovers a projective map, up to sampling points", () => {
  const Htrue = [1.35, 0.18, -40, -0.08, 1.12, 55, 0.00035, -0.00022, 1];
  const src = [
    { x: 0, y: 0 },
    { x: 800, y: 0 },
    { x: 0, y: 600 },
    { x: 800, y: 600 },
  ];
  const dst = src.map((p) => applyHomography(Htrue, p.x, p.y));
  const H = solveHomography(src, dst);
  const probes = [...src, { x: 200, y: 150 }, { x: 640, y: 480 }, { x: 400, y: 300 }];
  for (const p of probes) {
    pointsClose(applyHomography(H, p.x, p.y), applyHomography(Htrue, p.x, p.y), 1e-3);
  }
});

test("solveHomography rejects collinear corners", () => {
  const src = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 20, y: 0 },
    { x: 30, y: 0 },
  ];
  const dst = rectangleTargets(10, 10);
  assert.throws(() => solveHomography(src, dst), HomographyError);
});

test("measureQuad averages opposite edges", () => {
  const quad = [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 0, y: 100 },
    { x: 200, y: 100 },
  ];
  const edges = measureQuad(quad);
  closeTo(edges.width, 200, 1e-9, "width");
  closeTo(edges.height, 100, 1e-9, "height");
  closeTo(edges.top, 200, 1e-9, "top");
  closeTo(edges.left, 100, 1e-9, "left");
});

test("planRectangle uses edge lengths, then real-world sizes", () => {
  const quad = [
    { x: 0, y: 0 },
    { x: 400, y: 0 },
    { x: 0, y: 200 },
    { x: 400, y: 200 },
  ];
  const estimated = planRectangle(quad);
  closeTo(estimated.aspect, 2, 1e-9, "estimated aspect");
  closeTo(estimated.width / estimated.height, 2, 0.01, "pixel aspect");
  assert.equal(estimated.measured, false);

  const measured = planRectangle(quad, 3.2, 2.4);
  closeTo(measured.aspect, 3.2 / 2.4, 1e-12, "measured aspect");
  closeTo(measured.width / measured.height, 3.2 / 2.4, 0.01, "locked pixel aspect");
  assert.equal(measured.measured, true);
  const edgeArea = 400 * 200;
  const pixelArea = measured.width * measured.height;
  assert.ok(pixelArea > edgeArea * 0.5 && pixelArea < edgeArea * 2);
});

test("quadProblem reports crossed and collapsed corners", () => {
  const fine = [
    { x: 10, y: 10 },
    { x: 200, y: 20 },
    { x: 15, y: 180 },
    { x: 210, y: 190 },
  ];
  assert.equal(quadProblem(fine), null);
  const crossed = [
    { x: 10, y: 10 },
    { x: 200, y: 180 },
    { x: 10, y: 180 },
    { x: 200, y: 10 },
  ];
  assert.match(quadProblem(crossed), /cross/i);
  const stacked = [
    { x: 10, y: 10 },
    { x: 10.2, y: 10.1 },
    { x: 10, y: 40 },
    { x: 40, y: 40 },
  ];
  assert.ok(quadProblem(stacked));
});

test("transformedImageBounds doubles under a scale of two", () => {
  const H = [2, 0, 0, 0, 2, 0, 0, 0, 1];
  const bounds = transformedImageBounds(H, 100, 50, 40, 20);
  closeTo(bounds.minX, 0, 1e-6, "minX");
  closeTo(bounds.minY, 0, 1e-6, "minY");
  closeTo(bounds.width, 200, 1e-6, "width");
  closeTo(bounds.height, 100, 1e-6, "height");
});

test("transformedImageBounds returns null when a corner is at infinity", () => {
  const H = [1, 0, 0, 0, 1, 0, 0, 0.02, 0];
  const bounds = transformedImageBounds(H, 100, 50, 100, 50);
  assert.equal(bounds, null);
});

test("fitFrame keeps every source corner inside the output", () => {
  const srcW = 200;
  const srcH = 120;
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const fitted = fitFrame(identity, srcW, srcH);
  assert.equal(fitted.clamped, false);
  closeTo(fitted.spanX, srcW + 2, 1e-6, "spanX");
  closeTo(fitted.spanY, srcH + 2, 1e-6, "spanY");
  assertCornersInside(identity, srcW, srcH, fitted);

  const shifted = [1, 0, 30, 0, 1, -12, 0, 0, 1];
  const moved = fitFrame(shifted, srcW, srcH);
  assert.equal(moved.clamped, false);
  closeTo(moved.spanX, srcW + 2, 1e-6, "shifted spanX");
  closeTo(moved.spanY, srcH + 2, 1e-6, "shifted spanY");
  assertCornersInside(shifted, srcW, srcH, moved);
});

test("fitFrame scales uniformly when the corrected photo is larger than maxEdge", () => {
  const H = [4, 0, 0, 0, 4, 0, 0, 0, 1];
  const fit = fitFrame(H, 100, 40, { maxEdge: 80 });
  assert.ok(fit.width <= 80, `width ${fit.width}`);
  assert.ok(fit.height <= 80, `height ${fit.height}`);
  const scaleX = fit.width / fit.spanX;
  const scaleY = fit.height / fit.spanY;
  closeTo(scaleX, scaleY, 0.02, "uniform scale");
  closeTo(scaleX, fit.uniformScale, 0.02, "stored scale");
  assert.ok(fit.uniformScale < 1);
  assertCornersInside(H, 100, 40, fit);
});

test("fitFrame holds a corner that falls behind the horizon", () => {
  const H = [1, 0, 0, 0, 1, 0, 0, 0.02, -0.5];
  const srcW = 100;
  const srcH = 80;
  const behind = applyHomography(H, 0, 0);
  assert.ok(!Number.isFinite(behind.x) || H[6] * 0 + H[7] * 0 + H[8] <= 0);
  const fit = fitFrame(H, srcW, srcH);
  assert.equal(fit.clamped, true);
  assert.ok(Number.isFinite(fit.width) && Number.isFinite(fit.height));
  assert.ok(fit.width < 5000 && fit.height < 5000, `${fit.width}x${fit.height}`);
  for (const point of fit.corners) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
});

test("a frontal correction of a quad still contains the whole photo", () => {
  const srcW = 480;
  const srcH = 320;
  const quad = [
    { x: 80, y: 50 },
    { x: 390, y: 70 },
    { x: 60, y: 250 },
    { x: 410, y: 280 },
  ];
  const rect = planRectangle(quad);
  const H = solveHomography(quad, rectangleTargets(rect.width, rect.height));
  const fit = fitFrame(H, srcW, srcH);
  assert.equal(fit.clamped, false);
  assertCornersInside(H, srcW, srcH, fit);
  assert.ok(fit.width * fit.height > rect.width * rect.height * 0.5);
});

test("correction strength blends the homography toward identity", () => {
  const H = [2, 0, 0, 0, 2, 0, 0, 0, 1];
  pointsClose(applyHomography(blendTowardIdentity(H, 0), 10, 4), { x: 10, y: 4 }, 1e-9);
  pointsClose(applyHomography(blendTowardIdentity(H, 1), 10, 4), { x: 20, y: 8 }, 1e-9);
  pointsClose(applyHomography(blendTowardIdentity(H, 0.5), 10, 4), { x: 15, y: 6 }, 1e-9);

  const quad = [
    { x: 20, y: 20 },
    { x: 180, y: 30 },
    { x: 15, y: 140 },
    { x: 190, y: 150 },
  ];
  const solved = solveHomography(quad, rectangleTargets(160, 100));
  const half = blendTowardIdentity(solved, 0.5);
  const full = applyHomography(solved, quad[1].x, quad[1].y);
  const eased = applyHomography(half, quad[1].x, quad[1].y);
  const fullShift = Math.hypot(full.x - quad[1].x, full.y - quad[1].y);
  const easedShift = Math.hypot(eased.x - quad[1].x, eased.y - quad[1].y);
  assert.ok(easedShift < fullShift, `eased ${easedShift} full ${fullShift}`);
});

test("max inscribed rectangle fills an axis-aligned quad and a diamond", () => {
  const square = maxInscribedRect([
    { x: 0, y: 0 },
    { x: 4, y: 0 },
    { x: 4, y: 2 },
    { x: 0, y: 2 },
  ]);
  closeTo(square.x, 0, 0.05, "square x");
  closeTo(square.y, 0, 0.05, "square y");
  closeTo(square.width, 4, 0.08, "square w");
  closeTo(square.height, 2, 0.08, "square h");
  closeTo(square.area, 8, 0.2, "square area");

  const diamond = maxInscribedRect([
    { x: 0, y: -1 },
    { x: 1, y: 0 },
    { x: 0, y: 1 },
    { x: -1, y: 0 },
  ]);
  closeTo(diamond.area, 1, 0.08, "diamond area");
  closeTo(diamond.width, 1, 0.08, "diamond w");
  closeTo(diamond.height, 1, 0.08, "diamond h");
  closeTo(diamond.x, -0.5, 0.08, "diamond x");
  closeTo(diamond.y, -0.5, 0.08, "diamond y");

  const triangle = maxInscribedRect([
    { x: 0, y: 0 },
    { x: 2, y: 0 },
    { x: 1, y: 2 },
  ]);
  closeTo(triangle.area, 1, 0.08, "triangle area");
  closeTo(triangle.width, 1, 0.1, "triangle w");
  closeTo(triangle.height, 1, 0.1, "triangle h");
  assert.ok(triangle.y >= -0.02 && triangle.y < 0.15);
});

function assertCornersInside(H, srcW, srcH, fit) {
  const corners = [
    [0, 0],
    [srcW, 0],
    [srcW, srcH],
    [0, srcH],
  ];
  for (const [x, y] of corners) {
    const mapped = applyHomography(H, x, y);
    const placed = placeOnFrame(fit, mapped.x, mapped.y);
    assert.ok(placed.x >= -0.6 && placed.x <= fit.width + 0.6, `x ${placed.x} of ${fit.width}`);
    assert.ok(placed.y >= -0.6 && placed.y <= fit.height + 0.6, `y ${placed.y} of ${fit.height}`);
  }
}

function lineIntersection(a, b, c, d) {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}
