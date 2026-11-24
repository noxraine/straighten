import {
  blendTowardIdentity,
  fitFrame,
  maxInscribedRect,
  placeOnFrame,
  planRectangle,
  quadProblem,
  rectangleTargets,
  solveHomography,
} from "./homography.js";
import { createPointPicker } from "./point-picker.js";
import { adjustCanvas, buildMask, compositeOnWhite, patchAverage, whiteBalanceGains } from "./adjust.js";
import { compositeFill, fitLongSide, maskFromAlpha } from "./netlify/functions/inpaint-logic.js";
import {
  buildHealthRequest,
  buildInpaintRequest,
  buildPollRequest,
  formatAiError,
} from "./ai-fill.js";
import {
  clampRotate,
  clampTilt,
  estimateCameraFromQuad,
  formatQwenError,
  previewHomography,
  validateQwenBody,
} from "./netlify/functions/qwen-frontal-logic.js";
import { fitRoomFrame, layoutRoom, reconstructBox } from "./room3d.js";
import { fitOutputSize, renderRoomWarp, renderWarp } from "./warp.js";

const $ = (id) => document.getElementById(id);

const dropzone = $("dropzone");
const workspace = $("workspace");
const fileInput = $("file-input");
const browse = $("browse");
const sampleButton = $("sample-button");
const replaceButton = $("replace");
const undoButton = $("undo");
const resetButton = $("reset");
const hint = $("hint");
const fileMeta = $("file-meta");
const corners = $("corners");
const previewCanvas = $("preview-canvas");
const previewEmpty = $("preview-empty");
const aspectReadout = $("aspect-readout");
const proportionNote = $("proportion-note");
const realWidth = $("real-width");
const realHeight = $("real-height");
const exportMeta = $("export-meta");
const rendererNote = $("renderer");
const downloadButton = $("download");
const zipButton = $("download-zip");
const quality = $("quality");
const qualityValue = $("quality-value");
const qualityRow = $("quality-row");
const strength = $("strength");
const strengthValue = $("strength-value");
const frameNote = $("frame-note");
const whiteBalanceButton = $("white-balance");
const whiteBalanceReset = $("white-balance-reset");
const whiteBalanceNote = $("white-balance-note");
const clarity = $("clarity");
const clarityValue = $("clarity-value");
const aiPanel = $("ai-panel");
const aiRun = $("ai-run");
const aiCancel = $("ai-cancel");
const aiStatus = $("ai-status");
const roomButton = $("room-button");
const statusEl = $("status");
const veil = $("veil");

const picker = createPointPicker($("source-canvas"), {
  loupe: $("loupe"),
  onChange: (state) => {
    latest = state;
    if (!state.roomMode) latest.near = [];
    undoButton.disabled = !state.canUndo;
    hint.textContent = state.prompt;
    markCorners(state);
    schedulePreview(state.dragging);
  },
});

let photo = null;
let originalPhoto = null;
let workingIsQwen = false;
let qwenEstimate = null;
let qwenAbort = null;
let aiFillOn = false;
let cameraFrame = 0;
let latest = { points: [], dragging: false, canUndo: false, prompt: "" };
let gains = [1, 1, 1];
let pickWhite = false;
let lastWarp = null;
let aiCanvas = null;
let aiKey = "";
let aiAbort = null;
let previewDirty = false;
let previewRunning = false;

browse.addEventListener("click", () => fileInput.click());
replaceButton.addEventListener("click", () => fileInput.click());
sampleButton.addEventListener("click", () => openSample("samples/gallery-wall.png", "gallery-wall.png", "Opening the sample wall…", sampleButton));
roomButton.addEventListener("click", () => openSample("samples/room.png", "room.png", "Opening the sample room…", roomButton));
fileInput.addEventListener("change", () => {
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = "";
  if (file) openFile(file);
});
undoButton.addEventListener("click", () => picker.undo());
resetButton.addEventListener("click", () => picker.reset());
$("qwen-run").addEventListener("click", () => runQwen(false));
$("qwen-retry").addEventListener("click", () => runQwen(true));
$("qwen-cancel").addEventListener("click", () => {
  if (qwenAbort) qwenAbort.abort();
});
$("qwen-original").addEventListener("click", () => useOriginalPhoto());
$("qwen-fill").addEventListener("click", () => fillQwenCorners());
for (const input of [$("tune-rotate"), $("tune-tilt"), $("tune-zoom")]) {
  input.addEventListener("input", () => {
    refreshTuneLabels();
    queueCameraPreview();
  });
}
picker.setLoopOrder(true);
downloadButton.addEventListener("click", () => download());
zipButton.addEventListener("click", () => downloadZip());

for (const input of [realWidth, realHeight, quality, strength, clarity]) {
  input.addEventListener("input", () => {
    if (input === quality) qualityValue.textContent = `${quality.value}%`;
    if (input === strength) strengthValue.textContent = `${strength.value}%`;
    if (input === clarity) clarityValue.textContent = clarity.value;
    schedulePreview(false);
  });
}
whiteBalanceButton.addEventListener("click", () => {
  pickWhite = !pickWhite;
  whiteBalanceButton.classList.toggle("is-on", pickWhite);
  previewCanvas.classList.toggle("picking", pickWhite);
  whiteBalanceNote.textContent = pickWhite
    ? "Click a neutral point on the corrected photo."
    : "Click a point on the result that should be neutral.";
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && event.target.closest("#ai-run")) runAiFill();
});
aiCancel.addEventListener("click", () => {
  if (aiAbort) aiAbort.abort();
});
whiteBalanceReset.addEventListener("click", () => {
  gains = [1, 1, 1];
  pickWhite = false;
  whiteBalanceButton.classList.remove("is-on");
  previewCanvas.classList.remove("picking");
  whiteBalanceNote.textContent = "White balance reset.";
  schedulePreview(false);
});
previewCanvas.addEventListener("click", (event) => {
  if (!pickWhite || !lastWarp) return;
  const point = eventToCanvasPixel(previewCanvas, event);
  if (!point) return;
  const sample = displaySource() || lastWarp;
  const pixels = sample.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, sample.width, sample.height);
  const average = patchAverage(pixels.data, sample.width, sample.height, point.x, point.y, 3);
  gains = whiteBalanceGains(average);
  pickWhite = false;
  whiteBalanceButton.classList.remove("is-on");
  previewCanvas.classList.remove("picking");
  whiteBalanceNote.textContent = `White balance ${gains.map((gain) => gain.toFixed(2)).join(" · ")}`;
  schedulePreview(false);
});
for (const input of document.querySelectorAll('input[name="frame"], input[name="format"]')) {
  input.addEventListener("change", () => {
    qualityRow.hidden = !jpegSelected();
    downloadButton.textContent = jpegSelected() ? "Download JPEG" : "Download PNG";
    frameNote.textContent = frameNoteText();
    if (input.name === "frame") aiFillOn = false;
    const ai = frameMode() === "ai";
    aiPanel.hidden = !ai;
    if (!ai) {
      if (aiAbort) aiAbort.abort();
      aiCanvas = null;
      showAiBanner("");
    }
    schedulePreview(false);
  });
}

