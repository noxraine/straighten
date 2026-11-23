/** Pure helpers for the Replicate LaMa inpaint function and the browser composite. */

export const LAMA_OWNER_MODEL = "twn39/lama";
export const LAMA_VERSION = "bb9dd3362d559d0953b1d57ec9817f222c162e90047039b1b4af45c47b0b9af9";
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
