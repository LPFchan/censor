// Pixel-level primitives for the MCP worker port of the Pillow effects.
// Everything operates on flat Uint8ClampedArray RGBA buffers so peak memory
// is exactly the rasters we allocate — no canvas, no DOM, no implicit copies.
// Inner loops keep the buffers in locals and do no per-pixel calls or
// allocations; Uint8ClampedArray stores do the rounding and clamping.

export class Raster {
  constructor(width, height, data) {
    this.width = width;
    this.height = height;
    this.data = data || new Uint8ClampedArray(width * height * 4);
  }
  static from(img) {
    return new Raster(img.width, img.height, new Uint8ClampedArray(img.data));
  }
  crop(x0, y0, x1, y1) {
    const w = x1 - x0, h = y1 - y0;
    const out = new Raster(w, h);
    const src = this.data, dst = out.data, sw = this.width;
    for (let row = 0; row < h; row++) {
      const s = ((y0 + row) * sw + x0) * 4;
      dst.set(src.subarray(s, s + w * 4), row * w * 4);
    }
    return out;
  }
  paste(layer, dx, dy, mask) {
    const w = layer.width, h = layer.height;
    const dst = this.data, src = layer.data, dw = this.width, dh = this.height;
    for (let row = 0; row < h; row++) {
      const oy = dy + row;
      if (oy < 0 || oy >= dh) continue;
      for (let col = 0; col < w; col++) {
        const ox = dx + col;
        if (ox < 0 || ox >= dw) continue;
        const m = mask ? mask[row * w + col] : 255;
        if (m === 0) continue;
        const si = (row * w + col) * 4;
        const di = (oy * dw + ox) * 4;
        if (m === 255) {
          dst[di] = src[si];
          dst[di + 1] = src[si + 1];
          dst[di + 2] = src[si + 2];
          dst[di + 3] = src[si + 3];
        } else {
          const a = m / 255, b = 1 - a;
          dst[di] = src[si] * a + dst[di] * b;
          dst[di + 1] = src[si + 1] * a + dst[di + 1] * b;
          dst[di + 2] = src[si + 2] * a + dst[di + 2] * b;
          dst[di + 3] = src[si + 3] * a + dst[di + 3] * b;
        }
      }
    }
  }
}

// Separable bilinear resize, matching Pillow's Resampling.BILINEAR. The
// bilinear kernel spans 1/scale source pixels per side; when that exceeds
// two pixels Pillow shrinks the support (so a 32x downscale averages the
// whole contributing cell rather than sampling four points of it).
export function resizeBilinear(src, dstW, dstH) {
  const sw = src.width, sh = src.height;
  const tmp = new Uint8ClampedArray(dstW * sh * 4);
  const xf = buildFilter(sw, dstW, sw / dstW);
  const yf = buildFilter(sh, dstH, sh / dstH);
  const sd = src.data;

  for (let y = 0; y < sh; y++) {
    const rowBase = y * sw * 4;
    const outBase = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const first = xf.first[x], count = xf.count[x], wBase = x * xf.stride;
      let r = 0, g = 0, b = 0, a = 0;
      let si = rowBase + first * 4;
      for (let k = 0; k < count; k++, si += 4) {
        const w = xf.weights[wBase + k];
        r += sd[si] * w;
        g += sd[si + 1] * w;
        b += sd[si + 2] * w;
        a += sd[si + 3] * w;
      }
      const oi = outBase + x * 4;
      tmp[oi] = r; tmp[oi + 1] = g; tmp[oi + 2] = b; tmp[oi + 3] = a;
    }
  }

  const dst = new Raster(dstW, dstH);
  const dd = dst.data;
  const rowStride = dstW * 4;
  for (let y = 0; y < dstH; y++) {
    const first = yf.first[y], count = yf.count[y], wBase = y * yf.stride;
    const outBase = y * rowStride;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      let si = first * rowStride + x * 4;
      for (let k = 0; k < count; k++, si += rowStride) {
        const w = yf.weights[wBase + k];
        r += tmp[si] * w;
        g += tmp[si + 1] * w;
        b += tmp[si + 2] * w;
        a += tmp[si + 3] * w;
      }
      const oi = outBase + x * 4;
      dd[oi] = r; dd[oi + 1] = g; dd[oi + 2] = b; dd[oi + 3] = a;
    }
  }
  return dst;
}