window.addEventListener("keydown", (event) => {
  if (event.key === "z" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA") return;
    event.preventDefault();
    picker.undo();
  }
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  dragDepth += 1;
  veil.hidden = false;
});
window.addEventListener("dragover", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) veil.hidden = true;
});
window.addEventListener("drop", (event) => {
  if (!dragHasFiles(event)) return;
  event.preventDefault();
  dragDepth = 0;
  veil.hidden = true;
  const file = [...event.dataTransfer.files].find(isImageFile);
  if (!file) {
    setStatus("Use a JPEG, PNG, WebP, or HEIC photo.", true);
    return;
  }
  openFile(file);
});

async function openSample(url, name, message, button) {
  setStatus(message);
  button.disabled = true;
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error("Sample photo is missing.");
    const blob = await response.blob();
    await openFile(new File([blob], name, { type: "image/png" }));
  } catch (error) {
    setStatus(error.message || "Could not open the sample.", true);
  } finally {
    button.disabled = false;
  }
}

async function openFile(file) {
  if (!isImageFile(file)) {
    setStatus("Use a JPEG, PNG, WebP, or HEIC photo.", true);
    return;
  }
  setStatus("Opening photo…");
  dropzone.classList.add("busy");
  try {
    const decoded = await decodeImage(file);
    if (photo && photo.bitmap && photo.bitmap !== decoded.bitmap && photo.bitmap.close) photo.bitmap.close();
    if (originalPhoto && originalPhoto.bitmap && originalPhoto.bitmap !== decoded.bitmap && originalPhoto.bitmap.close) {
      originalPhoto.bitmap.close();
    }
    originalPhoto = {
      bitmap: decoded.bitmap,
      width: decoded.width,
      height: decoded.height,
      name: file.name || "photo",
    };
    photo = originalPhoto;
    workingIsQwen = false;
    qwenEstimate = null;
    dropzone.hidden = true;
    workspace.hidden = false;
    fileMeta.textContent = `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()}`;
    $("qwen-actions").hidden = true;
    showQwenBanner("");
    showQwenProgress("");
    syncStage();
    picker.setImage(photo.bitmap, photo.width, photo.height);
    setStatus("");
    requestAnimationFrame(() => picker.redraw());
  } catch (error) {
    setStatus(error.message || "Could not read that photo.", true);
  } finally {
    dropzone.classList.remove("busy");
  }
}

function syncStage() {
  $("tune-panel").hidden = !workingIsQwen;
  $("qwen-actions").hidden = !workingIsQwen;
  $("qwen-run").hidden = workingIsQwen;
  picker.setLoopOrder(!workingIsQwen);
  picker.setEnabled(true);
  $("preview-hint").textContent = workingIsQwen
    ? "Optional: mark top left, top right, bottom left, bottom right for a true rectangle. Otherwise the sliders are what exports."
    : "Mark the wall in order, then straighten it.";
}

function refreshTuneLabels() {
  $("tune-rotate-value").textContent = `${$("tune-rotate").value}°`;
  $("tune-tilt-value").textContent = Number($("tune-tilt").value).toFixed(1);
  $("tune-zoom-value").textContent = Number($("tune-zoom").value).toFixed(2);
}

function resetTuneSliders() {
  $("tune-rotate").value = "0";
  $("tune-tilt").value = "0";
  $("tune-zoom").value = "1";
  refreshTuneLabels();
}

function tuneControls() {
  return {
    rotateDegrees: Number($("tune-rotate").value),
    verticalTilt: Number($("tune-tilt").value),
    zoom: Number($("tune-zoom").value),
    moveForward: 0,
    useWideAngle: false,
    multipleAnglesStrength: 1,
  };
}

function queueCameraPreview() {
  if (!workingIsQwen || !photo) return;
  if (cameraFrame) return;
  cameraFrame = requestAnimationFrame(() => {
    cameraFrame = 0;
    schedulePreview(true);
  });
}

function showQwenProgress(message) {
  $("qwen-status").textContent = message;
  if (message) console.info("[Qwen]", message);
}

function showQwenBanner(message) {
  const banner = $("qwen-banner");
  banner.hidden = !message;
  banner.textContent = message || "";
  if (message) console.error("[Qwen]", message);
}

