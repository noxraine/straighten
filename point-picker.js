/**
 * Four-corner picker. Click order is fixed:
 * top-left, top-right, bottom-left, bottom-right.
 * Corners stay draggable. A loupe follows the pointer while aiming or dragging.
 */

const PROMPTS = [
  "Click the top-left corner",
  "Click the top-right corner",
  "Click the bottom-left corner",
  "Click the bottom-right corner",
  "Drag any corner to adjust",
];

const POINT_COLORS = ["#9c3d2e", "#234838", "#3a5274", "#8a5a28"];
const FLOOR_COLORS = ["#1d4e63", "#2a6f8f", "#3d8ea8", "#67b0c4"];
const SIDE_COLORS = ["#4e3560", "#6b4c7a", "#8d6a9a", "#b794c4"];
const FLOOR_PROMPTS = [
  "Step 2/3: click the near-left floor corner",
  "Step 2/3: click the near-right floor corner",
  "Step 2/3: click the far-left floor corner, on the wall",
  "Step 2/3: click the far-right floor corner, on the wall",
  "Drag a floor corner to adjust",
];
const SIDE_PROMPTS = [
  "Step 3/3: click the side wall's outer top corner",
  "Step 3/3: click the side wall's outer bottom corner",
  "Step 3/3: click the shared top corner, or use these two points",
  "Step 3/3: click the shared bottom corner",
  "Drag a side-wall corner to adjust",
];

