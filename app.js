/* censor — nondestructive blur & mosaic editor */

const MAX_TEX = 4096;

const state = {
  img: null,            // canvas, full res
  iw: 0, ih: 0,
  tool: 'rect',         // 'rect' | 'pen' | 'move'
  mode: 'mosaic',       // default effect for new objects
  intensity: 32,        // default intensity for new objects
  brush: 48,            // freehand brush radius, image px
  objects: [],          // {id, kind:'rect'|'stroke', effect, intensity, rect | points, radius}
  selected: null,
  view: { scale: 1, min: 1, max: 8, ox: 0, oy: 0 },
  dpr: Math.min(window.devicePixelRatio || 1, 2.5),
  space: false,
};

const $ = (id) => document.getElementById(id);
const stage = $('stage'), canvas = $('view'), ctx = canvas.getContext('2d');
const off = document.createElement('canvas'); // source, full res
const fx = document.createElement('canvas');   // scratch: object effect layer
const fxCtx = fx.getContext('2d');
const msc = document.createElement('canvas');  // scratch: mosaic grid (1 px per block)
const mscCtx = msc.getContext('2d');
const blr = document.createElement('canvas');  // scratch: filtered, downsampled blur
const blrCtx = blr.getContext('2d');

const uid = () => Math.random().toString(36).slice(2, 9);

/* ---------- image loading ---------- */

function setLoadStatus(message) {
  $('loadStatus').textContent = message;
}

async function loadImage(source) {
  try {
    const bmp = await createImageBitmap(source, { imageOrientation: 'from-image' });
    let w = bmp.width, h = bmp.height;
    const k = Math.min(1, MAX_TEX / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    off.width = w; off.height = h;
    off.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    state.img = off; state.iw = w; state.ih = h;
    state.objects = []; state.selected = null;
    document.body.classList.add('editing');
    fitView();
    resetHistory();
    requestRender();
    setLoadStatus('');
    return true;
  } catch (err) {
    setLoadStatus('Could not open that image.');
    return false;
  }
}

$('file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (file) await loadImage(file);
  e.target.value = '';
});

let fileDragDepth = 0;

function isImageFile(file) {
  return file.type.startsWith('image/') || /\.(avif|bmp|gif|heic|heif|jpe?g|png|webp)$/i.test(file.name);
}

function isFileDrag(e) {
  return [...(e.dataTransfer?.types || [])].includes('Files') ||
    [...(e.dataTransfer?.items || [])].some(item => item.kind === 'file');
}

function clearFileDrag() {
  fileDragDepth = 0;
  document.body.classList.remove('file-dragging');
}

window.addEventListener('dragenter', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  fileDragDepth++;
  document.body.classList.add('file-dragging');
});

window.addEventListener('dragover', (e) => {
  if (!isFileDrag(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  fileDragDepth = Math.max(0, fileDragDepth - 1);
  if (!fileDragDepth) clearFileDrag();
});

window.addEventListener('drop', async (e) => {
  clearFileDrag();
  e.preventDefault();
  const image = [...e.dataTransfer.files].find(isImageFile);
  if (!image) {
    if (state.img) alert('Drop an image file here.');
    else setLoadStatus('Drop an image file here.');
    return;
  }
  if (state.img && hasEditHistory() &&
      !confirm('Replace the current image? Your current edits and undo history will be lost.')) return;
  await loadImage(image);
});

window.addEventListener('dragend', clearFileDrag);

window.addEventListener('paste', async (e) => {
  if (document.body.classList.contains('editing')) return;
  const image = [...(e.clipboardData?.items || [])]
    .find(item => item.type.startsWith('image/'))
    ?.getAsFile();
  if (!image) {
    setLoadStatus('The clipboard does not contain an image.');
    return;
  }
  e.preventDefault();
  await loadImage(image);
});

$('clipboardOpen').addEventListener('click', async () => {
  if (!navigator.clipboard?.read) {
    setLoadStatus('Clipboard access is unavailable here. Try Cmd/Ctrl+V.');
    return;
  }
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find(candidate => candidate.startsWith('image/'));
      if (type) {
        await loadImage(await item.getType(type));
        return;
      }
    }
    setLoadStatus('The clipboard does not contain an image.');
  } catch (err) {
    setLoadStatus('Clipboard access was blocked. Try Cmd/Ctrl+V.');
  }
});

