/**
 * Rectangular room (cuboid) from 8 image points.
 * Back wall: TL, TR, BL, BR. Near corners, same order: ceiling-left, ceiling-right, floor-left, floor-right.
 * The output warp is a rotation about the camera center, H = K Rᵀ K⁻¹, so every face stays consistent.
 */

import { invert3x3, multiply3x3 } from "./homography.js";

export function defaultFocalLength(imageWidth, fovDegrees = 60) {
  const fov = (fovDegrees * Math.PI) / 180;
  return (imageWidth / 2) / Math.tan(fov / 2);
}

export function reconstructBox(back, near, imageWidth, imageHeight, options = {}) {
  const cx = imageWidth / 2;
  const cy = imageHeight / 2;
  const horizontal = vanishLeastSquares([
    lineThrough(back[0], back[1]),
    lineThrough(back[2], back[3]),
  ]);
  const vertical = vanishLeastSquares([
    lineThrough(back[0], back[2]),
    lineThrough(back[1], back[3]),
  ]);
  const depth = vanishLeastSquares(back.map((point, index) => lineThrough(point, near[index])));

  const focalEstimates = [
    focalFromPair(horizontal, vertical, cx, cy),
    focalFromPair(horizontal, depth, cx, cy),
    focalFromPair(vertical, depth, cx, cy),
  ].filter((value) => value != null);
  const degenerate = focalEstimates.length === 0;
  let focal = degenerate
    ? defaultFocalLength(imageWidth, 60)
    : focalEstimates.reduce((sum, value) => sum + value, 0) / focalEstimates.length;
  if (Number.isFinite(options.fovDegrees)) {
    focal = defaultFocalLength(imageWidth, options.fovDegrees);
  }

  let axes = axesFromVanishingPoints(horizontal, vertical, depth, focal, cx, cy, back);
  let size = measureBox(back, near, axes, focal, cx, cy, depth);
  const closed = {
    focal,
    axes,
    width: size.width,
    height: size.height,
    depth: size.depth,
    distance: size.distance,
    cx,
    cy,
  };
  const refined = refineBox({
    focal,
    axes,
    width: size.width,
    height: size.height,
    depth: size.depth,
    distance: size.distance,
    cx,
    cy,
  }, back, near);
  const closedError = backError(closed, back);
  const refinedError = backError(refined, back);
  const chosen = closedError <= 1 || !(refinedError < closedError * 0.85) ? closed : refined;
  focal = chosen.focal;
  axes = chosen.axes;
  size = chosen;

  const homography = frontalHomography(focal, cx, cy, axes);
  const corners = boxCorners(axes, size.distance, size.width, size.height, size.depth);
  const snapped = corners.near.map((point) => project(point, focal, cx, cy));
  return {
    H: homography,
    focal,
    fov: (2 * Math.atan((imageWidth / 2) / focal) * 180) / Math.PI,
    degenerate: degenerate && !Number.isFinite(options.fovDegrees),
    snapped,
    vanishing: { horizontal, vertical, depth },
    width: size.width,
    height: size.height,
    depth: size.depth,
    distance: size.distance,
    corners,
    wire: [...back.map((_, index) => project(corners.back[index], focal, cx, cy)),
      ...corners.near.map((point) => project(point, focal, cx, cy))],
  };
}

export function frontalHomography(focal, cx, cy, axes) {
  const K = [focal, 0, cx, 0, focal, cy, 0, 0, 1];
  const Rt = [
    axes[0][0], axes[0][1], axes[0][2],
    axes[1][0], axes[1][1], axes[1][2],
    axes[2][0], axes[2][1], axes[2][2],
  ];
  return multiply3x3(K, multiply3x3(Rt, invert3x3(K)));
}

export function snapNearCorners(back, near, depth) {
  const samples = [];
  for (let i = 0; i < 4; i++) {
    const parameter = rayParameter(back[i], depth, near[i]);
    if (parameter != null && parameter < -0.02) samples.push(parameter);
  }
  samples.sort((a, b) => a - b);
  const shared = samples.length ? samples[Math.floor(samples.length / 2)] : -0.45;
  return back.map((point) => pointOnRay(point, depth, shared));
}

function vanishLeastSquares(lines) {
  const normal = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (const line of lines) {
    const scale = Math.hypot(line[0], line[1], line[2]) || 1;
    const row = [line[0] / scale, line[1] / scale, line[2] / scale];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) normal[i][j] += row[i] * row[j];
    }
  }
  return toVanishingPoint(smallestEigenvector3(normal));
}