// Triangle kernel with radius 1, support scaled up for downscales
// (support = filterscale * radius, exactly Pillow's ImagingResample).
// Flat typed arrays: first/count per output index, weights in rows of
// `stride`.
function buildFilter(srcLen, dstLen, scale) {
  const filterscale = Math.max(1, scale);
  const support = filterscale;
  const stride = Math.ceil(support * 2) + 2;
  const first = new Int32Array(dstLen);
  const count = new Int32Array(dstLen);
  const weights = new Float32Array(dstLen * stride);
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * scale;
    const f = Math.max(0, Math.ceil(center - support));
    const last = Math.min(srcLen, Math.floor(center + support));
    const n = Math.max(1, last - f);
    let sum = 0;
    for (let k = 0; k < n; k++) {
      let w = 1 - Math.abs(f + k + 0.5 - center) / filterscale;
      if (w < 0) w = 0;
      weights[i * stride + k] = w;
      sum += w;
    }
    if (sum > 0) for (let k = 0; k < n; k++) weights[i * stride + k] /= sum;
    first[i] = f;
    count[i] = n;
  }
  return { first, count, weights, stride };
}

export function resizeNearest(src, dstW, dstH) {
  const dst = new Raster(dstW, dstH);
  const sw = src.width, sh = src.height;
  // Whole-pixel copies through 32-bit views: one store per pixel.
  const s32 = new Uint32Array(src.data.buffer, src.data.byteOffset, sw * sh);
  const d32 = new Uint32Array(dst.data.buffer, 0, dstW * dstH);
  const xmap = new Int32Array(dstW);
  for (let x = 0; x < dstW; x++) xmap[x] = Math.min(sw - 1, (x * sw / dstW) | 0);
  for (let y = 0; y < dstH; y++) {
    const srow = Math.min(sh - 1, (y * sh / dstH) | 0) * sw;
    const drow = y * dstW;
    for (let x = 0; x < dstW; x++) d32[drow + x] = s32[srow + xmap[x]];
  }
  return dst;
}

// Gaussian blur approximated with three successive box blurs (the standard
// IIR-free approximation; visually indistinguishable from a true Gaussian
// at the radii censor uses, 2..80 px). Runs separably, so cost is linear in
// radius rather than quadratic like a naive kernel. Two scratch buffers are
// reused across the passes.
export function gaussianBlur(src, radius) {
  const boxes = boxesForGauss(radius, 3);
  const w = src.width, h = src.height;
  const n = w * h * 4;
  const tmp = new Uint8ClampedArray(n);
  const bufs = [new Uint8ClampedArray(n), new Uint8ClampedArray(n)];
  let current = src.data;
  let pass = 0;
  for (let i = 0; i < boxes.length; i++) {
    const r = (boxes[i] - 1) / 2; // integer; n=3 keeps parity even/odd/even
    if (r < 1) continue;
    const dst = bufs[pass++ % 2];
    boxBlur(current, dst, tmp, w, h, r);
    current = dst;
  }
  return current === src.data ? src : new Raster(w, h, current);
}

function boxesForGauss(sigma, n) {
  const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  const sizes = [];
  for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu);
  return sizes;
}

// One box pass: horizontal src -> tmp, vertical tmp -> dst. Sliding-window
// sums; edge pixels are clamped (replicated), as before.
function boxBlur(src, dst, tmp, w, h, radius) {
  const inv = 1 / (radius * 2 + 1);
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 4;
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = k < 0 ? 0 : k > w - 1 ? w - 1 : k;
      const si = rowBase + x * 4;
      r += src[si]; g += src[si + 1]; b += src[si + 2]; a += src[si + 3];
    }
    for (let x = 0; x < w; x++) {
      const oi = rowBase + x * 4;
      tmp[oi] = r * inv; tmp[oi + 1] = g * inv; tmp[oi + 2] = b * inv; tmp[oi + 3] = a * inv;
      const addX = x + radius + 1 > w - 1 ? w - 1 : x + radius + 1;
      const subX = x - radius < 0 ? 0 : x - radius;
      const ai = rowBase + addX * 4, si = rowBase + subX * 4;
      r += src[ai] - src[si];
      g += src[ai + 1] - src[si + 1];
      b += src[ai + 2] - src[si + 2];
      a += src[ai + 3] - src[si + 3];
    }
  }
  const stride = w * 4;
  for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    const col = x * 4;
    for (let k = -radius; k <= radius; k++) {
      const y = k < 0 ? 0 : k > h - 1 ? h - 1 : k;
      const si = y * stride + col;
      r += tmp[si]; g += tmp[si + 1]; b += tmp[si + 2]; a += tmp[si + 3];
    }
    for (let y = 0; y < h; y++) {
      const oi = y * stride + col;
      dst[oi] = r * inv; dst[oi + 1] = g * inv; dst[oi + 2] = b * inv; dst[oi + 3] = a * inv;
      const addY = y + radius + 1 > h - 1 ? h - 1 : y + radius + 1;
      const subY = y - radius < 0 ? 0 : y - radius;
      const ai = addY * stride + col, si = subY * stride + col;
      r += tmp[ai] - tmp[si];
      g += tmp[ai + 1] - tmp[si + 1];
      b += tmp[ai + 2] - tmp[si + 2];
      a += tmp[ai + 3] - tmp[si + 3];
    }
  }
}
