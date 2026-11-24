/**
 * Camera controls for qwen/qwen-edit-multiangle, plus the local preview homography.
 * The preview is illustrative. Only the clamped slider values are sent to Qwen.
 */

import { invert3x3, multiply3x3 } from "../../homography.js";

export const QWEN_MODEL_PATH = "/models/qwen/qwen-edit-multiangle/predictions";
export const QWEN_PROMPT = "preserve all existing content, camera rotation only, no new objects";

const MAX_DATA_URL_CHARS = 8_000_000;

export function clampRotate(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(clamp(number, -90, 90));
}

export function clampTilt(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(clamp(number, -1, 1) * 10) / 10;
}

export function clampForward(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(clamp(number, 0, 5) * 2) / 2;
}

export function clampStrength(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.round(clamp(number, 0, 2) * 100) / 100;
}

export function buildQwenInput(controls = {}) {
  return {
    image: controls.image,
    prompt: QWEN_PROMPT,
    aspect_ratio: "match_input_image",
    go_fast: true,
    use_multiple_angles: true,
    output_format: "png",
    rotate_degrees: clampRotate(controls.rotateDegrees),
    vertical_tilt: clampTilt(controls.verticalTilt),
    move_forward: clampForward(controls.moveForward),
    use_wide_angle: Boolean(controls.useWideAngle),
    multiple_angles_strength: clampStrength(controls.multipleAnglesStrength),
  };
}

/**
 * Illustrative homography, never uploaded.
 * H = Zoom * K * Ry(yaw) * Rx(pitch) * K^-1.
 * Positive rotate_degrees turns the camera left, so the center of the photo
 * moves right. vertical_tilt is a fraction of 30°. Strength scales both angles.
 * Wide angle uses an 80° field of view instead of 60°.
 */
export function previewHomography(width, height, controls = {}) {
  const wide = Boolean(controls.useWideAngle);
  const fov = (wide ? 80 : 60) * Math.PI / 180;
  const focal = width / (2 * Math.tan(fov / 2));
  const cx = width / 2;
  const cy = height / 2;
  const strength = clampStrength(controls.multipleAnglesStrength);
  const yaw = clampRotate(controls.rotateDegrees) * strength * Math.PI / 180;
  const pitch = clampTilt(controls.verticalTilt) * 30 * strength * Math.PI / 180;
  const zoom = 1 + clampForward(controls.moveForward) * 0.15;
  const K = [focal, 0, cx, 0, focal, cy, 0, 0, 1];
  const R = multiply3x3(rotY(yaw), rotX(pitch));
  const rotation = multiply3x3(K, multiply3x3(R, invert3x3(K)));
  const Z = [zoom, 0, cx * (1 - zoom), 0, zoom, cy * (1 - zoom), 0, 0, 1];
  return multiply3x3(Z, rotation);
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
    verticalTilt: clampTilt(body.vertical_tilt),
    moveForward: clampForward(body.move_forward),
    useWideAngle: Boolean(body.use_wide_angle),
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

function rotX(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

function rotY(angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
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