async function runQwen(retry) {
  if (qwenAbort) return;
  const source = originalPhoto || photo;
  if (!source) {
    showQwenBanner("Open a photo first.");
    return;
  }
  const controller = new AbortController();
  qwenAbort = controller;
  $("qwen-run").disabled = true;
  $("qwen-retry").disabled = true;
  $("qwen-cancel").hidden = false;
  showQwenBanner("");
  let predictionId = "";
  let fileIds = [];
  try {
    console.info("[Qwen] GET /.netlify/functions/qwen-frontal?health=1");
    let healthResponse;
    try {
      healthResponse = await fetch("/.netlify/functions/qwen-frontal?health=1", { signal: controller.signal });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw Object.assign(new Error(formatQwenError({ network: true })), { qwen: true });
    }
    const health = await readJsonResponse(healthResponse);
    console.info("[Qwen] health", healthResponse.status, health);
    if (!healthResponse.ok) throw Object.assign(new Error(formatQwenError({ status: healthResponse.status, payload: health })), { qwen: true });
    if (health.tokenPresent === false) throw Object.assign(new Error("REPLICATE_API_TOKEN is not set."), { qwen: true });

    let rotateDegrees;
    let verticalTilt;
    if (retry && qwenEstimate) {
      const tune = tuneControls();
      rotateDegrees = clampRotate(qwenEstimate.rotateDegrees + tune.rotateDegrees);
      verticalTilt = clampTilt(qwenEstimate.verticalTilt + tune.verticalTilt);
    } else {
      if (latest.points.length !== 4) {
        showQwenBanner("Place all four wall corners first.");
        qwenAbort = null;
        $("qwen-cancel").hidden = true;
        $("qwen-run").disabled = false;
        $("qwen-retry").disabled = false;
        return;
      }
      qwenEstimate = estimateCameraFromQuad(latest.points, source.width, source.height);
      rotateDegrees = qwenEstimate.rotateDegrees;
      verticalTilt = qwenEstimate.verticalTilt;
    }
    console.info("[Qwen]", { rotate_degrees: rotateDegrees, vertical_tilt: verticalTilt, retry: Boolean(retry) });
    showQwenProgress("Отправка в Qwen…");
    const body = {
      image: originalJpeg(source.bitmap, source.width, source.height),
      rotate_degrees: rotateDegrees,
      vertical_tilt: verticalTilt,
      move_forward: 0,
      use_wide_angle: false,
      multiple_angles_strength: 1,
    };
    const parsed = validateQwenBody(body);
    if (!parsed.ok) throw Object.assign(new Error(parsed.error), { qwen: true });
    console.info("[Qwen] POST /.netlify/functions/qwen-frontal", {
      rotate_degrees: body.rotate_degrees,
      vertical_tilt: body.vertical_tilt,
      move_forward: body.move_forward,
      use_wide_angle: body.use_wide_angle,
      multiple_angles_strength: body.multiple_angles_strength,
    });
    let response;
    try {
      response = await fetch("/.netlify/functions/qwen-frontal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw Object.assign(new Error(formatQwenError({ network: true })), { qwen: true });
    }
    let payload = await readQwenBody(response);
    predictionId = payload.id || "";
    fileIds = payload.fileIds || [];
    const started = Date.now();
    while (payload.status === "starting" || payload.status === "processing") {
      if (Date.now() - started > 90000) {
        throw Object.assign(new Error(formatQwenError({ timeout: true })), { qwen: true });
      }
      showQwenProgress("Обработка…");
      await delay(1500, controller.signal);
      const pollUrl = `/.netlify/functions/qwen-frontal?id=${encodeURIComponent(payload.id)}&files=${encodeURIComponent(fileIds.join(","))}`;
      console.info("[Qwen] GET", pollUrl);
      let pollResponse;
      try {
        pollResponse = await fetch(pollUrl, { signal: controller.signal });
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw Object.assign(new Error(formatQwenError({ network: true })), { qwen: true });
      }
      payload = await readQwenBody(pollResponse);
    }
    if (payload.status !== "succeeded" || !payload.output) {
      throw Object.assign(new Error(formatQwenError({
        status: payload.code,
        empty: payload.status === "succeeded" && !payload.output,
        payload,
      })), { qwen: true });
    }
    await adoptQwenImage(payload.output);
    showQwenBanner("");
    showQwenProgress("Готово");
  } catch (error) {
    if (error.name === "AbortError") {
      showQwenBanner("");
      showQwenProgress("Cancelled.");
      if (predictionId) {
        fetch(`/.netlify/functions/qwen-frontal?id=${encodeURIComponent(predictionId)}&files=${encodeURIComponent(fileIds.join(","))}&cancel=1`).catch(() => {});
      }
    } else {
      showQwenBanner(error.message || formatQwenError({}));
      showQwenProgress("");
    }
  } finally {
    qwenAbort = null;
    $("qwen-cancel").hidden = true;
    $("qwen-run").disabled = false;
    $("qwen-retry").disabled = false;
  }
}

async function readQwenBody(response) {
  const payload = await readJsonResponse(response);
  console.info("[Qwen] response", response.status, payload && payload.status, payload && payload.stage);
  if (!response.ok || payload.status === "failed") {
    throw Object.assign(new Error(formatQwenError({ status: payload.code || response.status, payload })), { qwen: true });
  }
  return payload;
}

async function readJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text.slice(0, 280) };
  }
}

function originalJpeg(bitmap, width, height) {
  const fitted = fitLongSide(width, height, 1536);
  const out = document.createElement("canvas");
  out.width = fitted.width;
  out.height = fitted.height;
  out.getContext("2d").drawImage(bitmap, 0, 0, fitted.width, fitted.height);
  return out.toDataURL("image/jpeg", 0.9);
}

async function adoptQwenImage(dataUrl) {
  const image = await loadDataImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  canvas.getContext("2d").drawImage(image, 0, 0);
  const bitmap = typeof createImageBitmap === "function" ? await createImageBitmap(canvas) : canvas;
  if (workingIsQwen && photo && photo.bitmap && photo.bitmap !== originalPhoto.bitmap && photo.bitmap.close) {
    photo.bitmap.close();
  }
  photo = {
    bitmap,
    width: canvas.width,
    height: canvas.height,
    name: originalPhoto ? originalPhoto.name : "qwen",
  };
  workingIsQwen = true;
  $("qwen-actions").hidden = false;
  fileMeta.textContent = `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()}`;
  picker.setImage(bitmap, canvas.width, canvas.height);
  resetTuneSliders();
  syncStage();
  previewEmpty.textContent = "The rectangle appears after the fourth corner. The sliders can be exported on their own.";
}