function toVanishingPoint(vector) {
  const norm = Math.hypot(vector[0], vector[1], vector[2]) || 1;
  if (Math.abs(vector[2] / norm) < 1e-6) {
    return { x: vector[0], y: vector[1], w: 0, atInfinity: true };
  }
  return { x: vector[0] / vector[2], y: vector[1] / vector[2], w: 1, atInfinity: false };
}

function focalFromPair(a, b, cx, cy) {
  if (!a || !b || a.atInfinity || b.atInfinity) return null;
  const value = -((a.x - cx) * (b.x - cx) + (a.y - cy) * (b.y - cy));
  if (!(value > 4)) return null;
  return Math.sqrt(value);
}

function axesFromVanishingPoints(horizontal, vertical, depth, focal, cx, cy, back) {
  let right = directionFromVanishingPoint(horizontal, focal, cx, cy);
  let down = directionFromVanishingPoint(vertical, focal, cx, cy);
  right = normalize3(right);
  down = normalize3(subtract3(down, scale3(right, dot3(down, right))));
  if (norm3(down) < 1e-6) down = [0, 1, 0];
  down = normalize3(down);
  let forward = cross3(right, down);
  const mid = {
    x: (back[0].x + back[1].x + back[2].x + back[3].x) / 4,
    y: (back[0].y + back[1].y + back[2].y + back[3].y) / 4,
  };
  if (dot3(imageDirection(mid, focal, cx, cy), forward) < 0) forward = scale3(forward, -1);
  const towardRight = subtract3(imageDirection(back[1], focal, cx, cy), imageDirection(back[0], focal, cx, cy));
  if (dot3(right, towardRight) < 0) right = scale3(right, -1);
  down = normalize3(cross3(forward, right));
  right = normalize3(cross3(down, forward));
  return [right, down, normalize3(forward)];
}

function directionFromVanishingPoint(point, focal, cx, cy) {
  if (point.atInfinity) {
    return [point.x / focal, point.y / focal, 0];
  }
  return [(point.x - cx) / focal, (point.y - cy) / focal, 1];
}

function measureBox(back, near, axes, focal, cx, cy, depthPoint) {
  const forward = axes[2];
  const distance = 1;
  const back3 = back.map((point) => rayPlane(imageDirection(point, focal, cx, cy), forward, distance));
  const width = average([distance3(back3[0], back3[1]), distance3(back3[2], back3[3])]);
  const height = average([distance3(back3[0], back3[2]), distance3(back3[1], back3[3])]);
  const depths = near.map((point, index) => {
    const foot = footOnEdge(back[index], depthPoint, point);
    return depthAlong(back3[index], forward, imageDirection(foot, focal, cx, cy));
  });
  return {
    width: Math.max(width, 1e-3),
    height: Math.max(height, 1e-3),
    depth: Math.max(median(depths.filter((value) => value > 0)), 1e-3),
    distance,
  };
}

function backError(pose, clicks) {
  const corners = boxCorners(pose.axes, pose.distance, pose.width, pose.height, pose.depth);
  let error = 0;
  for (let i = 0; i < 4; i++) {
    const projected = project(corners.back[i], pose.focal, pose.cx, pose.cy);
    error += (projected.x - clicks[i].x) ** 2 + (projected.y - clicks[i].y) ** 2;
  }
  return error;
}

function refineBox(start, backClicks, nearClicks) {
  let params = [
    Math.log(start.focal),
    0, 0, 0,
    Math.log(start.width),
    Math.log(start.height),
    Math.log(start.depth),
  ];
  let lambda = 1e-2;
  let previous = residualVector(params, start, backClicks, nearClicks);
  let best = params.slice();
  let bestCost = cost(previous);
  for (let iteration = 0; iteration < 6; iteration++) {
    const jacobian = numericJacobian(params, start, backClicks, nearClicks);
    const step = levenbergStep(jacobian, previous, lambda);
    const trial = params.map((value, index) => value + step[index]);
    const next = residualVector(trial, start, backClicks, nearClicks);
    const nextCost = cost(next);
    const focalRatio = Math.exp(trial[0]) / start.focal;
    if (nextCost < bestCost && focalRatio > 0.65 && focalRatio < 1.55) {
      params = trial;
      previous = next;
      best = trial.slice();
      bestCost = nextCost;
      lambda = Math.max(1e-5, lambda * 0.4);
    } else {
      lambda = Math.min(1e3, lambda * 6);
    }
  }
  const pose = poseFrom(best, start);
  return {
    focal: pose.focal,
    axes: pose.axes,
    width: pose.width,
    height: pose.height,
    depth: pose.depth,
    distance: start.distance,
    cx: start.cx,
    cy: start.cy,
  };
}

