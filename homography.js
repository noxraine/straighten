/**
 * Plane homography utilities for four-point perspective correction.
 *
 * Points are {x, y} in pixel space, origin at the top-left, +y downward.
 * Matrices are row-major 3×3 arrays of length 9.
 *
 * solveHomography() uses the normalized Direct Linear Transform: Hartley
 * normalization, then a nullspace solve of the 8×9 design matrix.
 */

export class HomographyError extends Error {
  constructor(message) {
    super(message);
    this.name = "HomographyError";
  }
}

export function applyHomography(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return {
    x: (H[0] * x + H[1] * y + H[2]) / w,
    y: (H[3] * x + H[4] * y + H[5]) / w,
  };
}

export function multiply3x3(A, B) {
  const C = new Array(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      C[r * 3 + c] =
        A[r * 3] * B[c] +
        A[r * 3 + 1] * B[3 + c] +
        A[r * 3 + 2] * B[6 + c];
    }
  }
  return C;
}

export function invert3x3(m) {
  const a = m[0], b = m[1], c = m[2];
  const d = m[3], e = m[4], f = m[5];
  const g = m[6], h = m[7], i = m[8];

  const c00 = e * i - f * h;
  const c01 = f * g - d * i;
  const c02 = d * h - e * g;
  const c10 = c * h - b * i;
  const c11 = a * i - c * g;
  const c12 = b * g - a * h;
  const c20 = b * f - c * e;
  const c21 = c * d - a * f;
  const c22 = a * e - b * d;

  const det = a * c00 + b * c01 + c * c02;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-18) {
    throw new HomographyError("Homography is singular.");
  }
  const s = 1 / det;
  return [
    c00 * s, c10 * s, c20 * s,
    c01 * s, c11 * s, c21 * s,
    c02 * s, c12 * s, c22 * s,
  ];
}

/**
 * Map the ordered corners TL, TR, BL, BR onto a rectangle of the given size.
 * Bottom-left is (0, height) because +y points down.
 */
export function rectangleTargets(width, height) {
  return [
    { x: 0, y: 0 },
    { x: width, y: 0 },
    { x: 0, y: height },
    { x: width, y: height },
  ];
}

/**
 * Edge lengths of a quad stored as [top-left, top-right, bottom-left, bottom-right].
 * Width and height are the averages of the opposite edges — a practical default
 * when the real-world size is unknown.
 */
export function measureQuad(quad) {
  if (!quad || quad.length !== 4) {
    throw new HomographyError("A quad needs four corners.");
  }
  const [tl, tr, bl, br] = quad;
  const top = Math.hypot(tr.x - tl.x, tr.y - tl.y);
  const bottom = Math.hypot(br.x - bl.x, br.y - bl.y);
  const left = Math.hypot(bl.x - tl.x, bl.y - tl.y);
  const right = Math.hypot(br.x - tr.x, br.y - tr.y);
  return {
    top,
    bottom,
    left,
    right,
    width: (top + bottom) / 2,
    height: (left + right) / 2,
  };
}

/**
 * Pixel size of the corrected rectangle.
 * realWidth / realHeight, when both are positive, replace the edge estimate.
 * The pixel area stays close to the quad's edge-length area so the export
 * keeps roughly the source resolution.
 */
export function planRectangle(quad, realWidth, realHeight) {
  const edges = measureQuad(quad);
  const estimated = edges.height > 1e-9 ? edges.width / edges.height : 1;
  const widthIn = Number(realWidth);
  const heightIn = Number(realHeight);
  const measured = widthIn > 0 && heightIn > 0 && Number.isFinite(widthIn) && Number.isFinite(heightIn);
  const aspect = measured ? widthIn / heightIn : estimated;
  if (!Number.isFinite(aspect) || aspect <= 0) {
    throw new HomographyError("Aspect ratio must be positive.");
  }
  const area = Math.max(edges.width * edges.height, 4);
  let height = Math.sqrt(area / aspect);
  let width = height * aspect;
  width = Math.max(2, Math.round(width));
  height = Math.max(2, Math.round(height));
  if (Math.abs(width / height - aspect) / aspect > 1e-3) {
    if (aspect >= 1) width = Math.max(2, Math.round(height * aspect));
    else height = Math.max(2, Math.round(width / aspect));
  }
  return { width, height, aspect, estimated, measured, edges };
}

/**
 * Why a four-point selection cannot be corrected, or null when it can.
 * Distances are in source pixels.
 */
export function quadProblem(quad) {
  if (!quad || quad.length !== 4) return "Place all four corners.";
  for (const p of quad) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return "A corner is not on the photo.";
  }
  for (let i = 0; i < 4; i++) {
    for (let j = i + 1; j < 4; j++) {
      if (Math.hypot(quad[i].x - quad[j].x, quad[i].y - quad[j].y) < 1) {
        return "Two corners are on top of each other.";
      }
    }
  }
  const [tl, tr, bl, br] = quad;
  if (segmentsIntersect(tl, tr, bl, br) || segmentsIntersect(tl, bl, tr, br)) {
    return "These corners cross. Mark the four corners of one surface.";
  }
  const area = Math.abs(polygonArea([tl, tr, br, bl]));
  if (area < 16) return "Spread the corners so they enclose the surface.";
  return null;
}

/**
 * Axis-aligned bounds of the source image after H, expanded to include the
 * destination rectangle. Returns null when a corner shoots off to infinity
 * or the frame would be unreasonably large.
 */