function fitView() {
  const r = stage.getBoundingClientRect();
  const s = Math.min(r.width / state.iw, r.height / state.ih) * 0.98;
  state.view.scale = s;
  state.view.min = s;
  state.view.ox = (r.width - state.iw * s) / 2;
  state.view.oy = (r.height - state.ih * s) / 2;
  sizeCanvas();
}

function sizeCanvas() {
  const r = stage.getBoundingClientRect();
  canvas.width = Math.round(r.width * state.dpr);
  canvas.height = Math.round(r.height * state.dpr);
  canvas.style.width = r.width + 'px';
  canvas.style.height = r.height + 'px';
}

window.addEventListener('resize', () => { if (state.img) { sizeCanvas(); requestRender(); } });

/* ---------- coordinates ---------- */

function toImage(p) {
  return { x: (p.x - state.view.ox) / state.view.scale, y: (p.y - state.view.oy) / state.view.scale };
}

/* ---------- effect rendering ---------- */

// Render one object's effect into the scratch canvas, then composite it
// onto c (full-res coordinate space) masked to the object's shape.
function drawEffect(c, obj) {
  if (fx.width !== state.iw || fx.height !== state.ih) {
    fx.width = state.iw; fx.height = state.ih;
  }
  fxCtx.setTransform(1, 0, 0, 1, 0, 0);
  fxCtx.filter = 'none';
  fxCtx.clearRect(0, 0, fx.width, fx.height);
  fxCtx.imageSmoothingEnabled = true;
  fxCtx.imageSmoothingQuality = 'high';

  if (obj.effect === 'blur') {
    // A real blur changes only the radius. Keeping the source and destination
    // at the same coordinates prevents the image from drifting as it changes.
    // Larger radii run on a smaller scratch image to keep slider updates fast.
    const scale = Math.min(8, Math.pow(2, Math.max(0, Math.ceil(Math.log2(obj.intensity / 4)))));
    const bw = Math.max(1, Math.ceil(state.iw / scale));
    const bh = Math.max(1, Math.ceil(state.ih / scale));
    msc.width = bw; msc.height = bh;
    mscCtx.imageSmoothingEnabled = true;
    mscCtx.imageSmoothingQuality = 'high';
    mscCtx.drawImage(state.img, 0, 0, state.iw, state.ih, 0, 0, bw, bh);
    blr.width = bw; blr.height = bh;
    blrCtx.filter = `blur(${obj.intensity / scale}px)`;
    blrCtx.drawImage(msc, 0, 0);
    blrCtx.filter = 'none';
    // Bilinear enlargement is already smooth and avoids an expensive second
    // high-quality resampling pass over the full-resolution image.
    fxCtx.imageSmoothingQuality = 'low';
    fxCtx.drawImage(blr, 0, 0, bw, bh, 0, 0, state.iw, state.ih);
  } else {
    // Strength is the side length of each square in source-image pixels.
    // The grid may extend past the right or bottom edge so its interior cells
    // never stretch to follow a non-square source image.
    const cell = Math.max(1, Math.round(obj.intensity));
    const nx = Math.max(1, Math.ceil(state.iw / cell));
    const ny = Math.max(1, Math.ceil(state.ih / cell));
    msc.width = nx; msc.height = ny;
    mscCtx.imageSmoothingEnabled = true;
    mscCtx.imageSmoothingQuality = 'high';
    mscCtx.drawImage(state.img, 0, 0, state.iw, state.ih, 0, 0, nx, ny);
    fxCtx.imageSmoothingEnabled = false;
    fxCtx.drawImage(msc, 0, 0, nx, ny, 0, 0, nx * cell, ny * cell);
  }

  // mask the layer to the object's shape
  fxCtx.globalCompositeOperation = 'destination-in';
  fxCtx.fillStyle = '#000';
  if (obj.kind === 'rect') {
    fxCtx.fillRect(obj.rect.x, obj.rect.y, obj.rect.w, obj.rect.h);
  } else {
    traceStroke(fxCtx, obj);
    fxCtx.fill();
  }
  fxCtx.globalCompositeOperation = 'source-over';

  c.drawImage(fx, 0, 0);
}

