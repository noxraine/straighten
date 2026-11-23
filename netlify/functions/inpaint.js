/**
 * Netlify Function: send a warped frame to Replicate LaMa and proxy the result.
 * POST JSON { image, mask } creates a prediction (Prefer: wait=8).
 * GET ?id= polls it. POST { cancel, id, fileIds } cancels and deletes uploads.
 */
import {
  LAMA_VERSION,
  fileIdList,
  healthBody,
  replicateFailure,
  validateInpaintBody,
} from "./inpaint-logic.js";

const REPLICATE = "https://api.replicate.com/v1";
const WAIT_SECONDS = 8;
const DATA_URL_BYTE_LIMIT = 200_000;

export async function dispatch(request) {
  const method = request.method;
  const query = request.query || {};
  try {
    if (method === "OPTIONS") return json(204, {});
    if (method === "GET" && String(query.health) === "1") return json(200, healthBody());
    if (method === "GET") return poll(query);
    if (method !== "POST") {
      return json(405, { status: "failed", stage: "validate", error: "Use POST to start and GET to poll." });
    }
    let body;
    try {
      body = JSON.parse(request.body || "{}");
    } catch {
      return json(400, { status: "failed", stage: "validate", error: "Request JSON could not be read." });
    }
    const parsed = validateInpaintBody(body);
    if (!parsed.ok) return json(parsed.status, { status: "failed", stage: "validate", error: parsed.error });
    if (parsed.cancel) return cancel(parsed.id, parsed.fileIds);
    return create(parsed.image, parsed.mask);
  } catch (error) {
    const stage = error.stage || "create";
    if (error.code === 401 || error.code === 402) return json(error.code, replicateFailure(error.code, stage));
    return json(500, { status: "failed", stage, error: error.message || "Inpaint failed." });
  }
}

/** Netlify Functions v1. */
export async function handler(event) {
  return dispatch({
    method: event.httpMethod,
    query: event.queryStringParameters || {},
    body: event.body,
  });
}

/** Netlify Functions v2. Reads the same process.env.REPLICATE_API_TOKEN. */
export default async function netlifyV2(request) {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const body = request.method === "GET" || request.method === "OPTIONS" ? "" : await request.text();
  const result = await dispatch({ method: request.method, query, body });
  return new Response(result.body, { status: result.statusCode, headers: result.headers });
}

async function create(imageUrl, maskUrl) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(500, { status: "failed", stage: "create", error: "REPLICATE_API_TOKEN is not set." });

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
    return accountOrError(response.status, prediction, "create");
  }
  return finish(token, prediction, uploaded);
}

async function poll(query) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(500, { status: "failed", stage: "poll", error: "REPLICATE_API_TOKEN is not set." });
  const id = typeof query.id === "string" ? query.id.trim() : "";
  if (!id) return json(400, { status: "failed", stage: "poll", error: "A prediction id is required." });
  if (query.cancel === "1") return cancel(id, String(query.files || "").split(","));
  const response = await fetch(`${REPLICATE}/predictions/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const prediction = await response.json().catch(() => ({}));
  if (!response.ok) return accountOrError(response.status, prediction, "poll");
  return finish(token, prediction, fileIdList(String(query.files || "").split(",")));
}

async function cancel(id, fileIds) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(500, { status: "failed", stage: "poll", error: "REPLICATE_API_TOKEN is not set." });
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
      return json(502, { status: "failed", stage: error.stage || "fetch-output", id: prediction.id, error: error.message });
    }
  }
  if (status === "failed" || status === "canceled" || status === "aborted") {
    await deleteFiles(token, fileIds);
    return json(200, {
      status,
      stage: "poll",
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
  if (response.status === 401 || response.status === 402) {
    const failure = new Error(replicateFailure(response.status, "create").error);
    failure.code = response.status;
    failure.stage = "create";
    throw failure;
  }
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
  if (typeof url !== "string" || !url) {
    const failure = new Error("LaMa returned no image.");
    failure.stage = "fetch-output";
    throw failure;
  }
  if (url.startsWith("data:image/")) return url;
  let response = await fetch(url);
  if (response.status === 401 || response.status === 403) {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!response.ok) {
    const failure = new Error(`Could not download the LaMa image (${response.status}).`);
    failure.stage = "fetch-output";
    failure.code = response.status;
    throw failure;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const mime = (response.headers.get("content-type") || "image/png").split(";")[0];
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function decodeDataUrl(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(value);
  if (!match) throw new Error("Image data was not a base64 data URL.");
  return { mime: match[1], bytes: Buffer.from(match[2], "base64") };
}

function accountOrError(status, payload, stage) {
  return json(status, replicateFailure(status, stage, payload));
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