function residualVector(params, start, backClicks, nearClicks) {
  const pose = poseFrom(params, start);
  const corners = boxCorners(pose.axes, start.distance, pose.width, pose.height, pose.depth);
  const residuals = [];
  for (let i = 0; i < 4; i++) {
    const projected = project(corners.back[i], pose.focal, start.cx, start.cy);
    residuals.push(projected.x - backClicks[i].x, projected.y - backClicks[i].y);
  }
  for (let i = 0; i < 4; i++) {
    const backPoint = project(corners.back[i], pose.focal, start.cx, start.cy);
    const nearPoint = project(corners.near[i], pose.focal, start.cx, start.cy);
    residuals.push(pointLineDistance(nearClicks[i], backPoint, nearPoint));
  }
  return residuals;
}

function numericJacobian(params, start, backClicks, nearClicks) {
  const base = residualVector(params, start, backClicks, nearClicks);
  const columns = [];
  for (let index = 0; index < params.length; index++) {
    const step = Math.max(1e-5, Math.abs(params[index]) * 1e-4);
    const trial = params.slice();
    trial[index] += step;
    const next = residualVector(trial, start, backClicks, nearClicks);
    columns.push(next.map((value, row) => (value - base[row]) / step));
  }
  return { base, columns };
}

function levenbergStep(jacobian, residuals, lambda) {
  const n = jacobian.columns.length;
  const normal = Array.from({ length: n }, () => new Array(n).fill(0));
  const right = new Array(n).fill(0);
  for (let column = 0; column < n; column++) {
    for (let row = 0; row < residuals.length; row++) {
      right[column] += jacobian.columns[column][row] * residuals[row];
    }
    for (let other = 0; other < n; other++) {
      let sum = 0;
      for (let row = 0; row < residuals.length; row++) {
        sum += jacobian.columns[column][row] * jacobian.columns[other][row];
      }
      normal[column][other] = sum;
    }
    normal[column][column] += lambda * (Math.abs(normal[column][column]) + 1e-4);
  }
  return solveLinear(normal, right.map((value) => -value));
}

function poseFrom(params, start) {
  const delta = rodrigues(params[1], params[2], params[3]);
  return {
    focal: Math.exp(params[0]),
    axes: multiplyAxes(delta, start.axes),
    width: Math.exp(params[4]),
    height: Math.exp(params[5]),
    depth: Math.exp(params[6]),
  };
}

function boxCorners(axes, distance, width, height, depth) {
  const [right, down, forward] = axes;
  const center = scale3(forward, distance);
  const signs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const back = signs.map(([sx, sy]) => add3(center, add3(scale3(right, sx * width / 2), scale3(down, sy * height / 2))));
  const near = back.map((point) => add3(point, scale3(forward, -depth)));
  return { back, near };
}

function project(point, focal, cx, cy) {
  return {
    x: cx + (focal * point[0]) / point[2],
    y: cy + (focal * point[1]) / point[2],
  };
}

function imageDirection(point, focal, cx, cy) {
  return [(point.x - cx) / focal, (point.y - cy) / focal, 1];
}

function rayPlane(direction, normal, distance) {
  const scale = distance / dot3(direction, normal);
  return scale3(direction, scale);
}

function depthAlong(backPoint, forward, nearDirection) {
  const towardCamera = scale3(forward, -1);
  const scale = solveRayScale(backPoint, towardCamera, nearDirection);
  return scale == null ? 0 : Math.abs(scale);
}

function solveRayScale(origin, direction, ray) {
  const columns = [direction, scale3(ray, -1)];
  const right = scale3(origin, -1);
  const normal = [[0, 0], [0, 0]];
  const rhs = [0, 0];
  for (let row = 0; row < 3; row++) {
    for (let i = 0; i < 2; i++) {
      rhs[i] += columns[i][row] * right[row];
      for (let j = 0; j < 2; j++) normal[i][j] += columns[i][row] * columns[j][row];
    }
  }
  const det = normal[0][0] * normal[1][1] - normal[0][1] * normal[1][0];
  if (Math.abs(det) < 1e-12) return null;
  const scale = (rhs[0] * normal[1][1] - normal[0][1] * rhs[1]) / det;
  return Number.isFinite(scale) ? Math.abs(scale) : null;
}

function footOnEdge(back, vanishing, click) {
  const parameter = rayParameter(back, vanishing, click);
  if (parameter == null) return click;
  return pointOnRay(back, vanishing, parameter);
}

