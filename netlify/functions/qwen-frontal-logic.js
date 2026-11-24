/**
 * Pure request building for the Qwen frontal edit.
 * The browser draws the red marker and sends a JPEG; this module turns that
 * into the official qwen/qwen-edit-multiangle input.
 */

export const QWEN_MODEL_PATH = "/models/qwen/qwen-edit-multiangle/predictions";
export const QWEN_PROMPT = "make the wall with the red marker the frontal wall, perfect eye-level perpendicular view, keep doors and windows as rectangles, same room and materials, remove the red marker";

const MAX_DATA_URL_CHARS = 8_000_000;

export function markerRadius(width, height) {
  return 0.02 * Math.min(width, height);
}

/**
 * Camera hint from where the marker sits.
 * A marker on the left (dx < 0) yields a positive rotate_degrees, which the
 * model documents as "rotate left". The automatic hint stays inside ±45°.
 */
export function rotateDegreesFromMarker(markerX, width) {
  if (!(width > 0) || !Number.isFinite(markerX)) return 0;
  const dx = markerX / width - 0.5;
  return Math.round(clamp(-dx * 90, -45, 45)) + 0;
}

export function clampRotate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(clamp(number, -90, 90));
}

export function clampStrength(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.round(clamp(number, 0, 2) * 100) / 100;
}

export function buildQwenInput({ image, rotateDegrees = 0, multipleAnglesStrength = 1 } = {}) {
  return {
    image,
    prompt: QWEN_PROMPT,
    aspect_ratio: "match_input_image",
    go_fast: true,
    use_multiple_angles: true,
    vertical_tilt: 0,
    move_forward: 0,
    use_wide_angle: false,
    output_format: "png",
    rotate_degrees: clampRotate(rotateDegrees),
    multiple_angles_strength: clampStrength(multipleAnglesStrength),
  };
}

export function validateQwenBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, status: 400, error: "Expected a JSON object." };
  }
  if (body.cancel) {
    if (typeof body.id !== "string" || !body.id.trim()) {
      return { ok: false, status: 400, error: "A prediction id is required to cancel." };
    }
    return { ok: true, cancel: true, id: body.id.trim(), fileIds: idList(body.fileIds) };
  }
  const image = checkImage(body.image);
  if (!image.ok) return image;
  return {
    ok: true,
    image: body.image,
    rotateDegrees: clampRotate(body.rotate_degrees),
    multipleAnglesStrength: clampStrength(body.multiple_angles_strength),
  };
}

export function formatQwenError(info = {}) {
  if (info.timeout) return "Timed out after 90 seconds.";
  if (info.network) return "Network error. The Qwen request did not reach the server.";
  if (info.empty) return "Qwen returned no image.";
  const payload = info.payload || {};
  const status = info.status || payload.code;
  const text = firstText(payload.error) || firstText(payload.detail);
  if (status) return text ? `Replicate ${status}: ${text}` : `Replicate ${status}`;
  return text || "Qwen failed.";
}

function checkImage(value) {
  if (typeof value !== "string" || !/^data:image\/(?:jpeg|jpg|png);base64,/.test(value)) {
    return { ok: false, status: 400, error: "image must be a JPEG or PNG data URL." };
  }
  if (value.length > MAX_DATA_URL_CHARS) {
    return { ok: false, status: 413, error: "image is too large to send." };
  }
  return { ok: true };
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
}

function firstText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
