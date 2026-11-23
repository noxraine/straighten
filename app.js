import {
  blendTowardIdentity,
  fitFrame,
  maxInscribedRect,
  planRectangle,
  quadProblem,
  rectangleTargets,
  solveHomography,
} from "./homography.js";
import { blendMasked, floorHomography, polygonMask, sideHomography } from "./planes.js";
import { createPointPicker } from "./point-picker.js";
import { adjustCanvas, buildMask, compositeOnWhite, patchAverage, whiteBalanceGains } from "./adjust.js";
import { compositeFill, fitLongSide, maskFromAlpha } from "./netlify/functions/inpaint-logic.js";
import { fitOutputSize, renderWarp } from "./warp.js";

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
    if (!state.roomMode) {
      latest.floor = [];
      latest.side = [];
    }
    undoButton.disabled = !state.canUndo;
    hint.textContent = state.prompt;
    markCorners(state.points.length);
    schedulePreview(state.dragging);
  },
});

let photo = null;
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
for (const input of document.querySelectorAll('input[name="pick"]')) {
  input.addEventListener("change", () => {
    const on = $("pick-room").checked;
    $("room-steps").hidden = !on;
    picker.setRoomMode(on);
  });
}
$("skip-floor").addEventListener("click", () => picker.skipFloor());
$("skip-side").addEventListener("click", () => picker.skipSide());
$("side-done").addEventListener("click", () => picker.acceptSide());
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
aiRun.addEventListener("click", () => runAiFill());
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
    aiPanel.hidden = frameMode() !== "ai";
    if (frameMode() !== "ai") aiCanvas = null;
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
    if (photo && photo.bitmap && photo.bitmap.close) photo.bitmap.close();
    photo = {
      bitmap: decoded.bitmap,
      width: decoded.width,
      height: decoded.height,
      name: file.name || "photo",
    };
    dropzone.hidden = true;
    workspace.hidden = false;
    fileMeta.textContent = `${photo.width.toLocaleString()} × ${photo.height.toLocaleString()}`;
    picker.setImage(photo.bitmap, photo.width, photo.height);
    setStatus("");
    requestAnimationFrame(() => picker.redraw());
  } catch (error) {
    setStatus(error.message || "Could not read that photo.", true);
  } finally {
    dropzone.classList.remove("busy");
  }
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
    let result = await renderWarp(photo.bitmap, photo.width, photo.height, plan.H, {
      mode: warpMode(),
      destWidth: plan.rect.width,
      destHeight: plan.rect.height,
      maxEdge,
    });
    if (previewDirty) return;
    if (usesExtraPlanes()) result = { ...result, canvas: await compositeRoom(result, plan) };
    showPreview(result);
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

