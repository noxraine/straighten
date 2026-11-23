/**
 * Netlify Function: send a warped frame to Replicate LaMa and proxy the result.
 * POST JSON { image, mask } creates a prediction (Prefer: wait=8).
 * GET ?id= polls it. POST { cancel, id, fileIds } cancels and deletes uploads.
 */
import {
  LAMA_VERSION,
  fileIdList,
  validateInpaintBody,
} from "./inpaint-logic.js";

const REPLICATE = "https://api.replicate.com/v1";
const WAIT_SECONDS = 8;
const DATA_URL_BYTE_LIMIT = 200_000;

export async function handler(event) {
  try {
    if (event.httpMethod === "OPTIONS") return json(204, {});
    if (event.httpMethod === "GET") return poll(event.queryStringParameters || {});
    if (event.httpMethod !== "POST") {
      return json(405, { status: "failed", error: "Use POST to start and GET to poll." });
    }
    const body = JSON.parse(event.body || "{}");
    const parsed = validateInpaintBody(body);
    if (!parsed.ok) return json(parsed.status, { status: "failed", error: parsed.error });
    if (parsed.cancel) return cancel(parsed.id, parsed.fileIds);
    return create(parsed.image, parsed.mask);
  } catch (error) {
    const message = error instanceof SyntaxError ? "Request JSON could not be read." : error.message;
    return json(500, { status: "failed", error: message || "Inpaint failed." });
  }
}

async function create(imageUrl, maskUrl) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(500, { status: "failed", error: "REPLICATE_API_TOKEN is not set." });

  const uploaded = [];
  let imageInput = imageUrl;
  let maskInput = maskUrl;
  if (imageUrl.length > DATA_URL_BYTE_LIMIT || maskUrl.length > DATA_URL_BYTE_LIMIT) {
    const imageFile = await uploadFile(token, imageUrl, "frame.png");
    const maskFile = await uploadFile(token, maskUrl, "mask.png");
    uploaded.push(imageFile.id, maskFile.id);
    imageInput = imageFile.url;
    maskInput = maskFile.url;
  }

  const response = await fetch(`${REPLICATE}/predictions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: `wait=${WAIT_SECONDS}`,
      "Cancel-After": "90s",
    },
    body: JSON.stringify({
      version: LAMA_VERSION,
      input: { image: imageInput, mask: maskInput },
    }),
  });
  const prediction = await response.json().catch(() => ({}));
  if (!response.ok) {
    await deleteFiles(token, uploaded);
    return json(response.status, {
      status: "failed",
      error: replicateError(prediction) || `Replicate rejected the request (${response.status}).`,
    });
  }
  return finish(token, prediction, uploaded);
}

async function poll(query) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(500, { status: "failed", error: "REPLICATE_API_TOKEN is not set." });
  const id = typeof query.id === "string" ? query.id.trim() : "";
  if (!id) return json(400, { status: "failed", error: "A prediction id is required." });
  if (query.cancel === "1") return cancel(id, String(query.files || "").split(","));
  const response = await fetch(`${REPLICATE}/predictions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const prediction = await response.json().catch(() => ({}));
  if (!response.ok) {
    return json(response.status, {
      status: "failed",
      error: replicateError(prediction) || `Could not read the prediction (${response.status}).`,
    });
  }
  return finish(token, prediction, fileIdList(String(query.files || "").split(",")));
}

async function cancel(id, fileIds) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(500, { status: "failed", error: "REPLICATE_API_TOKEN is not set." });
  await fetch(`${REPLICATE}/predictions/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  await deleteFiles(token, fileIdList(fileIds));
  return json(200, { status: "canceled", id });
}

async function finish(token, prediction, fileIds) {
  const status = prediction.status || "processing";
  if (status === "succeeded") {
    try {
      const output = await outputToDataUrl(token, prediction.output);
      await deleteFiles(token, fileIds);
      return json(200, { status, id: prediction.id, output });
    } catch (error) {
      await deleteFiles(token, fileIds);
      return json(502, { status: "failed", id: prediction.id, error: error.message });
    }
  }
  if (status === "failed" || status === "canceled" || status === "aborted") {
    await deleteFiles(token, fileIds);
    return json(200, {
      status,
      id: prediction.id,
      error: replicateError(prediction) || "LaMa did not return an image.",
    });
  }
  return json(200, { status, id: prediction.id, fileIds });
}

async function uploadFile(token, dataUrl, filename) {
  const parsed = decodeDataUrl(dataUrl);
  const boundary = `----straighten${Math.random().toString(16).slice(2)}`;
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="content"; filename="${filename}"\r\nContent-Type: ${parsed.mime}\r\n\r\n`;
  const tail = `\r\n--${boundary}--\r\n`;
  const body = Buffer.concat([Buffer.from(head), parsed.bytes, Buffer.from(tail)]);
  const response = await fetch(`${REPLICATE}/files`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.urls || !payload.urls.get) {
    throw new Error(replicateError(payload) || "Could not upload the image to Replicate.");
  }
  return { id: payload.id, url: payload.urls.get };
}

async function deleteFiles(token, ids) {
  await Promise.all(ids.filter(Boolean).map((id) => fetch(`${REPLICATE}/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {})));
}

async function outputToDataUrl(token, output) {
  const url = Array.isArray(output) ? output[0] : output;
  if (typeof url !== "string" || !url) throw new Error("LaMa returned no image.");
  if (url.startsWith("data:image/")) return url;
  let response = await fetch(url);
  if (response.status === 401 || response.status === 403) {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!response.ok) throw new Error(`Could not download the LaMa image (${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const mime = (response.headers.get("content-type") || "image/png").split(";")[0];
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) throw new Error("Image data was not a base64 data URL.");
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

function replicateError(payload) {
  if (!payload) return "";
  if (typeof payload.detail === "string") return payload.detail;
  if (typeof payload.error === "string") return payload.error;
  if (payload.error && typeof payload.error === "object") return JSON.stringify(payload.error);
  return "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