function strokeBounds(obj) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of obj.points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  const r = obj.radius;
  return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
}

function traceStroke(c, obj) {
  const r = obj.radius, pts = obj.points;
  c.beginPath();
  // union of discs at every point plus a blob per segment: the blob is the
  // convex hull of the two endpoint circles, so no penumbra gaps between them
  for (const p of pts) {
    c.moveTo(p.x + r, p.y);
    c.arc(p.x, p.y, r, 0, Math.PI * 2);
  }
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 0.01) continue;
    const ux = dx / len, uy = dy / len;      // along the segment
    const nx = -uy, ny = ux;                 // normal
    c.moveTo(a.x + nx * r, a.y + ny * r);
    c.lineTo(b.x + nx * r, b.y + ny * r);
    // bulged end around b: cubic arc past the tip so hull covers the circle
    const g = 0.5523 * r;
    c.bezierCurveTo(b.x + nx * r + ux * g, b.y + ny * r + uy * g,
                    b.x + ux * r + nx * g, b.y + uy * r + ny * g,
                    b.x + ux * r, b.y + uy * r);
    c.bezierCurveTo(b.x + ux * r - nx * g, b.y + uy * r - ny * g,
                    b.x - nx * r + ux * g, b.y - ny * r + uy * g,
                    b.x - nx * r, b.y - ny * r);
    c.lineTo(a.x - nx * r, a.y - ny * r);
    c.bezierCurveTo(a.x - nx * r - ux * g, a.y - ny * r - uy * g,
                    a.x - ux * r - nx * g, a.y - uy * r - ny * g,
                    a.x - ux * r, a.y - uy * r);
    c.bezierCurveTo(a.x - ux * r + nx * g, a.y - uy * r + ny * g,
                    a.x + nx * r - ux * g, a.y + ny * r - uy * g,
                    a.x + nx * r, a.y + ny * r);
    c.closePath();
  }
}

/* ---------- compositing ---------- */

let renderQueued = false;
function requestRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  if (!state.img) return;
  ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.translate(state.view.ox, state.view.oy);
  ctx.scale(state.view.scale, state.view.scale);
  ctx.drawImage(state.img, 0, 0);
  for (const obj of state.objects) drawEffect(ctx, obj);
  const sel = state.objects.find(o => o.id === state.selected);
  if (sel) drawSelection(ctx, sel);
}

function drawSelection(c, obj) {
  c.save();
  c.strokeStyle = '#0a84ff';
  c.lineWidth = 1.5 / state.view.scale;
  c.setLineDash([6 / state.view.scale, 4 / state.view.scale]);
  if (obj.kind === 'rect') {
    c.strokeRect(obj.rect.x, obj.rect.y, obj.rect.w, obj.rect.h);
    c.setLineDash([]);
    c.fillStyle = '#0a84ff';
    const hs = 7 / state.view.scale;
    for (const [hx, hy] of [
      [obj.rect.x, obj.rect.y], [obj.rect.x + obj.rect.w, obj.rect.y],
      [obj.rect.x, obj.rect.y + obj.rect.h], [obj.rect.x + obj.rect.w, obj.rect.y + obj.rect.h],
    ]) c.fillRect(hx - hs, hy - hs, hs * 2, hs * 2);
  } else {
    const b = strokeBounds(obj);
    c.strokeRect(b.x, b.y, b.w, b.h);
    c.setLineDash([]);
    const last = obj.points[obj.points.length - 1];
    c.beginPath();
    c.arc(last.x, last.y, obj.radius, 0, Math.PI * 2);
    c.globalAlpha = 0.5;
    c.stroke();
  }
  c.restore();
}

/* ---------- pointer interaction ---------- */

const pointers = new Map();
let gesture = null;
let history = [];
let historyIndex = -1;

function historySnapshot() {
  return JSON.stringify(state.objects);
}

function resetHistory() {
  history = [historySnapshot()];
  historyIndex = 0;
  syncHistoryUI();
}