function showPreview(result) {
  if (!result) {
    lastWarp = null;
    previewCanvas.hidden = true;
    previewEmpty.hidden = false;
    rendererNote.textContent = "";
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
  return `${photo.width}x${photo.height}|${strength.value}|${points}`;
}

function currentPlan() {
  if (!photo || latest.points.length !== 4) return null;
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
  let H;
  try {
    H = homographyFor(latest.points, rect);
  } catch (error) {
    setStatus(error.message, true);
    return null;
  }
  return { rect, H };
}

function homographyFor(points, rect) {
  return blendTowardIdentity(
    solveHomography(points, rectangleTargets(rect.width, rect.height)),
    Number(strength.value) / 100,
  );
}

function refreshReadouts() {
  const count = latest.points.length;
  if (count < 4) {
    aspectReadout.textContent = "—";
    proportionNote.textContent = "The estimate appears once all four corners are placed.";
    exportMeta.textContent = "—";
    setExportEnabled(false);
    if (count === 0) setStatus("");
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
  if (rect.measured) {
    proportionNote.textContent = "Locked to the width and height you entered. Only the ratio is used.";
  } else if (filled(realWidth) !== filled(realHeight)) {
    proportionNote.textContent = "Enter both width and height to lock the ratio. Any unit is fine.";
  } else {
    proportionNote.textContent = `From the quad’s edges (${formatRatio(rect.estimated)}). Enter a real width and height if you know them.`;
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
  if (!photo || !plan) return null;
  const mode = frameMode();
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
    let result = await renderWarp(photo.bitmap, photo.width, photo.height, plan.H, {
      mode: warpMode(),
      destWidth: plan.rect.width,
      destHeight: plan.rect.height,
      onProgress: (amount) => {
        downloadButton.textContent = `Rendering ${Math.round(amount * 100)}%`;
      },
    });
    if (usesExtraPlanes()) result = { ...result, canvas: await compositeRoom(result, plan) };
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
    let result = await renderWarp(photo.bitmap, photo.width, photo.height, plan.H, {
      mode: warpMode(),
      destWidth: plan.rect.width,
      destHeight: plan.rect.height,
    });
    if (usesExtraPlanes()) result = { ...result, canvas: await compositeRoom(result, plan) };
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

function markCorners(count) {
  const items = corners.querySelectorAll("li");
  items.forEach((item, index) => {
    item.classList.toggle("done", index < count);
    item.classList.toggle("active", index === count && count < 4);
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

async function runAiFill() {
  if (!lastWarp) {
    aiStatus.textContent = "Place the four corners first.";
    return;
  }
  const controller = new AbortController();
  aiAbort = controller;
  aiRun.disabled = true;
  aiCancel.hidden = false;
  let predictionId = "";
  let fileIds = [];
  try {
    aiStatus.textContent = "Preparing the image…";
    const payload = buildInpaintPayload(lastWarp);
    aiStatus.textContent = "Sending to Replicate…";
    let body = await inpaintRequest("POST", payload, controller.signal);
    predictionId = body.id || "";
    fileIds = body.fileIds || [];
    const started = Date.now();
    while (body.status === "starting" || body.status === "processing") {
      if (Date.now() - started > 90000) {
        throw new Error("Timed out after 90 seconds. Showing the scale-to-fit result.");
      }
      aiStatus.textContent = "Filling the empty corners…";
      await delay(1500, controller.signal);
      const files = encodeURIComponent(fileIds.join(","));
      body = await inpaintRequest("GET", null, controller.signal, `?id=${encodeURIComponent(body.id)}&files=${files}`);
    }
    if (body.status !== "succeeded" || !body.output) {
      throw new Error(body.error || "Inpainting failed. Showing the scale-to-fit result.");
    }
    aiStatus.textContent = "Placing the fill back on the photo…";
    aiCanvas = await compositeAiResult(lastWarp, body.output);
    aiKey = warpKey();
    const adjusted = presentCanvas(aiCanvas);
    previewCanvas.width = adjusted.width;
    previewCanvas.height = adjusted.height;
    previewCanvas.getContext("2d").drawImage(adjusted, 0, 0);
    aiStatus.textContent = "Empty corners filled.";
  } catch (error) {
    aiCanvas = null;
    if (error.name === "AbortError") {
      aiStatus.textContent = "Cancelled. Showing the scale-to-fit result.";
      if (predictionId) {
        const files = encodeURIComponent(fileIds.join(","));
        fetch(`/.netlify/functions/inpaint?id=${encodeURIComponent(predictionId)}&files=${files}&cancel=1`).catch(() => {});
      }
    } else {
      aiStatus.textContent = error.message || "Inpainting failed. Showing the scale-to-fit result.";
    }
  } finally {
    aiAbort = null;
    aiCancel.hidden = true;
    aiRun.disabled = false;
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

async function inpaintRequest(method, body, signal, query = "") {
  const response = await fetch(`/.netlify/functions/inpaint${query}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401 || response.status === 402 || payload.code === 401 || payload.code === 402) {
    const code = payload.code || response.status;
    throw new Error(`AI fill unavailable: Replicate account error ${code}`);
  }
  if (!response.ok && payload.status !== "failed") {
    throw new Error(payload.error || `Inpaint failed (${response.status}). Showing the scale-to-fit result.`);
  }
  if (payload.status === "failed") {
    throw new Error(payload.error || "Inpainting failed. Showing the scale-to-fit result.");
  }
  return payload;
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
  return document.querySelector('input[name="frame"]:checked').value;
}

function warpMode() {
  return frameMode() === "ai" ? "full" : frameMode();
}

function usesExtraPlanes() {
  if (!$("pick-room").checked) return false;
  const floor = latest.floor || [];
  const side = latest.side || [];
  return floor.length === 4 || side.length === 2 || side.length === 4;
}

async function compositeRoom(wallResult, plan) {
  const frame = wallResult.frame;
  let pixels = wallResult.canvas.getContext("2d", { willReadFrequently: true })
    .getImageData(0, 0, frame.width, frame.height).data;
  const paint = async (H, destination) => {
    const warped = await renderWarp(photo.bitmap, photo.width, photo.height, H, {
      outputFrame: frame,
      maxEdge: Infinity,
    });
    const overlay = warped.canvas.getContext("2d", { willReadFrequently: true })
      .getImageData(0, 0, frame.width, frame.height).data;
    const polygon = destination.map((point) => ({
      x: ((point.x - frame.originX) / frame.spanX) * frame.width,
      y: ((point.y - frame.originY) / frame.spanY) * frame.height,
    }));
    pixels = blendMasked(pixels, overlay, polygonMask(frame.width, frame.height, polygon, 6));
  };
  const floor = latest.floor || [];
  const side = latest.side || [];
  if (floor.length === 4) {
    const built = floorHomography(latest.points, floor, plan.rect.width, plan.rect.height);
    await paint(built.H, built.destination);
  }
  if (side.length === 2 || side.length === 4) {
    const built = sideHomography(latest.points, side, plan.rect.width, plan.rect.height);
    await paint(built.H, built.destination);
  }
  const canvas = document.createElement("canvas");
  canvas.width = frame.width;
  canvas.height = frame.height;
  canvas.getContext("2d").putImageData(new ImageData(pixels, frame.width, frame.height), 0, 0);
  return canvas;
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