function rayParameter(back, vanishing, click) {
  const direction = vanishing.atInfinity
    ? [vanishing.x, vanishing.y]
    : [vanishing.x - back.x, vanishing.y - back.y];
  const length2 = direction[0] * direction[0] + direction[1] * direction[1];
  if (length2 < 1e-8) return null;
  return ((click.x - back.x) * direction[0] + (click.y - back.y) * direction[1]) / length2;
}

function pointOnRay(back, vanishing, parameter) {
  if (vanishing.atInfinity) {
    return { x: back.x + vanishing.x * parameter, y: back.y + vanishing.y * parameter };
  }
  return {
    x: back.x + (vanishing.x - back.x) * parameter,
    y: back.y + (vanishing.y - back.y) * parameter,
  };
}

function pointLineDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy) || 1;
  return ((point.x - start.x) * dy - (point.y - start.y) * dx) / length;
}

function lineThrough(start, end) {
  return cross2([start.x, start.y, 1], [end.x, end.y, 1]);
}

function cross2(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function smallestEigenvector3(matrix) {
  const A = matrix.map((row) => row.slice());
  const V = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 16; sweep++) {
    let p = 0;
    let q = 1;
    let max = Math.abs(A[0][1]);
    if (Math.abs(A[0][2]) > max) {
      p = 0; q = 2; max = Math.abs(A[0][2]);
    }
    if (Math.abs(A[1][2]) > max) {
      p = 1; q = 2; max = Math.abs(A[1][2]);
    }
    if (max < 1e-14) break;
    const app = A[p][p];
    const aqq = A[q][q];
    const apq = A[p][q];
    const tau = (aqq - app) / (2 * apq || 1e-15);
    const tangent = Math.sign(tau) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const cosine = 1 / Math.sqrt(1 + tangent * tangent);
    const sine = tangent * cosine;
    const next = A.map((row) => row.slice());
    for (let k = 0; k < 3; k++) {
      if (k === p || k === q) continue;
      next[k][p] = next[p][k] = cosine * A[k][p] - sine * A[k][q];
      next[k][q] = next[q][k] = sine * A[k][p] + cosine * A[k][q];
    }
    next[p][p] = cosine * cosine * app - 2 * sine * cosine * apq + sine * sine * aqq;
    next[q][q] = sine * sine * app + 2 * sine * cosine * apq + cosine * cosine * aqq;
    next[p][q] = next[q][p] = 0;
    for (let k = 0; k < 3; k++) {
      const vip = V[k][p];
      const viq = V[k][q];
      V[k][p] = cosine * vip - sine * viq;
      V[k][q] = sine * vip + cosine * viq;
    }
    for (let r = 0; r < 3; r++) A[r] = next[r];
  }
  let index = 0;
  if (A[1][1] < A[index][index]) index = 1;
  if (A[2][2] < A[index][index]) index = 2;
  return normalize3([V[0][index], V[1][index], V[2][index]]);
}

function rodrigues(x, y, z) {
  const theta = Math.hypot(x, y, z);
  if (theta < 1e-12) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const kx = x / theta;
  const ky = y / theta;
  const kz = z / theta;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const v = 1 - c;
  return [
    [c + kx * kx * v, kx * ky * v - kz * s, kx * kz * v + ky * s],
    [ky * kx * v + kz * s, c + ky * ky * v, ky * kz * v - kx * s],
    [kz * kx * v - ky * s, kz * ky * v + kx * s, c + kz * kz * v],
  ];
}

function multiplyAxes(rotation, axes) {
  return axes.map((axis) => {
    const x = rotation[0][0] * axis[0] + rotation[0][1] * axis[1] + rotation[0][2] * axis[2];
    const y = rotation[1][0] * axis[0] + rotation[1][1] * axis[1] + rotation[1][2] * axis[2];
    const z = rotation[2][0] * axis[0] + rotation[2][1] * axis[1] + rotation[2][2] * axis[2];
    return normalize3([x, y, z]);
  });
}

function solveLinear(matrix, vector) {
  const n = vector.length;
  const A = matrix.map((row, index) => row.concat(vector[index]));
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
    }
    const swap = A[col];
    A[col] = A[pivot];
    A[pivot] = swap;
    const div = A[col][col] || 1e-12;
    for (let j = col; j <= n; j++) A[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = A[row][col];
      for (let j = col; j <= n; j++) A[row][j] -= factor * A[col][j];
    }
  }
  return A.map((row) => row[n]);
}

function cost(residual) {
  return residual.reduce((sum, value) => sum + value * value, 0);
}

function add3(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function subtract3(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale3(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm3(a) { return Math.hypot(a[0], a[1], a[2]); }
function normalize3(a) {
  const n = norm3(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
}
function distance3(a, b) { return norm3(subtract3(a, b)); }
function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