function commitHistory() {
  const snapshot = historySnapshot();
  if (snapshot === history[historyIndex]) return;
  history = history.slice(0, historyIndex + 1);
  history.push(snapshot);
  historyIndex++;
  syncHistoryUI();
}

function restoreHistory(index) {
  if (index < 0 || index >= history.length) return;
  historyIndex = index;
  state.objects = JSON.parse(history[historyIndex]);
  selectObject(null);
  syncHistoryUI();
}

function hasEditHistory() {
  return history.some(snapshot => snapshot !== history[0]);
}

function syncHistoryUI() {
  $('btnUndo').disabled = historyIndex <= 0;
  $('btnRedo').disabled = historyIndex < 0 || historyIndex >= history.length - 1;
}

function eventPos(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', (e) => {
  if (!state.img) return;
  canvas.setPointerCapture(e.pointerId);
  const p = eventPos(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 2) {
    cancelDraw(); // abandon any one-finger draw first
    const [a, b] = [...pointers.values()];
    gesture = {
      type: 'pinch',
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale0: state.view.scale,
      ox0: state.view.ox, oy0: state.view.oy,
    };
    return;
  }

  const ip = toImage(p);
  const handle = hitResizeHandle(ip);
  if (handle) {
    const obj = state.objects.find(o => o.id === state.selected);
    gesture = { type: 'resize', id: obj.id, corner: handle, original: { ...obj.rect } };
    return;
  }

  if (state.tool === 'move' || state.space) {
    const hit = state.tool === 'move' && !state.space ? hitObject(ip) : null;
    if (hit) {
      selectObject(hit.id);
      gesture = { type: 'drag', id: hit.id, last: ip };
    } else {
      if (state.tool === 'move') selectObject(null);
      gesture = { type: 'pan', last: p };
    }
    return;
  }

  if (state.tool === 'rect') {
    gesture = { type: 'draw-rect', start: ip, cur: ip };
  } else {
    const obj = {
      id: uid(), kind: 'stroke', effect: state.mode, intensity: state.intensity,
      radius: state.brush, points: [ip],
    };
    state.objects.push(obj);
    selectObject(obj.id);
    gesture = { type: 'draw-stroke', id: obj.id };
    requestRender();
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const p = eventPos(e);
  pointers.set(e.pointerId, p);
  if (!gesture) return;

  if (gesture.type === 'pinch' && pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const s = clamp(gesture.scale0 * d / gesture.d0, state.view.min, state.view.max);
    const ix = (gesture.mid0.x - gesture.ox0) / gesture.scale0;
    const iy = (gesture.mid0.y - gesture.oy0) / gesture.scale0;
    state.view.scale = s;
    state.view.ox = mid.x - ix * s;
    state.view.oy = mid.y - iy * s;
    requestRender();
    return;
  }

  const ip = toImage(p);
  switch (gesture.type) {
    case 'pan':
      state.view.ox += p.x - gesture.last.x;
      state.view.oy += p.y - gesture.last.y;
      gesture.last = p;
      requestRender();
      break;
    case 'drag': {
      const obj = state.objects.find(o => o.id === gesture.id);
      if (!obj) break;
      moveObject(obj, ip.x - gesture.last.x, ip.y - gesture.last.y);
      gesture.last = ip;
      requestRender();
      break;
    }
    case 'resize': {
      const obj = state.objects.find(o => o.id === gesture.id);
      if (!obj) break;
      resizeRect(obj, gesture.original, gesture.corner, ip);
      requestRender();
      break;
    }
    case 'draw-rect':
      gesture.cur = ip;
      previewRect(gesture.start, gesture.cur);
      break;
    case 'draw-stroke': {
      const obj = state.objects.find(o => o.id === gesture.id);
      if (!obj) break;
      const last = obj.points[obj.points.length - 1];
      if (Math.hypot(ip.x - last.x, ip.y - last.y) > obj.radius * 0.25) {
        obj.points.push(ip);
        requestRender();
      }
      break;
    }
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  if (!gesture) return;
  if (gesture.type === 'pinch') {
    gesture = pointers.size === 1 ? { type: 'pan', last: [...pointers.values()][0] } : null;
    return;
  }
  if (gesture.type === 'draw-rect') {
    const r = normRect(gesture.start, gesture.cur);
    if (r.w > 4 && r.h > 4) {
      const obj = { id: uid(), kind: 'rect', effect: state.mode, intensity: state.intensity, rect: r };
      state.objects.push(obj);
      selectObject(obj.id);
      commitHistory();
      setTool('move');
    }
    render();
  } else if (gesture.type === 'draw-stroke') {
    commitHistory();
    setTool('move');
  } else if (gesture.type === 'drag' || gesture.type === 'resize') {
    commitHistory();
  }
  gesture = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);

function cancelDraw() {
  if (gesture && gesture.type === 'draw-stroke') {
    const obj = state.objects.find(o => o.id === gesture.id);
    if (obj && obj.points.length < 2) state.objects = state.objects.filter(o => o.id !== obj.id);
  }
  gesture = null;
  requestRender();
}

function normRect(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function previewRect(a, b) {
  render();
  const r = normRect(a, b);
  ctx.save();
  ctx.strokeStyle = '#0a84ff';
  ctx.lineWidth = 1.5 / state.view.scale;
  ctx.setLineDash([6 / state.view.scale, 4 / state.view.scale]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.globalAlpha = 0.15;
  ctx.fillStyle = '#0a84ff';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.restore();
}

function hitObject(ip) {
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const o = state.objects[i];
    if (o.kind === 'rect') {
      if (ip.x >= o.rect.x && ip.x <= o.rect.x + o.rect.w &&
          ip.y >= o.rect.y && ip.y <= o.rect.y + o.rect.h) return o;
    } else {
      for (let j = 0; j < o.points.length; j++) {
        if (distToSeg(ip, o.points[j], o.points[j + 1] || o.points[j]) <= o.radius) return o;
      }
    }
  }
  return null;
}

function hitResizeHandle(ip) {
  const obj = state.objects.find(o => o.id === state.selected);
  if (!obj || obj.kind !== 'rect') return null;
  const threshold = 18 / state.view.scale;
  const corners = {
    nw: [obj.rect.x, obj.rect.y],
    ne: [obj.rect.x + obj.rect.w, obj.rect.y],
    sw: [obj.rect.x, obj.rect.y + obj.rect.h],
    se: [obj.rect.x + obj.rect.w, obj.rect.y + obj.rect.h],
  };
  for (const [corner, [x, y]] of Object.entries(corners)) {
    if (Math.hypot(ip.x - x, ip.y - y) <= threshold) return corner;
  }
  return null;
}

function resizeRect(obj, original, corner, ip) {
  const minSize = 4;
  const left = original.x, top = original.y;
  const right = original.x + original.w, bottom = original.y + original.h;
  const x = clamp(ip.x, 0, state.iw);
  const y = clamp(ip.y, 0, state.ih);

  if (corner.includes('w')) {
    obj.rect.x = Math.min(x, right - minSize);
    obj.rect.w = right - obj.rect.x;
  } else {
    obj.rect.x = left;
    obj.rect.w = Math.max(minSize, x - left);
  }
  if (corner.includes('n')) {
    obj.rect.y = Math.min(y, bottom - minSize);
    obj.rect.h = bottom - obj.rect.y;
  } else {
    obj.rect.y = top;
    obj.rect.h = Math.max(minSize, y - top);
  }
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-6) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function moveObject(obj, dx, dy) {
  if (obj.kind === 'rect') {
    obj.rect.x = clamp(obj.rect.x + dx, 0, state.iw - obj.rect.w);
    obj.rect.y = clamp(obj.rect.y + dy, 0, state.ih - obj.rect.h);
  } else {
    const b = strokeBounds(obj);
    dx = clamp(dx, -b.x, state.iw - (b.x + b.w));
    dy = clamp(dy, -b.y, state.ih - (b.y + b.h));
    for (const p of obj.points) { p.x += dx; p.y += dy; }
  }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/* ---------- toolbar & selection ---------- */

function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll('#toolbar [data-tool]').forEach(b =>
    b.classList.toggle('on', b.dataset.tool === tool));
  $('brushRow').classList.toggle('show', tool === 'pen');
}

document.querySelectorAll('#toolbar [data-tool]').forEach(btn => {
  btn.addEventListener('click', () => setTool(btn.dataset.tool));
});

function selectObject(id) {
  state.selected = id;
  const obj = state.objects.find(o => o.id === id);
  $('selbar').classList.toggle('show', !!obj);
  $('newbar').classList.toggle('show', !obj);
  if (obj) syncSelUI(obj);
  requestRender();
}

function syncSelUI(obj) {
  document.querySelectorAll('#selbar [data-effect]').forEach(b =>
    b.classList.toggle('on', b.dataset.effect === obj.effect));
  const slider = $('selIntensity');
  slider.min = obj.effect === 'blur' ? 2 : 1;
  slider.max = obj.effect === 'blur' ? 80 : 64;
  slider.value = obj.intensity;
  $('selIntVal').textContent = obj.effect === 'blur' ? obj.intensity + 'px' : obj.intensity + ' × ' + obj.intensity + 'px';
}

document.querySelectorAll('#selbar [data-effect]').forEach(btn => {
  btn.addEventListener('click', () => {
    const obj = state.objects.find(o => o.id === state.selected);
    if (!obj || obj.effect === btn.dataset.effect) return;
    // carry perceived strength across modes
    obj.intensity = obj.effect === 'blur'
      ? clamp(Math.round(obj.intensity * 4), 1, 64)
      : clamp(Math.round(obj.intensity / 4), 2, 80);
    obj.effect = btn.dataset.effect;
    syncSelUI(obj);
    requestRender();
    commitHistory();
  });
});

$('selIntensity').addEventListener('input', () => {
  const obj = state.objects.find(o => o.id === state.selected);
  if (!obj) return;
  obj.intensity = +$('selIntensity').value;
  $('selIntVal').textContent = obj.effect === 'blur' ? obj.intensity + 'px' : obj.intensity + ' × ' + obj.intensity + 'px';
  requestRender();
});
$('selIntensity').addEventListener('change', commitHistory);

$('selDelete').addEventListener('click', () => {
  state.objects = state.objects.filter(o => o.id !== state.selected);
  selectObject(null);
  commitHistory();
});

$('selDone').addEventListener('click', () => selectObject(null));

/* ---------- new-object defaults ---------- */

document.querySelectorAll('#newbar [data-effect]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.effect;
    document.querySelectorAll('#newbar [data-effect]').forEach(b => b.classList.toggle('on', b === btn));
    state.intensity = state.mode === 'blur' ? 12 : 32;
    syncNewUI();
  });
});

