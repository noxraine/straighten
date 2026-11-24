/**
 * Netlify Function: send a marked room photo to Qwen's multi-angle edit.
 * POST JSON { image, rotate_degrees, multiple_angles_strength }.
 * GET ?id= polls. GET ?health=1 reports whether REPLICATE_API_TOKEN is set.
 */
import { fileIdList, healthBody, replicateFailure } from "./inpaint-logic.js";
import { buildQwenInput, validateQwenBody } from "./qwen-frontal-logic.js";

const REPLICATE = "https://api.replicate.com/v1";
const CREATE_URL = `${REPLICATE}/models/qwen/qwen-edit-multiangle/predictions`;
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
    const parsed = validateQwenBody(body);
    if (!parsed.ok) return json(parsed.status, { status: "failed", stage: "validate", error: parsed.error });
    if (parsed.cancel) return cancel(parsed.id, parsed.fileIds);
    return create(parsed);
  } catch (error) {
    const stage = error.stage || "create";
    if (error.code === 401 || error.code === 402) return json(error.code, replicateFailure(error.code, stage));
    return json(500, { status: "failed", stage, error: error.message || "Qwen failed." });
  }
}

export async function handler(event) {
  return dispatch({
    method: event.httpMethod,
    query: event.queryStringParameters || {},
    body: event.body,
  });
}

export default async function netlifyV2(request) {
  const url = new URL(request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const body = request.method === "GET" || request.method === "OPTIONS" ? "" : await request.text();
  const result = await dispatch({ method: request.method, query, body });
  return new Response(result.body, { status: result.statusCode, headers: result.headers });
}

async function create(parsed) {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return json(500, { status: "failed", stage: "create", error: "REPLICATE_API_TOKEN is not set." });

  const uploaded = [];
  let image = parsed.image;
  if (image.length > DATA_URL_BYTE_LIMIT) {
    const file = await uploadFile(token, image, "marked.jpg");
    uploaded.push(file.id);
    image = file.url;
  }
  const response = await fetch(CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: `wait=${WAIT_SECONDS}`,
      "Cancel-After": "90s",
    },
    body: JSON.stringify({
      input: buildQwenInput({
        image,
        rotateDegrees: parsed.rotateDegrees,
        multipleAnglesStrength: parsed.multipleAnglesStrength,
      }),
    }),
  });
  const prediction = await response.json().catch(() => ({}));
  if (!response.ok) {
    await deleteFiles(token, uploaded);
    return json(response.status, replicateFailure(response.status, "create", prediction));
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
  if (!response.ok) return json(response.status, replicateFailure(response.status, "poll", prediction));
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
      return json(502, {
        status: "failed",
        stage: error.stage || "fetch-output",
        id: prediction.id,
        error: error.message,
      });
    }
  }
  if (status === "failed" || status === "canceled" || status === "aborted") {
    await deleteFiles(token, fileIds);
    return json(200, {
      status,
      stage: "poll",
      id: prediction.id,
      error: failureText(prediction) || "Qwen did not return an image.",
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
    throw new Error(failureText(payload) || "Could not upload the image to Replicate.");
  }
  return { id: payload.id, url: payload.urls.get };
}

async function deleteFiles(token, ids) {
  await Promise.all((ids || []).filter(Boolean).map((id) => fetch(`${REPLICATE}/files/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  }).catch(() => {})));
}

async function outputToDataUrl(token, output) {
  const url = Array.isArray(output) ? output[0] : output;
  if (typeof url !== "string" || !url) {
    const failure = new Error("Qwen returned no image.");
    failure.stage = "fetch-output";
    throw failure;
  }
  if (url.startsWith("data:image/")) return url;
  let response = await fetch(url);
  if (response.status === 401 || response.status === 403) {
    response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  }
  if (!response.ok) {
    const failure = new Error(`Could not download the Qwen image (${response.status}).`);
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

function failureText(payload) {
  if (!payload) return "";
  if (typeof payload.detail === "string") return payload.detail;
  if (typeof payload.error === "string") return payload.error;
  return "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
