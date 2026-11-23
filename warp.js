/**
 * Inverse-homography warp.
 *
 * Output pixel centers are mapped through H⁻¹ into the source and sampled
 * bilinearly. renderWarp uses a WebGL fragment shader for that sampling and
 * falls back to warpBuffer (Canvas 2D / CPU) when WebGL is missing or the
 * draw fails.
 *
 * Textures larger than MAX_TEXTURE_SIZE are tiled: each output tile uploads
 * only the source region it needs, downscaled to the texture limit when that
 * region itself is still too large. Previews downscale the whole source,
 * since the on-screen result is small.
 */

import { applyHomography, fitFrame, invert3x3, maxInscribedRect } from "./homography.js";

const MAX_OUTPUT_DIM = 16384;
const MAX_OUTPUT_AREA = 64_000_000;

export function fitOutputSize(width, height) {
  let scale = 1;
  if (width > MAX_OUTPUT_DIM) scale = Math.min(scale, MAX_OUTPUT_DIM / width);
  if (height > MAX_OUTPUT_DIM) scale = Math.min(scale, MAX_OUTPUT_DIM / height);
  if (width * height > MAX_OUTPUT_AREA) {
    scale = Math.min(scale, Math.sqrt(MAX_OUTPUT_AREA / (width * height)));
  }
  if (scale === 1) {
    return { width: Math.max(2, Math.round(width)), height: Math.max(2, Math.round(height)), capped: false };
  }
  return {
    width: Math.max(2, Math.round(width * scale)),
    height: Math.max(2, Math.round(height * scale)),
    capped: true,
  };
}

/** Largest source size that still fits inside a GL texture limit, keeping aspect. */
export function fitTextureSize(srcW, srcH, maxTextureSize) {
  const limit = Math.max(1, maxTextureSize);
  const scale = Math.min(1, limit / srcW, limit / srcH);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
    scale,
  };
}

/**
 * Source-pixel bounding box touched by one output tile.
 * Returns null when the tile maps entirely outside the photo.
 * The box is clamped to the source and padded for bilinear filtering.
 */
