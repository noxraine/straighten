import test from "node:test";
import assert from "node:assert/strict";
import {
  HomographyError,
  applyHomography,
  invert3x3,
  measureQuad,
  multiply3x3,
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

function lineIntersection(a, b, c, d) {
  const den = (a.x - b.x) * (c.y - d.y) - (a.y - b.y) * (c.x - d.x);
  const t = ((a.x - c.x) * (c.y - d.y) - (a.y - c.y) * (c.x - d.x)) / den;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}
