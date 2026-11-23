/**
 * Extra room planes that share edges with the rectified back wall.
 * Wall corners are TL, TR, BL, BR and map to (0,0)-(wallWidth, wallHeight).
 * Floor points are near-left, near-right, far-left, far-right.
 * Side points are outer-top, outer-bottom, and optionally shared-top, shared-bottom.
 */

import { applyHomography, solveHomography } from "./homography.js";

export function floorHomography(wallQuad, floorPoints, wallWidth, wallHeight) {
  const Hwall = solveHomography(wallQuad, wallTarget(wallWidth, wallHeight));
  const nearLeft = applyHomography(Hwall, floorPoints[0].x, floorPoints[0].y);
  const nearRight = applyHomography(Hwall, floorPoints[1].x, floorPoints[1].y);
  const center = wallWidth / 2;
  const yNear = Math.max((nearLeft.y + nearRight.y) / 2, wallHeight + Math.max(8, wallHeight * 0.08));
  const half = Math.max(Math.abs(nearLeft.x - center), Math.abs(nearRight.x - center), wallWidth / 2);
  const destination = [
    { x: center - half, y: yNear },
    { x: center + half, y: yNear },
    { x: 0, y: wallHeight },
    { x: wallWidth, y: wallHeight },
  ];
  return {
    H: solveHomography(floorPoints, destination),
    destination,
  };
}

export function sideHomography(wallQuad, sidePoints, wallWidth, wallHeight) {
  const Hwall = solveHomography(wallQuad, wallTarget(wallWidth, wallHeight));
  const wallMidX = (wallQuad[0].x + wallQuad[1].x + wallQuad[2].x + wallQuad[3].x) / 4;
  const outerMidX = (sidePoints[0].x + sidePoints[1].x) / 2;
  const onLeft = outerMidX < wallMidX;
  const top = applyHomography(Hwall, sidePoints[0].x, sidePoints[0].y);
  const bottom = applyHomography(Hwall, sidePoints[1].x, sidePoints[1].y);
  const xOuter = onLeft
    ? Math.min(top.x, bottom.x, -Math.max(12, wallWidth * 0.2))
    : Math.max(top.x, bottom.x, wallWidth + Math.max(12, wallWidth * 0.2));

  let source;
  let destination;
  if (sidePoints.length >= 4) {
    source = onLeft
      ? [sidePoints[0], sidePoints[2], sidePoints[1], sidePoints[3]]
      : [sidePoints[2], sidePoints[0], sidePoints[3], sidePoints[1]];
  } else {
    source = onLeft
      ? [sidePoints[0], wallQuad[0], sidePoints[1], wallQuad[2]]
      : [wallQuad[1], sidePoints[0], wallQuad[3], sidePoints[1]];
  }
  destination = onLeft
    ? [
        { x: xOuter, y: 0 },
        { x: 0, y: 0 },
        { x: xOuter, y: wallHeight },
        { x: 0, y: wallHeight },
      ]
    : [
        { x: wallWidth, y: 0 },
        { x: xOuter, y: 0 },
        { x: wallWidth, y: wallHeight },
        { x: xOuter, y: wallHeight },
      ];
  return {
    H: solveHomography(source, destination),
    destination,
    side: onLeft ? "left" : "right",
    source,
  };
}

export function polygonMask(width, height, polygon, feather = 0) {
  const alpha = new Uint8ClampedArray(width * height);
  if (!polygon || polygon.length < 3) return alpha;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const x0 = Math.max(0, Math.floor(minX - feather));
  const y0 = Math.max(0, Math.floor(minY - feather));
  const x1 = Math.min(width - 1, Math.ceil(maxX + feather));
  const y1 = Math.min(height - 1, Math.ceil(maxY + feather));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const inside = pointInPolygon(x + 0.5, y + 0.5, polygon);
      const distance = distanceToPolygon(x + 0.5, y + 0.5, polygon);
      let value = 0;
      if (feather <= 0) value = inside ? 255 : 0;
      else if (inside && distance >= feather) value = 255;
      else if (!inside && distance >= feather) value = 0;
      else {
        const signed = inside ? distance : -distance;
        const t = (signed + feather) / (2 * feather);
        value = Math.round(Math.max(0, Math.min(1, t)) * 255);
      }
      alpha[y * width + x] = value;
    }
  }
  return alpha;
}

export function blendMasked(base, overlay, alpha) {
  const out = new Uint8ClampedArray(base.length);
  const pixels = Math.min(base.length, overlay.length) / 4;
  for (let p = 0; p < pixels; p++) {
    const i = p * 4;
    const mask = (alpha[p] || 0) / 255;
    const overlayAlpha = (overlay[i + 3] / 255) * mask;
    const baseAlpha = base[i + 3] / 255;
    const outAlpha = overlayAlpha + baseAlpha * (1 - overlayAlpha);
    if (outAlpha <= 0) continue;
    out[i] = (overlay[i] * overlayAlpha + base[i] * baseAlpha * (1 - overlayAlpha)) / outAlpha;
    out[i + 1] = (overlay[i + 1] * overlayAlpha + base[i + 1] * baseAlpha * (1 - overlayAlpha)) / outAlpha;
    out[i + 2] = (overlay[i + 2] * overlayAlpha + base[i + 2] * baseAlpha * (1 - overlayAlpha)) / outAlpha;
    out[i + 3] = outAlpha * 255;
  }
  return out;
}

function wallTarget(width, height) {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ];
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = polygon[i].y;
    const yj = polygon[j].y;
    const xi = polygon[i].x;
    const xj = polygon[j].x;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi + 0) + xi) inside = !inside;
  }
  return inside;
}

function distanceToPolygon(x, y, polygon) {
  let best = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    best = Math.min(best, pointSegmentDistance(x, y, a.x, a.y, b.x, b.y));
  }
  return best;
}

function pointSegmentDistance(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
