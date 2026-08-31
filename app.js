/* censor — nondestructive blur & mosaic editor */

const MAX_TEX = 4096;

const state = {
  img: null,            // canvas, full res
  iw: 0, ih: 0,
  tool: 'rect',         // 'rect' | 'pen' | 'move'
  mode: 'mosaic',       // default effect for new objects
  intensity: 16,        // default intensity for new objects
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
let fxChain = null; // reused downsample buffers for compositing

const uid = () => Math.random().toString(36).slice(2, 9);

/* ---------- image loading ---------- */

$('file').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
    let w = bmp.width, h = bmp.height;
    const k = Math.min(1, MAX_TEX / Math.max(w, h));
    w = Math.round(w * k); h = Math.round(h * k);
    off.width = w; off.height = h;
    off.getContext('2d').drawImage(bmp, 0, 0, w, h);
    bmp.close();
    state.img = off; state.iw = w; state.ih = h;
    state.objects = []; state.selected = null;
    fxChain = null;
    document.body.classList.add('editing');
    fitView();
    setStatus(w + '\u00d7' + h);
    requestRender();
  } catch (err) {
    setStatus('could not open that image');
  }
  e.target.value = '';
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

/* ---------- effect rendering ----------
 * Downsample chain: each buffer is half the previous, always derived from
 * its parent so quality stays high. The 2x box filter centers each output
 * pixel at (2n+1) source px; offsets below are calibrated to that. */

function chain() {
  if (fxChain) return fxChain;
  fxChain = [state.img]; // step 0 = full res, step s = downsampled 2^s
  let src = state.img, w = state.iw, h = state.ih;
  for (let s = 1; s <= 3; s++) {
    const cw = Math.max(1, Math.ceil(w / 2)), ch = Math.max(1, Math.ceil(h / 2));
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, 0, 0, cw, ch);
    fxChain.push(c);
    src = c; w = cw; h = ch;
  }
  return fxChain;
}

// Smallest downsample step s in [0,3] that satisfies the intensity.
function pickStep(effect, intensity) {
  if (effect === 'blur') {
    const steps = Math.log2(intensity / 0.7);
    return Math.max(0, Math.min(3, Math.ceil(steps - 1e-9)));
  }
  const bs = state.iw / intensity; // block size in image px
  const steps = Math.log2(bs / 1.42);
  return Math.max(0, Math.min(3, Math.ceil(steps - 1e-9)));
}

function blurOffset(intensity, step) {
  const k = intensity / Math.pow(2, step);        // radius in downsampled px
  return ((k - 0.5) / 2) * Math.pow(2, step - 1); // back to full-res px
}

function blockSize(intensity, step) {
  const k = Math.pow(2, step);
  const raw = Math.max(1, Math.round(state.iw / (intensity * k)));
  const snapped = Math.max(1, Math.pow(2, Math.round(Math.log2(raw))));
  return snapped * k; // full-res px; snapped so buffer pixels never straddle blocks
}

// Render one object's effect into the scratch canvas, then composite it
// onto c (full-res coordinate space) masked to the object's shape.
function drawEffect(c, obj) {
  const ch = chain();
  const step = pickStep(obj.effect, obj.intensity);
  const buf = ch[step];

  if (fx.width !== state.iw || fx.height !== state.ih) {
    fx.width = state.iw; fx.height = state.ih;
  }
  fxCtx.setTransform(1, 0, 0, 1, 0, 0);
  fxCtx.clearRect(0, 0, fx.width, fx.height);
  fxCtx.imageSmoothingEnabled = true;
  fxCtx.imageSmoothingQuality = 'high';

  if (obj.effect === 'blur') {
    const o = blurOffset(obj.intensity, step);
    fxCtx.drawImage(buf, 0, 0, buf.width, buf.height, o, o, state.iw + 2 * o, state.ih + 2 * o);
  } else {
    // mosaic: shrink to one pixel per block, then upscale with smoothing off
    // so the blocks stay hard-edged. The grid is anchored to the image origin.
    const bs = blockSize(obj.intensity, step);
    const nx = Math.max(1, Math.ceil(state.iw / bs)), ny = Math.max(1, Math.ceil(state.ih / bs));
    msc.width = nx; msc.height = ny;
    mscCtx.imageSmoothingEnabled = true;
    mscCtx.imageSmoothingQuality = 'high';
    mscCtx.clearRect(0, 0, nx, ny);
    mscCtx.drawImage(buf, 0, 0, buf.width, buf.height, 0, 0, nx, ny);
    fxCtx.imageSmoothingEnabled = false;
    fxCtx.drawImage(msc, 0, 0, nx, ny, 0, 0, nx * bs, ny * bs);
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
    const [a, b] = [...pointers.values()];
    gesture = {
      type: 'pinch',
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      scale0: state.view.scale,
      ox0: state.view.ox, oy0: state.view.oy,
    };
    cancelDraw();
    return;
  }

  const ip = toImage(p);
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
    }
    render();
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