function useOriginalPhoto() {
  if (!originalPhoto) return;
  if (workingIsQwen && photo && photo.bitmap && photo.bitmap !== originalPhoto.bitmap && photo.bitmap.close) {
    photo.bitmap.close();
  }
  photo = originalPhoto;
  workingIsQwen = false;
  $("qwen-actions").hidden = true;
  fileMeta.textContent = `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()}`;
  showQwenBanner("");
  showQwenProgress("");
  qwenEstimate = null;
  resetTuneSliders();
  picker.setImage(photo.bitmap, photo.width, photo.height);
  syncStage();
}

async function fillQwenCorners() {
  const plan = currentPlan();
  if (!plan) {
    showQwenBanner("Place the four corners of the frontal wall first.");
    return;
  }
  const rendered = await renderPlan(plan, { maxEdge: 900 });
  const pixels = rendered.canvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, rendered.canvas.width, rendered.canvas.height);
  if (!maskFromAlpha(pixels.data).hasEmpty) {
    showQwenBanner("This frame has no empty corners.");
    return;
  }
  showQwenBanner("");
  aiFillOn = true;
  aiPanel.hidden = false;
  frameNote.textContent = frameNoteText();
  runAiFill();
}

function schedulePreview(dragging) {
  if (!photo) return;
  previewDirty = true;
  refreshReadouts(dragging);
  if (previewRunning) return;
  previewRunning = true;
  runPreviewLoop();
}

async function runPreviewLoop() {
  try {
    while (previewDirty) {
      previewDirty = false;
      const fast = latest.dragging;
      await renderPreview(fast);
    }
  } finally {
    previewRunning = false;
    if (previewDirty) schedulePreview(false);
  }
}

function renderPlan(plan, extra) {
  if (plan.layout) {
    return renderRoomWarp(photo.bitmap, photo.width, photo.height, plan.layout, plan.model, {
      mode: warpMode(),
      ...extra,
    });
  }
  return renderWarp(photo.bitmap, photo.width, photo.height, plan.H, {
    mode: plan.tune || plan.preview ? "full" : warpMode(),
    destWidth: plan.rect ? plan.rect.width : photo.width,
    destHeight: plan.rect ? plan.rect.height : photo.height,
    ...extra,
  });
}

async function renderPreview(fast) {
  const plan = currentPlan();
  if (!plan) {
    showPreview(null);
    setExportEnabled(false);
    return;
  }
  const frame = $("preview-frame").getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const longest = Math.max(frame.width, frame.height, 320) * dpr;
  const maxEdge = fast ? Math.min(900, longest) : Math.min(1800, Math.max(640, longest));
  try {
    let result = await renderPlan(plan, { maxEdge });
    if (previewDirty) return;
    showPreview(result, plan);
    const full = exportSize(plan);
    exportMeta.textContent = full
      ? `${full.width.toLocaleString()} × ${full.height.toLocaleString()} px`
      : "—";
    rendererNote.textContent = result.renderer === "webgl" ? "WebGL" : "CPU";
    setExportEnabled(Boolean(full));
    if (!latest.dragging) {
      if (result.clamped && frameMode() === "full") {
        setStatus("The perspective runs off the edge of the shot, so that part was held in. The rest of the photo stays in frame.");
      } else {
        setStatus("");
      }
    }
  } catch (error) {
    showPreview(null);
    setExportEnabled(false);
    setStatus(error.message || "Could not build the preview.", true);
  }
}

function showPreview(result, plan) {
  if (!result) {
    lastWarp = null;
    previewCanvas.hidden = true;
    previewEmpty.hidden = false;
    rendererNote.textContent = "";
    picker.setGuide(null);
    return;
  }
  previewEmpty.hidden = true;
  previewCanvas.hidden = false;
  lastWarp = result.canvas;
  if (aiKey !== warpKey()) aiCanvas = null;
  const adjusted = presentCanvas(displaySource());
  previewCanvas.width = adjusted.width;
  previewCanvas.height = adjusted.height;
  const ctx = previewCanvas.getContext("2d");
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  ctx.drawImage(adjusted, 0, 0);
  const wire = $("wireframe");
  if (plan && plan.layout && wire && wire.checked) {
    drawBoxWire(ctx, result.frame, plan.layout.targets, adjusted.width, adjusted.height);
  }
  picker.setGuide(plan && plan.model ? plan.model.wire : null);
}

function presentCanvas(canvas) {
  return adjustCanvas(canvas, { gains, clarity: Number(clarity.value) });
}

function displaySource() {
  if (frameMode() === "ai" && aiCanvas && aiKey === warpKey()) return aiCanvas;
  return lastWarp;
}

function warpKey() {
  if (!photo) return "";
  const points = latest.points.map((point) => `${Math.round(point.x)},${Math.round(point.y)}`).join(";");
  const near = (latest.near || []).map((point) => `${Math.round(point.x)},${Math.round(point.y)}`).join(";");
  const fovEl = $("fov");
  const roomEl = $("pick-room");
  const fov = fovEl && fovEl.dataset.touched ? fovEl.value : "est";
  const kind = roomEl && roomEl.checked ? "box" : "wall";
  return `${photo.width}x${photo.height}|${strength.value}|${points}|${near}|${fov}|${kind}`;
}

