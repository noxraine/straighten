/** Pure helpers for the Replicate LaMa inpaint function and the browser composite. */

export const LAMA_OWNER_MODEL = "allenhooo/lama";
export const LAMA_VERSION = "cdac78a1bec5b23c07fd29692fb70baa513ea403a39e643c48ec5edadb15fe72";
export const LAMA_IMAGE_FIELD = "image";
export const LAMA_MASK_FIELD = "mask";

const MAX_DATA_URL_CHARS = 4_500_000;

export function validateInpaintBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Expected a JSON object." };
  }
  if (body.cancel) {
    if (typeof body.id !== "string" || !body.id.trim()) {
      return { ok: false, status: 400, error: "A prediction id is required to cancel." };
    }
    return { ok: true, cancel: true, id: body.id.trim(), fileIds: fileIdList(body.fileIds) };
  }
  const image = checkDataUrl(body.image, "image");
  if (!image.ok) return image;
  const mask = checkDataUrl(body.mask, "mask");
  if (!mask.ok) return mask;
  return { ok: true, image: body.image, mask: body.mask };
}

function checkDataUrl(value, name) {
  if (typeof value !== "string" || !value.startsWith("data:image/png;base64,")) {
    return { ok: false, status: 400, error: `${name} must be a PNG data URL.` };
  }
  if (value.length > MAX_DATA_URL_CHARS) {
    return { ok: false, status: 413, error: `${name} is too large to send.` };
  }
  return { ok: true };
}

/** Error JSON for a failed Replicate call. `stage` is validate, create, poll, or fetch-output. */
export function replicateFailure(status, stage, payload) {
  if (status === 402) {
    return {
      status: "failed",
      code: 402,
      stage,
      error: "insufficient credit",
    };
  }
  if (status === 401) {
    return {
      status: "failed",
      code: 401,
      stage,
      error: "The Replicate token was rejected.",
    };
  }
  return {
    status: "failed",
    code: status,
    stage,
    error: failureText(payload) || `Replicate rejected the request (${status}).`,
  };
}

export function healthBody(env = process.env) {
  return { tokenPresent: Boolean(env && env.REPLICATE_API_TOKEN) };
}

function failureText(payload) {
  if (!payload) return "";
  if (typeof payload.detail === "string") return payload.detail;
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error === "object") return JSON.stringify(payload.error);
  return "";
}

export function fileIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
}

/** White pixel = area LaMa should fill. Opaque warp pixels stay black. */
export function maskFromAlpha(rgba) {
  const mask = new Uint8ClampedArray(rgba.length);
  let hasEmpty = false;
  for (let i = 0; i < rgba.length; i += 4) {
    const empty = rgba[i + 3] < 16;
    if (empty) hasEmpty = true;
    const value = empty ? 255 : 0;
    mask[i] = value;
    mask[i + 1] = value;
    mask[i + 2] = value;
    mask[i + 3] = 255;
  }
  return { mask, hasEmpty };
}

/**
 * Keep original pixels where the mask is black.
 * Where the mask is white, use the AI color and make the pixel opaque.
 * All three buffers are the same length.
 */
export function compositeFill(original, ai, mask) {
  const length = Math.min(original.length, ai.length, mask.length);
  const out = new Uint8ClampedArray(original.length);
  for (let i = 0; i < length; i += 4) {
    if (mask[i] > 127) {
      out[i] = ai[i];
      out[i + 1] = ai[i + 1];
      out[i + 2] = ai[i + 2];
      out[i + 3] = 255;
    } else {
      out[i] = original[i];
      out[i + 1] = original[i + 1];
      out[i + 2] = original[i + 2];
      out[i + 3] = original[i + 3];
    }
  }
  return out;
}

export function fitLongSide(width, height, maxSide) {
  const edge = Math.max(width, height);
  const scale = edge > maxSide ? maxSide / edge : 1;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  };
}