export function transformedImageBounds(H, srcW, srcH, destW, destH) {
  const samples = [
    [0, 0],
    [srcW, 0],
    [srcW, srcH],
    [0, srcH],
  ];
  const pts = samples.map(([x, y]) => applyHomography(H, x, y));
  pts.push(
    { x: 0, y: 0 },
    { x: destW, y: 0 },
    { x: destW, y: destH },
    { x: 0, y: destH },
  );
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const limit = 8 * Math.max(srcW, srcH, destW, destH, 1);
  if (!(width > 1 && height > 1) || width > limit || height > limit) return null;
  return { minX, minY, maxX, maxY, width, height };
}

/**
 * Homography mapping src[i] -> dst[i] for exactly four point pairs.
 * The result is scaled so its largest absolute entry is 1.
 */
export function solveHomography(src, dst) {
  if (!src || !dst || src.length !== 4 || dst.length !== 4) {
    throw new HomographyError("Four point pairs are required.");
  }
  for (let i = 0; i < 4; i++) {
    for (const p of [src[i], dst[i]]) {
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        throw new HomographyError("Point coordinates must be finite.");
      }
    }
  }
  if (triangleSpan(src) <= 0 || triangleSpan(dst) <= 0) {
    throw new HomographyError("These corners are collinear.");
  }

  const ns = normalizePoints(src);
  const nd = normalizePoints(dst);
  const A = designMatrix(ns.points, nd.points);
  const h = nullspace8x9(A);
  const Hn = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], h[8]];
  const H = scaleMatrix(multiply3x3(invert3x3(nd.T), multiply3x3(Hn, ns.T)));

  let maxErr = 0;
  for (let i = 0; i < 4; i++) {
    const p = applyHomography(H, src[i].x, src[i].y);
    maxErr = Math.max(maxErr, Math.hypot(p.x - dst[i].x, p.y - dst[i].y));
  }
  const span = Math.max(triangleSpan(dst), 1);
  if (!Number.isFinite(maxErr) || maxErr > Math.max(0.05, span * 1e-6)) {
    throw new HomographyError("Could not fit a homography to these corners.");
  }
  return H;
}

function normalizePoints(points) {
  let cx = 0;
  let cy = 0;
  for (const p of points) {
    cx += p.x;
    cy += p.y;
  }
  cx /= points.length;
  cy /= points.length;
  let mean = 0;
  for (const p of points) mean += Math.hypot(p.x - cx, p.y - cy);
  mean /= points.length;
  const s = mean > 1e-12 ? Math.SQRT2 / mean : 1;
  return {
    T: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1],
    points: points.map((p) => ({ x: (p.x - cx) * s, y: (p.y - cy) * s })),
  };
}

function designMatrix(src, dst) {
  const rows = [];
  for (let i = 0; i < src.length; i++) {
    const x = src[i].x;
    const y = src[i].y;
    const u = dst[i].x;
    const v = dst[i].y;
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, -u]);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, -v]);
  }
  return rows;
}

/**
 * Nullspace of a rank-8 8×9 matrix via Gauss-Jordan elimination.
 * Returns the unit-scaled singular direction (one free variable).
 */
function nullspace8x9(rows) {
  const m = rows.length;
  const n = 9;
  const M = rows.map((row) => Float64Array.from(row));
  const pivotCol = [];
  const used = new Array(n).fill(false);
  let row = 0;

  for (let col = 0; col < n && row < m; col++) {
    let pivot = row;
    for (let r = row + 1; r < m; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
    }
    if (Math.abs(M[pivot][col]) < 1e-12) continue;
    const swap = M[row];
    M[row] = M[pivot];
    M[pivot] = swap;
    const div = M[row][col];
    for (let j = col; j < n; j++) M[row][j] /= div;
    for (let r = 0; r < m; r++) {
      if (r === row) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = col; j < n; j++) M[r][j] -= factor * M[row][j];
    }
    used[col] = true;
    pivotCol.push(col);
    row++;
  }

  const free = [];
  for (let c = 0; c < n; c++) if (!used[c]) free.push(c);
  if (free.length !== 1 || pivotCol.length !== 8) {
    throw new HomographyError("These corners do not define a unique perspective.");
  }

  const h = new Float64Array(n);
  h[free[0]] = 1;
  for (let r = 0; r < pivotCol.length; r++) {
    const pc = pivotCol[r];
    let value = 0;
    for (const fc of free) value += M[r][fc] * h[fc];
    h[pc] = -value;
  }
  return h;
}

function scaleMatrix(M) {
  let max = 0;
  for (let i = 0; i < 9; i++) max = Math.max(max, Math.abs(M[i]));
  if (!(max > 0) || !Number.isFinite(max)) {
    throw new HomographyError("Homography solve failed.");
  }
  return M.map((v) => v / max);
}

function triangleSpan(points) {
  let max = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      for (let k = j + 1; k < points.length; k++) {
        max = Math.max(max, Math.abs(polygonArea([points[i], points[j], points[k]])));
      }
    }
  }
  return max;
}

function polygonArea(pts) {
  let area = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    area += p.x * q.y - q.x * p.y;
  }
  return area / 2;
}

function segmentsIntersect(a, b, c, d) {
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (o1 === 0 || o2 === 0 || o3 === 0 || o4 === 0) return false;
  return o1 !== o2 && o3 !== o4;
}

function orient(a, b, c) {
  const v = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(v) < 1e-9) return 0;
  return v > 0 ? 1 : -1;
}