export function sourceRegionForTile({
  tx, ty, tw, th,
  outW, outH,
  originX, originY, spanX, spanY,
  Hinv, srcW, srcH,
}) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const steps = 4;
  for (let j = 0; j <= steps; j++) {
    for (let i = 0; i <= steps; i++) {
      const ox = tx + (i / steps) * tw;
      const oy = ty + (j / steps) * th;
      const destX = originX + (ox / outW) * spanX;
      const destY = originY + (oy / outH) * spanY;
      const p = applyHomography(Hinv, destX, destY);
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
  }
  if (!Number.isFinite(minX)) return null;

  minX = Math.floor(minX) - 2;
  minY = Math.floor(minY) - 2;
  maxX = Math.ceil(maxX) + 2;
  maxY = Math.ceil(maxY) + 2;

  if (maxX - minX > srcW * 1.5 || maxY - minY > srcH * 1.5) {
    return { x: 0, y: 0, w: srcW, h: srcH };
  }

  const x0 = Math.max(0, minX);
  const y0 = Math.max(0, minY);
  const x1 = Math.min(srcW, maxX);
  const y1 = Math.min(srcH, maxY);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * CPU warp. `src` is tightly packed RGBA.
 * Destination pixel (x, y) has its center at
 *   (originX, originY) + ((x+0.5)/outW, (y+0.5)/outH) * (spanX, spanY)
 * in the same space H⁻¹ expects.
 * Samples outside the source are transparent.
 */
export function warpBuffer(src, srcW, srcH, Hinv, outW, outH, originX, originY, spanX, spanY) {
  const out = new Uint8ClampedArray(outW * outH * 4);
  warpRows(src, srcW, srcH, Hinv, out, outW, outH, originX, originY, spanX, spanY, 0, outH);
  return out;
}

function warpRows(src, srcW, srcH, Hinv, out, outW, outH, originX, originY, spanX, spanY, y0, y1) {
  const sxScale = spanX / outW;
  const syScale = spanY / outH;
  const h00 = Hinv[0], h01 = Hinv[1], h02 = Hinv[2];
  const h10 = Hinv[3], h11 = Hinv[4], h12 = Hinv[5];
  const h20 = Hinv[6], h21 = Hinv[7], h22 = Hinv[8];

  for (let y = y0; y < y1; y++) {
    const destY = originY + (y + 0.5) * syScale;
    const row = y * outW * 4;
    for (let x = 0; x < outW; x++) {
      const destX = originX + (x + 0.5) * sxScale;
      const w = h20 * destX + h21 * destY + h22;
      if (Math.abs(w) < 1e-12) continue;
      const srcX = (h00 * destX + h01 * destY + h02) / w;
      const srcY = (h10 * destX + h11 * destY + h12) / w;
      const color = sampleBilinear(src, srcW, srcH, srcX, srcY);
      if (!color) continue;
      const o = row + x * 4;
      out[o] = color[0];
      out[o + 1] = color[1];
      out[o + 2] = color[2];
      out[o + 3] = color[3];
    }
  }
}

function sampleBilinear(src, srcW, srcH, x, y) {
  if (x < 0 || y < 0 || x >= srcW || y >= srcH) return null;
  const px = x - 0.5;
  const py = y - 0.5;
  let x0 = Math.floor(px);
  let y0 = Math.floor(py);
  const tx = px - x0;
  const ty = py - y0;
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  x0 = clamp(x0, 0, srcW - 1);
  y0 = clamp(y0, 0, srcH - 1);
  const cx1 = clamp(x1, 0, srcW - 1);
  const cy1 = clamp(y1, 0, srcH - 1);
  const c00 = at(src, srcW, x0, y0);
  const c10 = at(src, srcW, cx1, y0);
  const c01 = at(src, srcW, x0, cy1);
  const c11 = at(src, srcW, cx1, cy1);
  const color = [0, 0, 0, 0];
  for (let k = 0; k < 4; k++) {
    const a = c00[k] + (c10[k] - c00[k]) * tx;
    const b = c01[k] + (c11[k] - c01[k]) * tx;
    color[k] = a + (b - a) * ty;
  }
  return color;
}

function at(src, srcW, x, y) {
  const i = (y * srcW + x) * 4;
  return [src[i], src[i + 1], src[i + 2], src[i + 3]];
}

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

let renderChain = Promise.resolve();

/**
 * Warp `source` (CanvasImageSource) into a new canvas.
 * H maps source pixels into destination space, where the corrected quad
 * occupies [0, destWidth] × [0, destHeight].
 *
 * options.mode: "full" fits the whole photo (default for the app), "crop" keeps the rectangle.
 * options.maxEdge: longest output edge, used for the live preview.
 * options.textureLimit: test override for the texture-size budget.
 * options.onProgress: called with 0..1 during a CPU export.
 */
export function renderWarp(source, srcW, srcH, H, options = {}) {
  const run = renderChain.then(() => renderWarpInner(source, srcW, srcH, H, options));
  renderChain = run.then(() => {}, () => {});
  return run;
}

async function renderWarpInner(source, srcW, srcH, H, options) {
  if (typeof document === "undefined") {
    throw new Error("renderWarp needs a browser.");
  }
  const mode = options.outputFrame
    ? "frame"
    : options.mode === "crop"
      ? "crop"
      : options.mode === "max"
        ? "max"
        : "full";
  const destWidth = options.destWidth;
  const destHeight = options.destHeight;
  const Hinv = invert3x3(H);

  let originX = 0;
  let originY = 0;
  let spanX = destWidth;
  let spanY = destHeight;
  let outW = Math.max(2, Math.round(destWidth));
  let outH = Math.max(2, Math.round(destHeight));
  let clamped = false;
  if (mode === "frame") {
    originX = options.outputFrame.originX;
    originY = options.outputFrame.originY;
    spanX = options.outputFrame.spanX;
    spanY = options.outputFrame.spanY;
    outW = options.outputFrame.width;
    outH = options.outputFrame.height;
  } else if (mode === "full" || mode === "max") {
    const fit = fitFrame(H, srcW, srcH);
    clamped = fit.clamped;
    if (mode === "max") {
      const rect = maxInscribedRect(fit.corners);
      if (rect && rect.width > 1 && rect.height > 1) {
        originX = rect.x;
        originY = rect.y;
        spanX = rect.width;
        spanY = rect.height;
        outW = Math.max(2, Math.round(spanX));
        outH = Math.max(2, Math.round(spanY));
      } else {
        originX = fit.originX;
        originY = fit.originY;
        spanX = fit.spanX;
        spanY = fit.spanY;
        outW = fit.width;
        outH = fit.height;
      }
    } else {
      originX = fit.originX;
      originY = fit.originY;
      spanX = fit.spanX;
      spanY = fit.spanY;
      outW = fit.width;
      outH = fit.height;
    }
  }

  if (Number.isFinite(options.maxEdge) && options.maxEdge > 0) {
    const edge = Math.max(outW, outH);
    if (edge > options.maxEdge) {
      const s = options.maxEdge / edge;
      outW = Math.max(2, Math.round(outW * s));
      outH = Math.max(2, Math.round(outH * s));
    }
  }
  const fitted = fitOutputSize(outW, outH);
  outW = fitted.width;
  outH = fitted.height;

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;
  const ctx = canvas.getContext("2d", { alpha: true });
  ctx.clearRect(0, 0, outW, outH);

  const mapping = { Hinv, originX, originY, spanX, spanY, outW, outH, srcW, srcH };
  let renderer = "cpu";
  let webglError = null;
  try {
    const drew = renderWebGL(ctx, source, mapping, options);
    if (drew) renderer = "webgl";
  } catch (error) {
    webglError = error;
    ctx.clearRect(0, 0, outW, outH);
  }
  if (renderer !== "webgl") {
    try {
      await renderCPU(ctx, source, mapping, options.onProgress);
    } catch (error) {
      const reason = webglError ? ` WebGL failed (${webglError.message}).` : "";
      throw new Error(`Could not render the correction.${reason} ${error.message}`);
    }
  }

  return {
    canvas,
    width: outW,
    height: outH,
    capped: fitted.capped,
    clamped,
    renderer,
    frame: { originX, originY, spanX, spanY, width: outW, height: outH },
  };
}

async function renderCPU(ctx, source, mapping, onProgress) {
  const { srcW, srcH, outW, outH } = mapping;
  const scratch = document.createElement("canvas");
  scratch.width = srcW;
  scratch.height = srcH;
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  sctx.drawImage(source, 0, 0, srcW, srcH);
  let pixels;
  try {
    pixels = sctx.getImageData(0, 0, srcW, srcH).data;
  } catch (error) {
    throw new Error("This photo is too large to correct without WebGL.");
  }
  const out = new Uint8ClampedArray(outW * outH * 4);
  const chunk = 32;
  for (let y = 0; y < outH; y += chunk) {
    const y1 = Math.min(outH, y + chunk);
    warpRows(
      pixels, srcW, srcH, mapping.Hinv, out, outW, outH,
      mapping.originX, mapping.originY, mapping.spanX, mapping.spanY,
      y, y1,
    );
    if (onProgress) onProgress(y1 / outH);
    if (y1 < outH) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  ctx.putImageData(new ImageData(out, outW, outH), 0, 0);
}

let glState = null;
let cropCanvas = null;

function renderWebGL(outCtx, source, mapping, options) {
  const state = getGL();
  if (!state) return false;
  const { gl } = state;
  const deviceMax = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
  const budget = options.textureLimit ? Math.min(deviceMax, options.textureLimit) : deviceMax;
  const preview = Number.isFinite(options.maxEdge);
  const outW = mapping.outW;
  const outH = mapping.outH;
  // Leave a few pixels of headroom so the bilinear padding around a tile
  // still fits in one texture at full resolution.
  const tileLimit = Math.max(32, Math.min(budget - 8, 4096));

  state.srcFull = [mapping.srcW, mapping.srcH];

  const wholeLimit = preview ? Math.min(budget, Math.max(1024, Math.ceil(options.maxEdge * 2))) : budget;
  const wholeFits = mapping.srcW <= wholeLimit && mapping.srcH <= wholeLimit;
  // Previews always upload one texture (downscaled if needed). Exports tile
  // only when the photo itself exceeds the texture budget.
  const useSingleTexture = preview || wholeFits;

  if (useSingleTexture) {
    const uploaded = downscaleSource(source, mapping.srcW, mapping.srcH, wholeLimit);
    uploadTexture(state, uploaded);
    state.srcOrigin = [0, 0];
    state.srcExtent = [mapping.srcW, mapping.srcH];
  }

  for (let ty = 0; ty < outH; ty += tileLimit) {
    for (let tx = 0; tx < outW; tx += tileLimit) {
      const tw = Math.min(tileLimit, outW - tx);
      const th = Math.min(tileLimit, outH - ty);
      if (!useSingleTexture) {
        const region = sourceRegionForTile({
          tx, ty, tw, th, outW, outH,
          originX: mapping.originX,
          originY: mapping.originY,
          spanX: mapping.spanX,
          spanY: mapping.spanY,
          Hinv: mapping.Hinv,
          srcW: mapping.srcW,
          srcH: mapping.srcH,
        });
        if (!region) {
          outCtx.clearRect(tx, ty, tw, th);
          continue;
        }
        const crop = cropSource(source, region, budget);
        uploadTexture(state, crop);
        state.srcOrigin = [region.x, region.y];
        state.srcExtent = [region.w, region.h];
      }
      drawTile(state, tw, th, tx, ty, mapping);
      outCtx.drawImage(state.canvas, 0, 0, tw, th, tx, ty, tw, th);
    }
  }
  return true;
}

function downscaleSource(source, srcW, srcH, limit) {
  const fitted = fitTextureSize(srcW, srcH, limit);
  // Always upload a 2D canvas. texImage2D(ImageBitmap) plus UNPACK_FLIP_Y
  // samples the photo upside down in Chrome, while the same bitmap drawn
  // onto a canvas first matches the CPU warp.
  if (source instanceof HTMLCanvasElement && source.width === fitted.width && source.height === fitted.height) {
    return source;
  }
  const canvas = document.createElement("canvas");
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = fitted.scale < 1;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, fitted.width, fitted.height);
  return canvas;
}

function cropSource(source, region, limit) {
  const fitted = fitTextureSize(region.w, region.h, limit);
  if (!cropCanvas) cropCanvas = document.createElement("canvas");
  cropCanvas.width = fitted.width;
  cropCanvas.height = fitted.height;
  const ctx = cropCanvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.clearRect(0, 0, fitted.width, fitted.height);
  ctx.drawImage(
    source,
    region.x, region.y, region.w, region.h,
    0, 0, fitted.width, fitted.height,
  );
  return cropCanvas;
}

function getGL() {
  if (glState && !glState.gl.isContextLost()) return glState;
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
    depth: false,
    stencil: false,
  });
  if (!gl) return null;
  const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
  if (!precision || precision.precision < 16) return null;

  const program = buildProgram(gl, VERT, FRAG);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const texture = gl.createTexture();

  const loc = {
    pos: gl.getAttribLocation(program, "a_pos"),
    Hinv: gl.getUniformLocation(program, "u_Hinv"),
    tileOrigin: gl.getUniformLocation(program, "u_tileOrigin"),
    tileSize: gl.getUniformLocation(program, "u_tileSize"),
    outSize: gl.getUniformLocation(program, "u_outSize"),
    destOrigin: gl.getUniformLocation(program, "u_destOrigin"),
    destSpan: gl.getUniformLocation(program, "u_destSpan"),
    srcOrigin: gl.getUniformLocation(program, "u_srcOrigin"),
    srcExtent: gl.getUniformLocation(program, "u_srcExtent"),
    srcFull: gl.getUniformLocation(program, "u_srcFull"),
    tex: gl.getUniformLocation(program, "u_tex"),
  };

  glState = {
    gl, canvas, program, buffer, texture, loc,
    srcOrigin: [0, 0],
    srcExtent: [1, 1],
    srcFull: [1, 1],
  };
  canvas.addEventListener("webglcontextlost", (event) => {
    event.preventDefault();
    glState = null;
  }, false);
  return glState;
}