function drawBoxWire(ctx, frame, points, width, height) {
  const scaleX = width / frame.width;
  const scaleY = height / frame.height;
  const placed = points.map((point) => {
    const onFrame = placeOnFrame(frame, point.x, point.y);
    return { x: onFrame.x * scaleX, y: onFrame.y * scaleY };
  });
  const edges = [
    [0, 1], [1, 3], [3, 2], [2, 0],
    [4, 5], [5, 7], [7, 6], [6, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  ctx.save();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(1.5, width / 480);
  ctx.strokeStyle = "rgba(161, 92, 18, 0.95)";
  ctx.beginPath();
  for (const [a, b] of edges) {
    if (!placed[a] || !placed[b]) continue;
    if (![placed[a].x, placed[a].y, placed[b].x, placed[b].y].every(Number.isFinite)) continue;
    ctx.moveTo(placed[a].x, placed[a].y);
    ctx.lineTo(placed[b].x, placed[b].y);
  }
  ctx.stroke();
  ctx.restore();
}

function currentPlan() {
  if (!photo) return null;
  if (workingIsQwen && latest.points.length === 4 && !latest.loopOrder) {
    // fall through to the four-point homography
  } else if (workingIsQwen) {
    return {
      tune: true,
      H: previewHomography(photo.width, photo.height, tuneControls()),
      rect: { width: photo.width, height: photo.height },
    };
  } else {
    return null;
  }
  if (latest.points.length !== 4) return null;
  const problem = quadProblem(latest.points);
  if (problem) {
    setStatus(problem, true);
    exportMeta.textContent = "—";
    return null;
  }
  const real = realValues();
  let rect;
  try {
    rect = planRectangle(latest.points, real.width, real.height);
  } catch (error) {
    setStatus(error.message, true);
    return null;
  }
  if (boxReady()) {
    try {
      const model = reconstructBox(latest.points, latest.near, photo.width, photo.height);
      const layout = layoutRoom(model, {
        backPoints: latest.points,
        rect,
        strength: Number(strength.value) / 100,
        ...fovOverride(),
      });
      updateLensNote(model);
      return { rect, H: layout.faces.back.H, model, layout };
    } catch (error) {
      setStatus(error.message || "Could not reconstruct the box.", true);
      return null;
    }
  }
  let H;
  try {
    H = homographyFor(latest.points, rect);
  } catch (error) {
    setStatus(error.message, true);
    return null;
  }
  return { rect, H };
}

function boxReady() {
  const room = $("pick-room");
  return Boolean(room && room.checked && latest.points.length === 4 && (latest.near || []).length === 4);
}

function fovOverride() {
  const fovEl = $("fov");
  if (!fovEl || !fovEl.dataset.touched) return {};
  return { fovDegrees: Number(fovEl.value) };
}

function updateLensNote(model) {
  const fovEl = $("fov");
  const note = $("lens-note");
  if (!fovEl || !note) return;
  const override = Boolean(fovEl.dataset.touched);
  if (!override && model.degenerate) {
    note.textContent = "The walls are nearly parallel, so depth starts from a 60° lens. The slider only stretches the floor and sides. The back wall stays a rectangle.";
  } else if (override) {
    note.textContent = `Depth uses ${fovEl.value}° instead of the estimated ${Math.round(model.fov)}°. The back wall stays a rectangle.`;
  } else {
    note.textContent = `Estimated ${Math.round(model.fov)}° lens. Move the slider to lengthen or shorten the floor. The back wall stays a rectangle.`;
  }
}

function homographyFor(points, rect) {
  return blendTowardIdentity(
    solveHomography(points, rectangleTargets(rect.width, rect.height)),
    Number(strength.value) / 100,
  );
}

function refreshReadouts() {
  const count = latest.points.length;
  const roomEl = $("pick-room");
  const box = Boolean(roomEl && roomEl.checked);
  if (!workingIsQwen) {
    aspectReadout.textContent = "—";
    proportionNote.textContent = count < 4
      ? "Place all four corners. The order is top left, top right, bottom right, bottom left."
      : "Ready. Straighten sends the original photo with the turn estimated from these corners.";
    exportMeta.textContent = "—";
    setExportEnabled(false);
    return;
  }
  if (count < 4 || latest.loopOrder) {
    aspectReadout.textContent = "—";
    proportionNote.textContent = "Add four corners for a true rectangle, or export the slider view.";
    return;
  }
  const problem = quadProblem(latest.points);
  if (problem) {
    aspectReadout.textContent = "—";
    proportionNote.textContent = problem;
    return;
  }
  const real = realValues();
  const rect = planRectangle(latest.points, real.width, real.height);
  aspectReadout.textContent = formatRatio(rect.aspect);
  if (box && (latest.near || []).length < 4) {
    proportionNote.textContent = `Back wall ${formatRatio(rect.estimated)}. Add the four near corners to recover the box.`;
  } else if (boxReady()) {
    try {
      const model = reconstructBox(latest.points, latest.near, photo.width, photo.height);
      const ratio = formatRatio(model.width / model.height);
      const depth = (model.depth / model.height).toFixed(2);
      aspectReadout.textContent = ratio;
      proportionNote.textContent = `Box ${ratio}, depth ${depth} × the height.`;
    } catch {
      proportionNote.textContent = "Could not recover the box from these corners.";
    }
  } else if (rect.measured) {
    proportionNote.textContent = "Locked to the width and height you entered. Only the ratio is used.";
  } else if (filled(realWidth) !== filled(realHeight)) {
    proportionNote.textContent = "Enter both width and height to lock the ratio. Any unit is fine.";
  } else {
    proportionNote.textContent = `From the quad’s edges (${formatRatio(rect.estimated)}). Enter a real width and height if you know them.`;
  }
  if (boxReady()) {
    const built = currentPlan();
    const full = built && exportSize(built);
    exportMeta.textContent = full
      ? `${full.width.toLocaleString()} × ${full.height.toLocaleString()} px`
      : "—";
    return;
  }
  const plan = { rect, H: null };
  try {
    plan.H = homographyFor(latest.points, rect);
  } catch {
    return;
  }
  const full = exportSize(plan);
  exportMeta.textContent = full
    ? `${full.width.toLocaleString()} × ${full.height.toLocaleString()} px`
    : "—";
}

function exportSize(plan) {
  if (!photo || !plan || plan.preview) return null;
  if (plan.tune && frameMode() === "crop") return fitOutputSize(plan.rect.width, plan.rect.height);
  const mode = frameMode();
  if (plan.layout) {
    if (mode === "crop") return fitOutputSize(plan.layout.backWidth, plan.layout.backHeight);
    const fit = fitRoomFrame(plan.layout, plan.model, photo.width, photo.height);
    if (mode === "max") {
      const rect = maxInscribedRect(fit.corners);
      if (rect) return fitOutputSize(Math.round(rect.width), Math.round(rect.height));
    }
    return fitOutputSize(fit.width, fit.height);
  }
  if (mode === "crop") return fitOutputSize(plan.rect.width, plan.rect.height);
  const fit = fitFrame(plan.H, photo.width, photo.height);
  if (mode === "max") {
    const rect = maxInscribedRect(fit.corners);
    if (rect) return fitOutputSize(Math.round(rect.width), Math.round(rect.height));
  }
  return fitOutputSize(fit.width, fit.height);
}

function frameNoteText() {
  const mode = frameMode();
  if (mode === "max") return "Largest straight rectangle that sits fully inside the straightened photo, with no empty corners.";
  if (mode === "crop") return "Exports only the surface you marked.";
  if (mode === "ai") return "Uses the whole-frame view, then fills the empty corners with LaMa. Until you run it, the preview is the scale-to-fit result.";
  return "Scales the whole straightened photo so every edge stays inside the frame. Empty corners stay transparent in PNG and white in JPEG.";
}

async function download() {
  const plan = currentPlan();
  const size = plan && exportSize(plan);
  if (!plan || !size) return;
  setExportEnabled(false);
  const previous = downloadButton.textContent;
  downloadButton.textContent = "Rendering…";
  setStatus("Rendering full resolution…");
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  try {
    let result = await renderPlan(plan, {
      onProgress: (amount) => {
        downloadButton.textContent = `Rendering ${Math.round(amount * 100)}%`;
      },
    });
    const jpeg = jpegSelected();
    const output = presentCanvas(displaySource() || result.canvas);
    const blob = await canvasToBlob(output, jpeg ? "image/jpeg" : "image/png", Number(quality.value) / 100);
    if (!blob) throw new Error("The browser could not encode the file.");
    const extension = jpeg ? "jpg" : "png";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${safeStem(photo.name)}-straighten.${extension}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 4000);
    const capped = result.capped ? " The browser capped the long edge, so this is slightly under full resolution." : "";
    setStatus(`Saved ${result.width.toLocaleString()} × ${result.height.toLocaleString()} ${extension.toUpperCase()}.${capped}`);
    rendererNote.textContent = result.renderer === "webgl" ? "WebGL" : "CPU";
  } catch (error) {
    setStatus(error.message || "Could not save the file.", true);
  } finally {
    setExportEnabled(true);
    downloadButton.textContent = previous;
  }
}

async function downloadZip() {
  if (!window.JSZip) {
    setStatus("The ZIP library did not load. Check the network and try again.", true);
    return;
  }
  const plan = currentPlan();
  const size = plan && exportSize(plan);
  if (!plan || !size) return;
  setExportEnabled(false);
  zipButton.textContent = "Rendering…";
  setStatus("Rendering full resolution…");
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  try {
    let result = await renderPlan(plan, {});
    const output = presentCanvas(displaySource() || result.canvas);
    const pixels = output.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, output.width, output.height);
    const packed = buildMask(pixels.data, output.width, output.height);
    const zip = new window.JSZip();
    const jpeg = await canvasToBlob(output, "image/jpeg", Number(quality.value) / 100);
    if (!jpeg) throw new Error("The browser could not encode the JPEG.");
    zip.file("straightened.jpg", jpeg);
    if (packed.hasEmpty) {
      const png = await canvasToBlob(output, "image/png");
      if (!png) throw new Error("The browser could not encode the transparent PNG.");
      zip.file("straightened_alpha.png", png);
    }
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = output.width;
    maskCanvas.height = output.height;
    maskCanvas.getContext("2d").putImageData(new ImageData(packed.mask, output.width, output.height), 0, 0);
    const maskBlob = await canvasToBlob(maskCanvas, "image/png");
    if (!maskBlob) throw new Error("The browser could not encode the mask.");
    zip.file("mask.png", maskBlob);
    saveBlob(await zip.generateAsync({ type: "blob" }), "straighten.zip");
    setStatus(packed.hasEmpty
      ? "Saved straighten.zip with the JPEG, transparent PNG, and mask."
      : "Saved straighten.zip with the JPEG and mask.");
  } catch (error) {
    setStatus(error.message || "Could not build the ZIP.", true);
  } finally {
    setExportEnabled(true);
    zipButton.textContent = "Download ZIP";
  }
}

