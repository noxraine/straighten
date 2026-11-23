import test from "node:test";
import assert from "node:assert/strict";
import { applyHomography } from "../homography.js";
import { fitRoomFrame, layoutRoom, reconstructBox } from "../room3d.js";

function closeTo(actual, expected, epsilon, label) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${label}: ${actual} vs ${expected}`);
}

function rotate(yaw, pitch) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const right = [cy, 0, -sy];
  const down = [sy * sp, cp, cy * sp];
  const forward = [sy * cp, -sp, cy * cp];
  return [right, down, forward];
}

function project(point, focal, cx, cy) {
  return { x: cx + (focal * point[0]) / point[2], y: cy + (focal * point[1]) / point[2] };
}

function makeRoom(focal, width, height, yaw, pitch, shiftX = 0, shiftY = 0, cx = width / 2, cy = height / 2) {
  const axes = rotate(yaw, pitch);
  const [right, down, forward] = axes;
  const wallW = 4;
  const wallH = 3;
  const depth = 5;
  const distance = 8;
  const center = [
    forward[0] * distance + right[0] * shiftX + down[0] * shiftY,
    forward[1] * distance + right[1] * shiftX + down[1] * shiftY,
    forward[2] * distance + right[2] * shiftX + down[2] * shiftY,
  ];
  const signs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
  const back3 = signs.map(([sx, sy]) => [
    center[0] + right[0] * sx * wallW / 2 + down[0] * sy * wallH / 2,
    center[1] + right[1] * sx * wallW / 2 + down[1] * sy * wallH / 2,
    center[2] + right[2] * sx * wallW / 2 + down[2] * sy * wallH / 2,
  ]);
  const near3 = back3.map((point) => [
    point[0] - forward[0] * depth,
    point[1] - forward[1] * depth,
    point[2] - forward[2] * depth,
  ]);
  if (near3.some((point) => point[2] <= 0.4) || back3.some((point) => point[2] <= 0.4)) return null;
  return {
    back: back3.map((point) => project(point, focal, cx, cy)),
    near: near3.map((point) => project(point, focal, cx, cy)),
    proportions: [wallW / wallH, depth / wallH],
    focal,
  };
}

function slideAlong(back, near, amount) {
  return near.map((point, index) => ({
    x: back[index].x + (point.x - back[index].x) * amount,
    y: back[index].y + (point.y - back[index].y) * amount,
  }));
}

test("a noisy cuboid recovers focal length, proportions, and a rectangular back wall", () => {
  const width = 1280;
  const height = 800;
  const room = makeRoom(900, width, height, 0.28, 0.16);
  const noisyNear = room.near.map((point, index) => ({
    x: point.x + (index - 1.5) * 1.5,
    y: point.y + (index % 2 ? 2 : -1.2),
  }));
  const slid = slideAlong(room.back, noisyNear, 0.72);
  const model = reconstructBox(room.back, slid, width, height);
  closeTo(model.focal, room.focal, 180, "focal");
  closeTo(model.width / model.height, room.proportions[0], 0.25, "width/height");
  closeTo(model.depth / model.height, room.proportions[1], 0.45, "depth/height");
  assertFrontal(layoutRoom(model), model);
});

test("an exact cuboid keeps the back wall rectangular after the frontal layout", () => {
  const room = makeRoom(900, 1280, 800, 0.28, 0.16);
  const model = reconstructBox(room.back, room.near, 1280, 800);
  closeTo(model.focal, 900, 15, "focal");
  closeTo(model.width / model.height, 4 / 3, 0.05, "width/height");
  closeTo(model.depth / model.height, 5 / 3, 0.08, "depth/height");
  assertFrontal(layoutRoom(model), model);
});

test("the fitted frame stays on the near opening", () => {
  const room = makeRoom(900, 1280, 800, 0.35, -0.2, 0.6, -0.4, 700, 360);
  const model = reconstructBox(room.back, slideAlong(room.back, room.near, 0.7), 1280, 800);
  const layout = layoutRoom(model);
  const fit = fitRoomFrame(layout, model, 1280, 800);
  const nearW = layout.halfW * layout.factor * 2;
  const nearH = layout.halfH * layout.factor * 2;
  assert.ok(fit.spanX < nearW * 2.6, `spanX ${fit.spanX} vs near ${nearW}`);
  assert.ok(fit.spanY < nearH * 2.6, `spanY ${fit.spanY} vs near ${nearH}`);
  assert.ok(fit.originX <= layout.near[0].x + 1);
  assert.ok(fit.originY <= layout.near[0].y + 1);
});

test("off-center, noisy, edge-slid rooms stay rectangular with a vertical floor axis", () => {
  const rand = mulberry32(20261123);
  let checked = 0;
  for (let n = 0; n < 48 && checked < 12; n++) {
    const yaw = (rand() - 0.5) * 0.9;
    const pitch = (rand() - 0.5) * 0.55;
    const shiftX = (rand() - 0.5) * 1.6;
    const shiftY = (rand() - 0.5) * 1.1;
    const cx = 640 + (rand() - 0.5) * 180;
    const cy = 400 + (rand() - 0.5) * 120;
    const room = makeRoom(900, 1280, 800, yaw, pitch, shiftX, shiftY, cx, cy);
    if (!room) continue;
    const noisy = room.near.map((point, index) => ({
      x: point.x + (rand() - 0.5) * 6,
      y: point.y + (rand() - 0.5) * 6,
    }));
    const slid = slideAlong(room.back, noisy, 0.45 + rand() * 0.4);
    let model;
    try {
      model = reconstructBox(room.back, slid, 1280, 800);
    } catch {
      continue;
    }
    if (!model.wire.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y))) continue;
    let layout;
    try {
      layout = layoutRoom(model);
    } catch {
      continue;
    }
    assertFrontal(layout, model);
    const wider = layoutRoom(model, { fovDegrees: 85 });
    closeTo(wider.back[0].x, layout.back[0].x, 1e-9, "fov leaves the back wall");
    closeTo(wider.back[0].y, layout.back[0].y, 1e-9, "fov leaves the back wall");
    assert.ok(Math.abs(wider.factor - layout.factor) > 1e-3);
    checked += 1;
  }
  assert.ok(checked >= 8, `only ${checked} rooms could be checked`);
});

function assertFrontal(layout, model) {
  const back = model.wire.slice(0, 4).map((point) => applyHomography(layout.faces.back.H, point.x, point.y));
  closeTo(back[0].x, back[2].x, 1e-6, "left vertical");
  closeTo(back[1].x, back[3].x, 1e-6, "right vertical");
  closeTo(back[0].y, back[1].y, 1e-6, "top horizontal");
  closeTo(back[2].y, back[3].y, 1e-6, "bottom horizontal");
  assert.ok(back[1].x > back[0].x);
  assert.ok(back[2].y > back[0].y);

  const floor = layout.faces.floor.H;
  const bottomLeft = applyHomography(floor, model.wire[2].x, model.wire[2].y);
  const bottomRight = applyHomography(floor, model.wire[3].x, model.wire[3].y);
  const nearLeft = applyHomography(floor, model.wire[6].x, model.wire[6].y);
  const nearRight = applyHomography(floor, model.wire[7].x, model.wire[7].y);
  const backMid = (bottomLeft.x + bottomRight.x) / 2;
  const nearMid = (nearLeft.x + nearRight.x) / 2;
  closeTo(backMid, nearMid, 1e-6, "floor axis");
  assert.ok(nearLeft.y > bottomLeft.y);

  const seams = [
    ["back", "floor", 2, 3],
    ["back", "ceiling", 0, 1],
    ["back", "left", 0, 2],
    ["back", "right", 1, 3],
    ["floor", "left", 2, 6],
    ["floor", "right", 3, 7],
    ["ceiling", "left", 0, 4],
    ["ceiling", "right", 1, 5],
  ];
  for (const [a, b, i, j] of seams) {
    const p = layout.targets[i];
    const q = layout.targets[j];
    for (const t of [0.25, 0.5, 0.75]) {
      const x = p.x + (q.x - p.x) * t;
      const y = p.y + (q.y - p.y) * t;
      const left = applyHomography(layout.faces[a].Hinv, x, y);
      const right = applyHomography(layout.faces[b].Hinv, x, y);
      closeTo(left.x, right.x, 1e-6, `${a}/${b} seam x`);
      closeTo(left.y, right.y, 1e-6, `${a}/${b} seam y`);
    }
  }
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