$('newIntensity').addEventListener('input', () => {
  state.intensity = +$('newIntensity').value;
  syncNewUI();
});

function syncNewUI() {
  const slider = $('newIntensity');
  slider.min = state.mode === 'blur' ? 2 : 1;
  slider.max = state.mode === 'blur' ? 80 : 64;
  slider.value = state.intensity;
  $('newIntVal').textContent = state.mode === 'blur' ? state.intensity + 'px' : state.intensity + ' × ' + state.intensity + 'px';
}
syncNewUI();

$('brushSize').addEventListener('input', () => {
  state.brush = +$('brushSize').value;
  $('brushVal').textContent = state.brush + 'px';
});

$('btnFit').addEventListener('click', () => { fitView(); requestRender(); });
$('btnUndo').addEventListener('click', () => restoreHistory(historyIndex - 1));
$('btnRedo').addEventListener('click', () => restoreHistory(historyIndex + 1));

$('btnClear').addEventListener('click', () => {
  if (!state.objects.length) return;
  if (confirm('remove all ' + state.objects.length + ' censor object' + (state.objects.length > 1 ? 's' : '') + '?')) {
    state.objects = [];
    selectObject(null);
    commitHistory();
  }
});

$('btnNew').addEventListener('click', () => {
  if (hasEditHistory() && !confirm('Open a new image? Your current edits and undo history will be lost.')) return;
  document.body.classList.remove('editing');
  state.img = null; state.objects = []; state.selected = null;
  resetHistory();
});