function setExportEnabled(enabled) {
  downloadButton.disabled = !enabled;
  zipButton.disabled = !enabled;
}

function saveBlob(blob, name) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 4000);
}

function canvasToBlob(canvas, type, qualityValueNumber) {
  if (type !== "image/jpeg") {
    return new Promise((resolve) => canvas.toBlob(resolve, type));
  }
  const matte = document.createElement("canvas");
  matte.width = canvas.width;
  matte.height = canvas.height;
  const ctx = matte.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, matte.width, matte.height);
  ctx.drawImage(canvas, 0, 0);
  return new Promise((resolve) => matte.toBlob(resolve, type, qualityValueNumber));
}

function markCorners(state) {
  const roomEl = $("pick-room");
  const box = Boolean(roomEl && roomEl.checked);
  const count = state.points.length + (box ? (state.near || []).length : 0);
  const total = box ? 8 : 4;
  const labels = box
    ? ["Back top left", "Back top right", "Back bottom left", "Back bottom right",
      "Near ceiling left", "Near ceiling right", "Near floor left", "Near floor right"]
    : state.loopOrder
      ? ["Top left", "Top right", "Bottom right", "Bottom left"]
      : ["Top left", "Top right", "Bottom left", "Bottom right"];
  corners.querySelectorAll("li").forEach((item, index) => {
    item.hidden = index >= total;
    if (labels[index]) item.textContent = labels[index];
    item.classList.toggle("done", index < count);
    item.classList.toggle("active", index === count && count < total);
  });
  const diagram = $("box-diagram");
  if (!diagram) return;
  diagram.hidden = !box;
  diagram.querySelectorAll("circle").forEach((circle) => {
    const index = Number(circle.dataset.corner);
    circle.classList.toggle("done", index < count);
    circle.classList.toggle("next", index === count && count < 8);
  });
}

function eventToCanvasPixel(canvas, event) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1 || canvas.width < 1) return null;
  const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height);
  const drawnW = canvas.width * scale;
  const drawnH = canvas.height * scale;
  const originX = rect.left + (rect.width - drawnW) / 2;
  const originY = rect.top + (rect.height - drawnH) / 2;
  const x = (event.clientX - originX) / scale;
  const y = (event.clientY - originY) / scale;
  if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