function buildProgram(gl, vertSrc, fragSrc) {
  const vert = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const program = gl.createProgram();
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
  }
  return program;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) || "Shader compile failed";
    gl.deleteShader(shader);
    throw new Error(log);
  }
  return shader;
}

function uploadTexture(state, source) {
  const { gl, texture } = state;
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function drawTile(state, tw, th, tx, ty, mapping) {
  const { gl, canvas, loc } = state;
  if (canvas.width !== tw || canvas.height !== th) {
    canvas.width = tw;
    canvas.height = th;
  }
  gl.viewport(0, 0, tw, th);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.useProgram(state.program);
  gl.bindBuffer(gl.ARRAY_BUFFER, state.buffer);
  gl.enableVertexAttribArray(loc.pos);
  gl.vertexAttribPointer(loc.pos, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, state.texture);
  gl.uniform1i(loc.tex, 0);
  gl.uniformMatrix3fv(loc.Hinv, false, columnMajor(mapping.Hinv));
  gl.uniform2f(loc.tileOrigin, tx, ty);
  gl.uniform2f(loc.tileSize, tw, th);
  gl.uniform2f(loc.outSize, mapping.outW, mapping.outH);
  gl.uniform2f(loc.destOrigin, mapping.originX, mapping.originY);
  gl.uniform2f(loc.destSpan, mapping.spanX, mapping.spanY);
  gl.uniform2f(loc.srcOrigin, state.srcOrigin[0], state.srcOrigin[1]);
  gl.uniform2f(loc.srcExtent, state.srcExtent[0], state.srcExtent[1]);
  gl.uniform2f(loc.srcFull, state.srcFull[0], state.srcFull[1]);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
}

function columnMajor(m) {
  return new Float32Array([
    m[0], m[3], m[6],
    m[1], m[4], m[7],
    m[2], m[5], m[8],
  ]);
}

const VERT = `
precision highp float;
attribute vec2 a_pos;
uniform vec2 u_tileOrigin;
uniform vec2 u_tileSize;
varying vec2 v_out;
void main() {
  // a_pos.y is 0 at the bottom of the GL canvas. Flip so v_out.y matches
  // the top-left origin of the 2D canvas we copy this tile into.
  v_out = vec2(
    u_tileOrigin.x + a_pos.x * u_tileSize.x,
    u_tileOrigin.y + (1.0 - a_pos.y) * u_tileSize.y
  );
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}
`;

const FRAG = `
precision highp float;
varying vec2 v_out;
uniform sampler2D u_tex;
uniform mat3 u_Hinv;
uniform vec2 u_outSize;
uniform vec2 u_destOrigin;
uniform vec2 u_destSpan;
uniform vec2 u_srcOrigin;
uniform vec2 u_srcExtent;
uniform vec2 u_srcFull;

void main() {
  vec2 dest = u_destOrigin + (v_out / u_outSize) * u_destSpan;
  vec3 p = u_Hinv * vec3(dest, 1.0);
  if (abs(p.z) < 1e-8) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 src = p.xy / p.z;
  if (src.x < 0.0 || src.y < 0.0 || src.x >= u_srcFull.x || src.y >= u_srcFull.y) {
    gl_FragColor = vec4(0.0);
    return;
  }
  vec2 uv = (src - u_srcOrigin) / u_srcExtent;
  // UNPACK_FLIP_Y stores the top of the photo at v = 1.
  uv.y = 1.0 - uv.y;
  gl_FragColor = texture2D(u_tex, uv);
}
`;