/* ---------- export ---------- */

function renderOutputBlob() {
  const out = document.createElement('canvas');
  out.width = state.iw; out.height = state.ih;
  const c = out.getContext('2d');
  c.drawImage(state.img, 0, 0);
  for (const obj of state.objects) drawEffect(c, obj);
  return new Promise((resolve, reject) => {
    out.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not render image.')), 'image/png');
  });
}

$('btnCopy').addEventListener('click', async () => {
  if (!state.img) return;
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    alert('Copying images is not supported in this browser.');
    return;
  }
  try {
    // Give Safari the clipboard write during the click itself while the PNG
    // continues rendering through the promise.
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': renderOutputBlob() }),
    ]);
    const button = $('btnCopy');
    button.classList.add('copied');
    $('copyStatus').textContent = 'Output image copied to clipboard.';
    setTimeout(() => button.classList.remove('copied'), 1200);
  } catch (err) {
    alert('Could not copy the image. Check clipboard permission and try again.');
  }
});

$('btnSave').addEventListener('click', async () => {
  if (!state.img) return;
  try {
    const blob = await renderOutputBlob();
    const name = 'censored-' + Date.now() + '.png';
    const file = new File([blob], name, { type: 'image/png' });
    // on mobile, sharing drops the image straight into Photos/Files
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return; // user cancelled the sheet
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    alert('Could not save the image.');
  }
});