function showAiProgress(message) {
  aiStatus.textContent = message;
  console.info("[AI fill]", message);
}

function showAiBanner(message) {
  const banner = $("ai-banner");
  if (!banner) return;
  banner.hidden = !message;
  banner.textContent = message || "";
  if (message) console.error("[AI fill]", message);
}

async function runAiFill() {
  if (aiAbort) return;
  aiFillOn = true;
  aiPanel.hidden = false;
  const plan = currentPlan();
  if (!plan) {
    showAiBanner("Place the four corners first.");
    showAiProgress("");
    return;
  }
  const controller = new AbortController();
  aiAbort = controller;
  aiRun.disabled = true;
  aiCancel.hidden = false;
  showAiBanner("");
  let predictionId = "";
  let fileIds = [];
  try {
    const health = buildHealthRequest();
    console.info("[AI fill] GET", health.url);
    let healthBody = null;
    try {
      const healthResponse = await fetch(health.url, { method: health.method, signal: controller.signal });
      healthBody = await readAiPayload(healthResponse);
      console.info("[AI fill] health", healthResponse.status, healthBody.payload);
      if (!healthResponse.ok) throw formatAiError({ status: healthResponse.status, payload: healthBody.payload });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      if (error instanceof TypeError) throw Object.assign(new Error(formatAiError({ network: true })), { ai: true });
      throw error.ai ? error : Object.assign(new Error(String(error.message || error)), { ai: true });
    }
    if (healthBody && healthBody.payload && healthBody.payload.tokenPresent === false) {
      throw Object.assign(new Error("REPLICATE_API_TOKEN is not set."), { ai: true });
    }
    showAiProgress("Sending to Replicate…");
    const rendered = await renderPlan(plan, { maxEdge: 1536 });
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    lastWarp = rendered.canvas;
    const encoded = buildInpaintPayload(lastWarp);
    const request = buildInpaintRequest(encoded.image, encoded.mask);
    console.info("[AI fill] POST", request.url);
    let response;
    try {
      response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      });
    } catch (error) {
      if (error.name === "AbortError") throw error;
      throw Object.assign(new Error(formatAiError({ network: true })), { ai: true });
    }
    let body = await readAiBody(response);
    predictionId = body.id || "";
    fileIds = body.fileIds || [];
    const started = Date.now();
    while (body.status === "starting" || body.status === "processing") {
      if (Date.now() - started > 90000) {
        throw Object.assign(new Error(formatAiError({ timeout: true })), { ai: true });
      }
      showAiProgress("Processing…");
      await delay(1500, controller.signal);
      const poll = buildPollRequest(body.id, fileIds);
      console.info("[AI fill] GET", poll.url);
      let pollResponse;
      try {
        pollResponse = await fetch(poll.url, { method: poll.method, signal: controller.signal });
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw Object.assign(new Error(formatAiError({ network: true })), { ai: true });
      }
      body = await readAiBody(pollResponse);
    }
    if (body.status !== "succeeded" || !body.output) {
      throw Object.assign(new Error(formatAiError({
        status: body.code,
        empty: body.status === "succeeded" && !body.output,
        payload: body,
      })), { ai: true });
    }
    aiCanvas = await compositeAiResult(lastWarp, body.output);
    aiKey = warpKey();
    const adjusted = presentCanvas(aiCanvas);
    previewCanvas.hidden = false;
    previewEmpty.hidden = true;
    previewCanvas.width = adjusted.width;
    previewCanvas.height = adjusted.height;
    previewCanvas.getContext("2d").drawImage(adjusted, 0, 0);
    showAiBanner("");
    showAiProgress("Done");
  } catch (error) {
    aiCanvas = null;
    if (error.name === "AbortError") {
      showAiBanner("");
      showAiProgress("Cancelled. Showing the scale-to-fit result.");
      if (predictionId) {
        const poll = buildPollRequest(predictionId, fileIds);
        fetch(`${poll.url}&cancel=1`).catch(() => {});
      }
    } else {
      showAiBanner(error.message || formatAiError({}));
      showAiProgress("");
    }
  } finally {
    aiAbort = null;
    aiCancel.hidden = true;
    aiRun.disabled = false;
  }
}

async function readAiBody(response) {
  const parsed = await readAiPayload(response);
  console.info("[AI fill] response", response.status, parsed.payload && parsed.payload.status, parsed.payload && parsed.payload.stage);
  if (!response.ok || parsed.payload.status === "failed") {
    const message = formatAiError({ status: parsed.payload.code || response.status, payload: parsed.payload });
    throw Object.assign(new Error(message), { ai: true });
  }
  return parsed.payload;
}

async function readAiPayload(response) {
  const text = await response.text();
  if (!text) return { payload: {} };
  try {
    return { payload: JSON.parse(text) };
  } catch {
    return { payload: { error: text.slice(0, 280) } };
  }
}

function buildInpaintPayload(source) {
  let maxSide = 1536;
  let encoded = encodeInpaintPair(source, maxSide);
  while ((encoded.image.length > 3_500_000 || encoded.mask.length > 3_500_000) && maxSide > 512) {
    maxSide = Math.round(maxSide * 0.75);
    encoded = encodeInpaintPair(source, maxSide);
  }
  return encoded;
}

function encodeInpaintPair(source, maxSide) {
  const fitted = fitLongSide(source.width, source.height, maxSide);
  const canvas = document.createElement("canvas");
  canvas.width = fitted.width;
  canvas.height = fitted.height;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(source, 0, 0, fitted.width, fitted.height);
  const image = ctx.getImageData(0, 0, fitted.width, fitted.height);
  const packed = maskFromAlpha(image.data);
  const flat = compositeOnWhite(image.data);
  return {
    image: canvasToPngDataUrl(flat, fitted.width, fitted.height),
    mask: canvasToPngDataUrl(packed.mask, fitted.width, fitted.height),
  };
}

function canvasToPngDataUrl(pixels, width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d").putImageData(new ImageData(pixels, width, height), 0, 0);
  return canvas.toDataURL("image/png");
}