export function createPointPicker(canvas, { loupe, onChange }) {
  const loupeCanvas = loupe.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const loupeCtx = loupeCanvas.getContext("2d");

  let image = null;
  let fit = null;
  let points = [];
  let floorPoints = [];
  let sidePoints = [];
  let roomMode = false;
  let roomStep = 0;
  let undoStack = [];
  let dragIndex = -1;
  let dragList = null;
  let dragMoved = false;
  let placing = false;
  let activePointer = null;

  const parent = canvas.parentElement;
  const observer = new ResizeObserver(() => draw());
  observer.observe(parent);

  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());

  function setImage(bitmap, width, height) {
    image = { bitmap, width, height };
    points = [];
    floorPoints = [];
    sidePoints = [];
    roomStep = 0;
    undoStack = [];
    dragIndex = -1;
    dragList = null;
    placing = false;
    draw();
    emit(false);
  }

  function undo() {
    if (dragIndex >= 0 || undoStack.length === 0) return false;
    const previous = undoStack.pop();
    points = previous.points;
    floorPoints = previous.floor;
    sidePoints = previous.side;
    roomStep = previous.step;
    draw();
    emit(false);
    return true;
  }

  function reset() {
    if (points.length === 0 && floorPoints.length === 0 && sidePoints.length === 0 && undoStack.length === 0) return;
    snapshot();
    points = [];
    floorPoints = [];
    sidePoints = [];
    roomStep = 0;
    dragIndex = -1;
    dragList = null;
    placing = false;
    draw();
    emit(false);
  }

  function snapshot() {
    undoStack.push({
      points: points.map((p) => ({ x: p.x, y: p.y })),
      floor: floorPoints.map((p) => ({ x: p.x, y: p.y })),
      side: sidePoints.map((p) => ({ x: p.x, y: p.y })),
      step: roomStep,
    });
    if (undoStack.length > 40) undoStack.shift();
  }

  function setRoomMode(on) {
    roomMode = Boolean(on);
    if (!roomMode) {
      floorPoints = [];
      sidePoints = [];
      roomStep = 0;
    } else if (points.length >= 4 && roomStep === 0) {
      roomStep = 1;
    }
    draw();
    emit(false);
  }

  function skipFloor() {
    if (!roomMode) return;
    snapshot();
    floorPoints = [];
    roomStep = 2;
    draw();
    emit(false);
  }

  function skipSide() {
    if (!roomMode) return;
    snapshot();
    sidePoints = [];
    roomStep = 3;
    draw();
    emit(false);
  }

  function acceptSide() {
    if (!roomMode || sidePoints.length < 2) return;
    snapshot();
    roomStep = 3;
    draw();
    emit(false);
  }

  function emit(dragging) {
    onChange({
      points: points.map((p) => ({ x: p.x, y: p.y })),
      dragging,
      canUndo: undoStack.length > 0,
      floor: floorPoints.map((p) => ({ x: p.x, y: p.y })),
      side: sidePoints.map((p) => ({ x: p.x, y: p.y })),
      roomMode,
      roomStep,
      prompt: roomPrompt(),
    });
  }

  function roomPrompt() {
    if (!roomMode) return PROMPTS[Math.min(points.length, PROMPTS.length - 1)];
    if (roomStep <= 0) return points.length < 4 ? PROMPTS[points.length] : "Step 1/3 complete. The floor is next.";
    if (roomStep === 1) return FLOOR_PROMPTS[Math.min(floorPoints.length, FLOOR_PROMPTS.length - 1)];
    if (roomStep === 2) return SIDE_PROMPTS[Math.min(sidePoints.length, SIDE_PROMPTS.length - 1)];
    return "Drag any corner to adjust";
  }

  function draw() {
    const rect = parent.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(2, Math.round(rect.width * dpr));
    const ch = Math.max(2, Math.round(rect.height * dpr));
    if (cw < 4 || ch < 4) return;
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw;
      canvas.height = ch;
    }
    ctx.clearRect(0, 0, cw, ch);
    if (!image) return;

    fit = contain(cw, ch, image.width, image.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image.bitmap, fit.x, fit.y, fit.w, fit.h);

    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    strokeGroup(points, [[0, 1], [1, 3], [3, 2], [2, 0]], "#1c1914", dpr);
    strokeGroup(floorPoints, [[0, 1], [1, 3], [3, 2], [2, 0]], "#1d4e63", dpr);
    strokeGroup(sidePoints, [[0, 1], [0, 2], [1, 3], [2, 3]], "#4e3560", dpr);
    drawDots(points, POINT_COLORS, dpr);
    drawDots(floorPoints, FLOOR_COLORS, dpr);
    drawDots(sidePoints, SIDE_COLORS, dpr);
  }

  function strokeGroup(group, edges, color, dpr) {
    for (const [a, b] of edges) {
      if (!group[a] || !group[b]) continue;
      const p = toCanvas(group[a]);
      const q = toCanvas(group[b]);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.strokeStyle = "rgba(255, 250, 244, 0.92)";
      ctx.lineWidth = 5 * dpr;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.75 * dpr;
      ctx.stroke();
    }
  }

  function drawDots(group, colors, dpr) {
    for (let i = 0; i < group.length; i++) {
      const p = toCanvas(group[i]);
      const radius = 8 * dpr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      ctx.lineWidth = 2 * dpr;
      ctx.strokeStyle = "#fffaf4";
      ctx.stroke();
      ctx.fillStyle = "#fffaf4";
      ctx.font = `600 ${11 * dpr}px Outfit, "Avenir Next", sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), p.x, p.y + 0.5 * dpr);
    }
  }

  function contain(cw, ch, iw, ih) {
    const scale = Math.min(cw / iw, ch / ih);
    const w = iw * scale;
    const h = ih * scale;
    return { x: (cw - w) / 2, y: (ch - h) / 2, w, h, scale };
  }

  function toCanvas(p) {
    return { x: fit.x + p.x * fit.scale, y: fit.y + p.y * fit.scale };
  }

  function eventToImage(event, clampToPhoto) {
    if (!fit || !image) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    const cx = (event.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (event.clientY - rect.top) * (canvas.height / rect.height);
    let x = (cx - fit.x) / fit.scale;
    let y = (cy - fit.y) / fit.scale;
    const outside = x < 0 || y < 0 || x > image.width || y > image.height;
    if (outside && !clampToPhoto) return null;
    if (clampToPhoto) {
      x = Math.min(image.width, Math.max(0, x));
      y = Math.min(image.height, Math.max(0, y));
    }
    return { x, y };
  }

  function hitTest(imgPt, pointerType) {
    const rect = canvas.getBoundingClientRect();
    const screenPerImage = fit.scale * (rect.width / canvas.width);
    if (!(screenPerImage > 0)) return -1;
    const slop = (pointerType === "touch" ? 32 : 16) / screenPerImage;
    let best = null;
    let bestDist = slop;
    for (const list of [points, floorPoints, sidePoints]) {
      for (let i = 0; i < list.length; i++) {
        const dist = Math.hypot(list[i].x - imgPt.x, list[i].y - imgPt.y);
        if (dist <= bestDist) {
          bestDist = dist;
          best = { list, index: i };
        }
      }
    }
    return best;
  }

  function canPlace() {
    if (!roomMode) return points.length < 4;
    if (roomStep <= 0) return points.length < 4;
    if (roomStep === 1) return floorPoints.length < 4;
    if (roomStep === 2) return sidePoints.length < 4;
    return false;
  }

  function placePoint(imgPt) {
    if (!roomMode || roomStep <= 0) {
      points.push(imgPt);
      if (roomMode && points.length === 4) roomStep = 1;
      return;
    }
    if (roomStep === 1) {
      floorPoints.push(imgPt);
      if (floorPoints.length === 4) roomStep = 2;
      return;
    }
    sidePoints.push(imgPt);
    if (sidePoints.length === 4) roomStep = 3;
  }

  function onPointerDown(event) {
    if (!image || (activePointer !== null && event.pointerId !== activePointer)) return;
    const imgPt = eventToImage(event, false);
    if (!imgPt) return;
    event.preventDefault();
    activePointer = event.pointerId;
    canvas.setPointerCapture(event.pointerId);
    const hit = hitTest(imgPt, event.pointerType);
    if (hit) {
      snapshot();
      dragList = hit.list;
      dragIndex = hit.index;
      dragMoved = false;
      showLoupe(event, hit.list[hit.index]);
      return;
    }
    if (canPlace()) {
      placing = true;
      showLoupe(event, imgPt);
    }
  }

  function onPointerMove(event) {
    if (!image) return;
    if (activePointer !== null && event.pointerId !== activePointer) return;
    if (dragIndex >= 0) {
      const imgPt = eventToImage(event, true);
      if (!imgPt) return;
      event.preventDefault();
      dragList[dragIndex] = imgPt;
      dragMoved = true;
      draw();
      showLoupe(event, imgPt);
      emit(true);
      return;
    }
    if (placing) {
      const imgPt = eventToImage(event, true);
      if (imgPt) showLoupe(event, imgPt);
      return;
    }
  }

  function onPointerUp(event) {
    if (activePointer !== null && event.pointerId !== activePointer) return;
    if (dragIndex >= 0) {
      if (!dragMoved) undoStack.pop();
      dragIndex = -1;
      dragList = null;
      emit(false);
    } else if (placing && canPlace()) {
      const imgPt = eventToImage(event, true);
      if (imgPt) {
        snapshot();
        placePoint(imgPt);
        draw();
      }
      emit(false);
    }
    placing = false;
    activePointer = null;
    hideLoupe();
  }

  function onPointerLeave(event) {
    if (dragIndex >= 0 || placing) return;
    if (event.pointerType === "touch") return;
    hideLoupe();
  }

  function showLoupe(event, imgPt) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const size = 168;
    const zoom = 5;
    const px = Math.round(size * dpr);
    if (loupeCanvas.width !== px) {
      loupeCanvas.width = px;
      loupeCanvas.height = px;
    }
    const sw = px / zoom;
    loupeCtx.imageSmoothingEnabled = false;
    loupeCtx.fillStyle = "#1e1b17";
    loupeCtx.fillRect(0, 0, px, px);
    loupeCtx.drawImage(
      image.bitmap,
      imgPt.x - sw / 2,
      imgPt.y - sw / 2,
      sw,
      sw,
      0,
      0,
      px,
      px,
    );
    loupeCtx.strokeStyle = "rgba(20, 16, 12, 0.85)";
    loupeCtx.lineWidth = dpr;
    loupeCtx.beginPath();
    loupeCtx.moveTo(px / 2, 0);
    loupeCtx.lineTo(px / 2, px);
    loupeCtx.moveTo(0, px / 2);
    loupeCtx.lineTo(px, px / 2);
    loupeCtx.stroke();
    loupeCtx.strokeStyle = "rgba(255, 250, 244, 0.9)";
    loupeCtx.lineWidth = 1;
    const gap = 8 * dpr;
    loupeCtx.beginPath();
    loupeCtx.moveTo(px / 2, px / 2 - gap);
    loupeCtx.lineTo(px / 2, px / 2 + gap);
    loupeCtx.moveTo(px / 2 - gap, px / 2);
    loupeCtx.lineTo(px / 2 + gap, px / 2);
    loupeCtx.stroke();

    const margin = 16;
    const box = size;
    let left = event.clientX + 28;
    let top = event.clientY - box - 28;
    if (left + box > window.innerWidth - margin) left = event.clientX - box - 28;
    if (top < margin) top = event.clientY + 28;
    if (left < margin) left = margin;
    loupe.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
    loupe.hidden = false;
  }

  function hideLoupe() {
    loupe.hidden = true;
  }

  return {
    setImage,
    undo,
    reset,
    setRoomMode,
    skipFloor,
    skipSide,
    acceptSide,
    redraw: draw,
    hideLoupe,
  };
}
