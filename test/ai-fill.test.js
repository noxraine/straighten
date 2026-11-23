import test from "node:test";
import assert from "node:assert/strict";
import { buildInpaintRequest, buildPollRequest, formatAiError } from "../ai-fill.js";
import { replicateFailure } from "../netlify/functions/inpaint-logic.js";
import { dispatch } from "../netlify/functions/inpaint.js";

test("the client posts the image and mask to the inpaint function", () => {
  const request = buildInpaintRequest("data:image/png;base64,aaa", "data:image/png;base64,bbb");
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/.netlify/functions/inpaint");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(request.body, {
    image: "data:image/png;base64,aaa",
    mask: "data:image/png;base64,bbb",
  });
  const poll = buildPollRequest("pred_1", ["file_a"]);
  assert.equal(poll.method, "GET");
  assert.match(poll.url, /id=pred_1/);
  assert.match(poll.url, /files=file_a/);
});

test("AI fill errors keep the status code and the function text", () => {
  const credit = replicateFailure(402, "create");
  assert.equal(credit.stage, "create");
  assert.equal(credit.code, 402);
  assert.equal(formatAiError({ status: 402, payload: credit }), "Replicate 402: insufficient credit");
  assert.match(formatAiError({ network: true }), /Network error/);
  assert.match(formatAiError({ timeout: true }), /Timed out after 90 seconds/);
  assert.match(formatAiError({ empty: true }), /no image/);
  assert.equal(
    formatAiError({ status: 500, payload: { stage: "create", error: "REPLICATE_API_TOKEN is not set." } }),
    "Replicate 500: REPLICATE_API_TOKEN is not set.",
  );
});

test("health reports whether the token is set and does not call Replicate", async () => {
  const previous = process.env.REPLICATE_API_TOKEN;
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = (url) => {
    calls.push(url);
    throw new Error("health must not call Replicate");
  };
  try {
    delete process.env.REPLICATE_API_TOKEN;
    const missing = await dispatch({ method: "GET", query: { health: "1" } });
    assert.equal(missing.statusCode, 200);
    assert.deepEqual(JSON.parse(missing.body), { tokenPresent: false });
    process.env.REPLICATE_API_TOKEN = "present";
    const ready = await dispatch({ method: "GET", query: { health: "1" } });
    assert.deepEqual(JSON.parse(ready.body), { tokenPresent: true });
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = original;
    if (previous === undefined) delete process.env.REPLICATE_API_TOKEN;
    else process.env.REPLICATE_API_TOKEN = previous;
  }
});