async function compositeAiResult(original, dataUrl) {
  const aiImage = await loadDataImage(dataUrl);
  const width = original.width;
  const height = original.height;
  const scaled = document.createElement("canvas");
  scaled.width = width;
  scaled.height = height;
  const ctx = scaled.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(aiImage, 0, 0, width, height);
  const originalData = original.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, width, height);
  const aiData = ctx.getImageData(0, 0, width, height);
  const merged = compositeFill(originalData.data, aiData.data, maskFromAlpha(originalData.data).mask);
  const out = document.createElement("canvas");
  out.width = width;
  out.height = height;
  out.getContext("2d").putImageData(new ImageData(merged, width, height), 0, 0);
  return out;
}

function loadDataImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the filled image. Showing the scale-to-fit result."));
    image.src = src;
  });
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function frameMode() {
  if (aiFillOn) return "ai";
  const selected = document.querySelector('input[name="frame"]:checked');
  return selected ? selected.value : "full";
}

function warpMode() {
  return frameMode() === "ai" ? "full" : frameMode();
}

function jpegSelected() {
  return document.querySelector('input[name="format"]:checked').value === "jpeg";
}

function realValues() {
  return {
    width: realWidth.value.trim() === "" ? NaN : Number(realWidth.value),
    height: realHeight.value.trim() === "" ? NaN : Number(realHeight.value),
  };
}

function filled(input) {
  return input.value.trim() !== "";
}

function formatRatio(aspect) {
  if (!Number.isFinite(aspect) || aspect <= 0) return "—";
  if (aspect >= 1) return `${aspect.toFixed(2)} : 1`;
  return `1 : ${(1 / aspect).toFixed(2)}`;
}

function safeStem(name) {
  const base = String(name || "photo").replace(/\.[^.]+$/, "");
  const clean = base.replace(/[^\w\-]+/g, "-").replace(/^-+|-+$/g, "");
  return clean || "photo";
}

function setStatus(message, isError) {
  statusEl.textContent = message || "";
  statusEl.classList.toggle("is-error", Boolean(isError) && Boolean(message));
}

function dragHasFiles(event) {
  return event.dataTransfer && [...event.dataTransfer.types].includes("Files");
}

function isImageFile(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (["image/jpeg", "image/jpg", "image/png", "image/webp", "image/heic", "image/heif"].includes(type)) {
    return true;
  }
  return /\.(jpe?g|png|webp|heic|heif)$/.test(name);
}

function isHeic(file) {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return type === "image/heic" || type === "image/heif" || /\.heic$|\.heif$/.test(name);
}

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { bitmap, width: bitmap.width, height: bitmap.height };
    } catch (error) {
      if (isHeic(file)) {
        throw new Error("This browser can’t decode HEIC. Export a JPEG from your camera roll and try again.");
      }
      try {
        const bitmap = await createImageBitmap(file);
        return { bitmap, width: bitmap.width, height: bitmap.height };
      } catch {
        // Fall through to an <img> decode, which can still read some JPEGs.
      }
    }
  }
  return decodeWithElement(file);
}

function decodeWithElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = async () => {
      URL.revokeObjectURL(url);
      try {
        const orientation = await readJpegOrientation(file);
        const canvas = drawOriented(img, orientation);
        const bitmap = typeof createImageBitmap === "function"
          ? await createImageBitmap(canvas)
          : canvas;
        resolve({ bitmap, width: canvas.width, height: canvas.height });
      } catch (error) {
        reject(error);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(isHeic(file)
        ? "This browser can’t decode HEIC. Export a JPEG from your camera roll and try again."
        : "Could not read that photo. Try a JPEG or PNG."));
    };
    img.src = url;
  });
}

function drawOriented(img, orientation) {
  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;
  const canvas = document.createElement("canvas");
  const swapped = orientation >= 5 && orientation <= 8;
  canvas.width = swapped ? h : w;
  canvas.height = swapped ? w : h;
  const ctx = canvas.getContext("2d");
  switch (orientation) {
    case 2:
      ctx.transform(-1, 0, 0, 1, w, 0);
      break;
    case 3:
      ctx.transform(-1, 0, 0, -1, w, h);
      break;
    case 4:
      ctx.transform(1, 0, 0, -1, 0, h);
      break;
    case 5:
      ctx.transform(0, 1, 1, 0, 0, 0);
      break;
    case 6:
      ctx.transform(0, 1, -1, 0, h, 0);
      break;
    case 7:
      ctx.transform(0, -1, -1, 0, h, w);
      break;
    case 8:
      ctx.transform(0, -1, 1, 0, 0, w);
      break;
    default:
      break;
  }
  ctx.drawImage(img, 0, 0);
  return canvas;
}

async function readJpegOrientation(file) {
  if (!/jpe?g$/i.test(file.name || "") && !/jpeg/.test(file.type || "")) return 1;
  const buffer = await file.slice(0, 256 * 1024).arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return 1;
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    const marker = view.getUint16(offset);
    if (marker === 0xffda || marker === 0xffd9) break;
    if ((marker & 0xff00) !== 0xff00) break;
    const size = view.getUint16(offset + 2);
    if (marker === 0xffe1) return orientationFromExif(view, offset + 4, size - 2);
    if (size < 2) break;
    offset += 2 + size;
  }
  return 1;
}

function orientationFromExif(view, start, length) {
  if (view.byteLength < start + 14) return 1;
  if (view.getUint32(start) !== 0x45786966) return 1;
  const tiff = start + 6;
  const endian = view.getUint16(tiff);
  const little = endian === 0x4949;
  const u16 = (offset) => view.getUint16(offset, little);
  const u32 = (offset) => view.getUint32(offset, little);
  if (tiff + 8 > view.byteLength || u16(tiff + 2) !== 0x002a) return 1;
  let ifd = tiff + u32(tiff + 4);
  const end = Math.min(view.byteLength, start + length);
  if (ifd + 2 > end) return 1;
  const count = u16(ifd);
  ifd += 2;
  for (let i = 0; i < count; i++) {
    const entry = ifd + i * 12;
    if (entry + 12 > view.byteLength) break;
    if (u16(entry) === 0x0112) return u16(entry + 8);
  }
  return 1;
}