/* ---------- keyboard (desktop nicety) ---------- */

function adjustIntensity(delta) {
  const obj = state.objects.find(o => o.id === state.selected);
  if (obj) {
    const next = clamp(obj.intensity + delta, obj.effect === 'blur' ? 2 : 1, obj.effect === 'blur' ? 80 : 64);
    if (next === obj.intensity) return;
    obj.intensity = next;
    syncSelUI(obj);
    requestRender();
    commitHistory();
    return;
  }

  state.intensity = clamp(state.intensity + delta, state.mode === 'blur' ? 2 : 1, state.mode === 'blur' ? 80 : 64);
  syncNewUI();
}

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'z') {
    restoreHistory(historyIndex + (e.shiftKey ? 1 : -1));
    e.preventDefault();
    return;
  }
  if (mod && e.key.toLowerCase() === 'y') {
    restoreHistory(historyIndex + 1);
    e.preventDefault();
    return;
  }
  if (state.img && !mod && !e.altKey) {
    const tools = { m: 'rect', v: 'move', b: 'pen' };
    const tool = tools[e.key.toLowerCase()];
    if (tool) {
      setTool(tool);
      e.preventDefault();
      return;
    }
    if (e.key === '[' || e.key === ']') {
      adjustIntensity(e.key === '[' ? -1 : 1);
      e.preventDefault();
      return;
    }
  }
  if (e.key === ' ') { state.space = true; e.preventDefault(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    state.objects = state.objects.filter(o => o.id !== state.selected);
    selectObject(null);
    commitHistory();
  }
});
window.addEventListener('keyup', (e) => { if (e.key === ' ') state.space = false; });

canvas.addEventListener('wheel', (e) => {
  if (!state.img) return;
  e.preventDefault();
  const p = eventPos(e);
  const s = clamp(state.view.scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12), state.view.min, state.view.max);
  const ix = (p.x - state.view.ox) / state.view.scale;
  const iy = (p.y - state.view.oy) / state.view.scale;
  state.view.scale = s;
  state.view.ox = p.x - ix * s;
  state.view.oy = p.y - iy * s;
  requestRender();
}, { passive: false });

/* ---------- misc ---------- */

document.addEventListener('gesturestart', (e) => e.preventDefault());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

window.addEventListener('beforeunload', (e) => {
  if (!state.img || !hasEditHistory()) return;
  e.preventDefault();
  e.returnValue = '';
});

// kill double-tap-to-zoom on UI chrome (iOS ignores user-scalable=no):
// swallow the second tap of any rapid pair outside the canvas
let lastUiTap = 0;
document.addEventListener('touchend', (e) => {
  if (e.target.closest('#view')) { lastUiTap = 0; return; }
  const now = Date.now();
  if (now - lastUiTap < 350) e.preventDefault();
  lastUiTap = now;
}, { passive: false });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

resetHistory();