document.querySelectorAll('#toolbar [data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.tool = btn.dataset.tool;
    document.querySelectorAll('#toolbar [data-tool]').forEach(b => b.classList.toggle('on', b === btn));
    $('hint').textContent = {
      rect: 'drag to draw a censor box',
      pen: 'draw freely to censor',
      move: 'drag the image, or drag a censor to move it',
    }[state.tool];
    $('brushRow').classList.toggle('show', state.tool === 'pen');
  });
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
  slider.min = obj.effect === 'blur' ? 2 : 4;
  slider.max = obj.effect === 'blur' ? 80 : 64;
  slider.value = obj.intensity;
  $('selIntVal').textContent = obj.effect === 'blur' ? obj.intensity + 'px' : obj.intensity + ' blocks';
}

document.querySelectorAll('#selbar [data-effect]').forEach(btn => {
  btn.addEventListener('click', () => {
    const obj = state.objects.find(o => o.id === state.selected);
    if (!obj || obj.effect === btn.dataset.effect) return;
    // carry perceived strength across modes
    obj.intensity = obj.effect === 'blur'
      ? clamp(Math.round(state.iw / (obj.intensity * 1.2)), 4, 64)
      : clamp(Math.round(state.iw / (obj.intensity * 1.2)), 2, 80);
    obj.effect = btn.dataset.effect;
    syncSelUI(obj);
    requestRender();
  });
});

$('selIntensity').addEventListener('input', () => {
  const obj = state.objects.find(o => o.id === state.selected);
  if (!obj) return;
  obj.intensity = +$('selIntensity').value;
  $('selIntVal').textContent = obj.effect === 'blur' ? obj.intensity + 'px' : obj.intensity + ' blocks';
  requestRender();
});

$('selDelete').addEventListener('click', () => {
  state.objects = state.objects.filter(o => o.id !== state.selected);
  selectObject(null);
});

$('selDone').addEventListener('click', () => selectObject(null));

/* ---------- new-object defaults ---------- */

document.querySelectorAll('#newbar [data-effect]').forEach(btn => {
  btn.addEventListener('click', () => {
    state.mode = btn.dataset.effect;
    document.querySelectorAll('#newbar [data-effect]').forEach(b => b.classList.toggle('on', b === btn));
    state.intensity = state.mode === 'blur' ? 12 : 16;
    syncNewUI();
  });
});

$('newIntensity').addEventListener('input', () => {
  state.intensity = +$('newIntensity').value;
  syncNewUI();
});

function syncNewUI() {
  const slider = $('newIntensity');
  slider.min = state.mode === 'blur' ? 2 : 4;
  slider.max = state.mode === 'blur' ? 80 : 64;
  slider.value = state.intensity;
  $('newIntVal').textContent = state.mode === 'blur' ? state.intensity + 'px' : state.intensity + ' blocks';
}
syncNewUI();

$('brushSize').addEventListener('input', () => {
  state.brush = +$('brushSize').value;
  $('brushVal').textContent = state.brush + 'px';
});

$('btnFit').addEventListener('click', () => { fitView(); requestRender(); });

$('btnClear').addEventListener('click', () => {
  if (!state.objects.length) return;
  if (confirm('remove all ' + state.objects.length + ' censor object' + (state.objects.length > 1 ? 's' : '') + '?')) {
    state.objects = [];
    selectObject(null);
  }
});

$('btnNew').addEventListener('click', () => {
  document.body.classList.remove('editing');
  state.img = null; state.objects = []; state.selected = null; fxChain = null;
  setStatus('');
});

/* ---------- export ---------- */

$('btnSave').addEventListener('click', () => {
  if (!state.img) return;
  const out = document.createElement('canvas');
  out.width = state.iw; out.height = state.ih;
  const c = out.getContext('2d');
  c.drawImage(state.img, 0, 0);
  for (const obj of state.objects) drawEffect(c, obj);
  out.toBlob(async (blob) => {
    const name = 'censored-' + Date.now() + '.png';
    const file = new File([blob], name, { type: 'image/png' });
    // on mobile, sharing drops the image straight into Photos/Files
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        setStatus('saved');
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
    setStatus('saved');
  }, 'image/png');
});

/* ---------- keyboard (desktop nicety) ---------- */

window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { state.space = true; e.preventDefault(); }
  if ((e.key === 'Delete' || e.key === 'Backspace') && state.selected) {
    state.objects = state.objects.filter(o => o.id !== state.selected);
    selectObject(null);
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

function setStatus(t) { $('status').textContent = t; }

document.addEventListener('gesturestart', (e) => e.preventDefault());
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
