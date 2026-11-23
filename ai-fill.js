/** Browser-side request building and error text for AI fill. No DOM. */

export const INPAINT_PATH = "/.netlify/functions/inpaint";

export function buildInpaintRequest(image, mask) {
  return {
    url: INPAINT_PATH,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { image, mask },
  };
}

export function buildPollRequest(id, fileIds = []) {
  const files = encodeURIComponent(fileIds.join(","));
  return {
    url: `${INPAINT_PATH}?id=${encodeURIComponent(id)}&files=${files}`,
    method: "GET",
  };
}

export function buildHealthRequest() {
  return { url: `${INPAINT_PATH}?health=1`, method: "GET" };
}

/**
 * One line for the error banner.
 * A Replicate failure keeps the status code and the function's error text,
 * for example "Replicate 402: insufficient credit".
 */
export function formatAiError(info = {}) {
  if (info.timeout) return "Timed out after 90 seconds.";
  if (info.network) return "Network error. The fill request did not reach the server.";
  if (info.empty) return "Replicate returned no image.";
  const payload = info.payload || {};
  const status = info.status || payload.code;
  const text = firstText(payload.error) || firstText(payload.detail);
  if (status) return text ? `Replicate ${status}: ${text}` : `Replicate ${status}`;
  return text || "AI fill failed.";
}

function firstText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}
