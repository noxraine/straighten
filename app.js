import {
  blendTowardIdentity,
  fitFrame,
  planRectangle,
  quadProblem,
  rectangleTargets,
  solveHomography,
} from "./homography.js";
import { createPointPicker } from "./point-picker.js";
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
const quality = $("quality");
const qualityValue = $("quality-value");
const qualityRow = $("quality-row");
const strength = $("strength");
const strengthValue = $("strength-value");
const frameNote = $("frame-note");
const roomButton = $("room-button");
const statusEl = $("status");
const veil = $("veil");

const picker = createPointPicker($("source-canvas"), {
  loupe: $("loupe"),
  onChange: (state) => {
    latest = state;
    undoButton.disabled = !state.canUndo;
    hint.textContent = state.prompt;
    markCorners(state.points.length);
    schedulePreview(state.dragging);
  },
});

let photo = null;
let latest = { points: [], dragging: false, canUndo: false, prompt: "" };
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
downloadButton.addEventListener("click", () => download());

for (const input of [realWidth, realHeight, quality, strength]) {
  input.addEventListener("input", () => {
    if (input === quality) qualityValue.textContent = `${quality.value}%`;
    if (input === strength) strengthValue.textContent = `${strength.value}%`;
    schedulePreview(false);
  });
}
for (const input of document.querySelectorAll('input[name="frame"], input[name="format"]')) {
  input.addEventListener("change", () => {
    qualityRow.hidden = !jpegSelected();
    downloadButton.textContent = jpegSelected() ? "Download JPEG" : "Download PNG";
    frameNote.textContent = frameMode() === "full"
      ? "Straightens the marked surface and keeps the rest of the room in frame. Empty corners stay transparent in PNG and white in JPEG."
      : "Exports only the surface you marked.";
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
    downloadButton.disabled = true;
    return;
  }
  const frame = $("preview-frame").getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const longest = Math.max(frame.width, frame.height, 320) * dpr;
  const maxEdge = fast ? Math.min(900, longest) : Math.min(1800, Math.max(640, longest));
  try {
    const result = await renderWarp(photo.bitmap, photo.width, photo.height, plan.H, {
      mode: frameMode(),
      destWidth: plan.rect.width,
      destHeight: plan.rect.height,
      maxEdge,
    });
    if (previewDirty) return;
    showPreview(result);
    const full = exportSize(plan);
    exportMeta.textContent = full
      ? `${full.width.toLocaleString()} × ${full.height.toLocaleString()} px`
      : "—";
    rendererNote.textContent = result.renderer === "webgl" ? "WebGL" : "CPU";
    downloadButton.disabled = !full;
    if (!latest.dragging) {
      if (result.clamped && frameMode() === "full") {
        setStatus("The perspective runs off the edge of the shot, so that part was held in. The rest of the photo stays in frame.");
      } else {
        setStatus("");
      }
    }
  } catch (error) {
    showPreview(null);
    downloadButton.disabled = true;
    setStatus(error.message || "Could not build the preview.", true);
  }
}

function showPreview(result) {
  if (!result) {
    previewCanvas.hidden = true;
    previewEmpty.hidden = false;
    rendererNote.textContent = "";
    return;
  }
  previewEmpty.hidden = true;
  previewCanvas.hidden = false;
  previewCanvas.width = result.canvas.width;
  previewCanvas.height = result.canvas.height;
  const ctx = previewCanvas.getContext("2d");
  ctx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  ctx.drawImage(result.canvas, 0, 0);
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
    downloadButton.disabled = true;
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
  if (frameMode() === "full") {
    const fit = fitFrame(plan.H, photo.width, photo.height);
    return fitOutputSize(fit.width, fit.height);
  }
  return fitOutputSize(plan.rect.width, plan.rect.height);
}

async function download() {
  const plan = currentPlan();
  const size = plan && exportSize(plan);
  if (!plan || !size) return;
  downloadButton.disabled = true;
  const previous = downloadButton.textContent;
  downloadButton.textContent = "Rendering…";
  setStatus("Rendering full resolution…");
  await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  try {
    const result = await renderWarp(photo.bitmap, photo.width, photo.height, plan.H, {
      mode: frameMode(),
      destWidth: plan.rect.width,
      destHeight: plan.rect.height,
      onProgress: (amount) => {
        downloadButton.textContent = `Rendering ${Math.round(amount * 100)}%`;
      },
    });
    const jpeg = jpegSelected();
    const blob = await canvasToBlob(result.canvas, jpeg ? "image/jpeg" : "image/png", Number(quality.value) / 100);
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
    downloadButton.disabled = false;
    downloadButton.textContent = previous;
  }
}

function canvasToBlob(canvas, type, qualityValueNumber) {
  if (type !== "image/jpeg") {
    return new Promise((resolve) => canvas.toBlob(resolve, type));
  }
  const matte = document.createElement("canvas");
  matte.width = canvas.width;
  matte.height = canvas.height;
  const ctx = matte.getContext("2d");
  ctx.fillStyle = "#f4f1eb";
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

function frameMode() {
  return document.querySelector('input[name="frame"]:checked').value;
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
