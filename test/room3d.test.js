import test from "node:test";
import assert from "node:assert/strict";
import { applyHomography } from "../homography.js";
import { reconstructBox } from "../room3d.js";

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

function makeRoom(focal, width, height, yaw, pitch) {
  const cx = width / 2;
  const cy = height / 2;
  const axes = rotate(yaw, pitch);
  const [right, down, forward] = axes;
  const wallW = 4;
  const wallH = 3;
  const depth = 5;
  const distance = 8;
  const center = [forward[0] * distance, forward[1] * distance, forward[2] * distance];
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

  const projected = room.back.map((point) => applyHomography(model.H, point.x, point.y));
  closeTo(projected[0].x, projected[2].x, 20, "left vertical");
  closeTo(projected[1].x, projected[3].x, 20, "right vertical");
  closeTo(projected[0].y, projected[1].y, 20, "top horizontal");
  closeTo(projected[2].y, projected[3].y, 20, "bottom horizontal");
  assert.ok(projected[2].y > projected[0].y);
  assert.ok(projected[1].x > projected[0].x);
});

test("an exact cuboid keeps the back wall rectangular after the frontal rotation", () => {
  const room = makeRoom(900, 1280, 800, 0.28, 0.16);
  const model = reconstructBox(room.back, room.near, 1280, 800);
  closeTo(model.focal, 900, 15, "focal");
  closeTo(model.width / model.height, 4 / 3, 0.05, "width/height");
  closeTo(model.depth / model.height, 5 / 3, 0.08, "depth/height");
  const projected = room.back.map((point) => applyHomography(model.H, point.x, point.y));
  closeTo(projected[0].x, projected[2].x, 1.5, "left vertical");
  closeTo(projected[1].x, projected[3].x, 1.5, "right vertical");
  closeTo(projected[0].y, projected[1].y, 1.5, "top horizontal");
  closeTo(projected[2].y, projected[3].y, 1.5, "bottom horizontal");
});
