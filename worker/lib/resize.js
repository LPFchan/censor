// Pixel-level primitives for the MCP worker port of the Pillow effects.
// Everything operates on flat Uint8ClampedArray RGBA buffers so peak memory
// is exactly the rasters we allocate — no canvas, no DOM, no implicit copies.

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
    for (let row = 0; row < h; row++) {
      const src = ((y0 + row) * this.width + x0) * 4;
      out.data.set(this.data.subarray(src, src + w * 4), row * w * 4);
    }
    return out;
  }
  paste(layer, dx, dy, mask) {
    const w = layer.width, h = layer.height;
    for (let row = 0; row < h; row++) {
      const oy = dy + row;
      if (oy < 0 || oy >= this.height) continue;
      for (let col = 0; col < w; col++) {
        const ox = dx + col;
        if (ox < 0 || ox >= this.width) continue;
        const m = mask ? mask[row * w + col] : 255;
        if (m === 0) continue;
        const si = (row * w + col) * 4;
        const di = (oy * this.width + ox) * 4;
        if (m === 255) {
          this.data[di] = layer.data[si];
          this.data[di + 1] = layer.data[si + 1];
          this.data[di + 2] = layer.data[si + 2];
          this.data[di + 3] = layer.data[si + 3];
        } else {
          const a = m / 255;
          this.data[di] = layer.data[si] * a + this.data[di] * (1 - a);
          this.data[di + 1] = layer.data[si + 1] * a + this.data[di + 1] * (1 - a);
          this.data[di + 2] = layer.data[si + 2] * a + this.data[di + 2] * (1 - a);
          this.data[di + 3] = layer.data[si + 3] * a + this.data[di + 3] * (1 - a);
        }
      }
    }
  }
}

function clampByte(v) {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Separable bilinear resize, matching Pillow's Resampling.BILINEAR. The
// bilinear kernel spans 1/scale source pixels per side; when that exceeds
// two pixels Pillow shrinks the support (so a 32x downscale averages the
// whole contributing cell rather than sampling four points of it).
export function resizeBilinear(src, dstW, dstH) {
  const tmp = new Raster(dstW, src.height);
  const xscale = src.width / dstW;
  const yscale = src.height / dstH;
  const xfilter = buildFilter(src.width, dstW, xscale);
  const yfilter = buildFilter(src.height, dstH, yscale);

  for (let y = 0; y < src.height; y++) {
    const rowBase = y * src.width * 4;
    const outBase = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      const f = xfilter[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < f.count; k++) {
        const si = rowBase + (f.first + k) * 4;
        const w = f.weights[k];
        r += src.data[si] * w;
        g += src.data[si + 1] * w;
        b += src.data[si + 2] * w;
        a += src.data[si + 3] * w;
      }
      const oi = outBase + x * 4;
      tmp.data[oi] = clampByte(r);
      tmp.data[oi + 1] = clampByte(g);
      tmp.data[oi + 2] = clampByte(b);
      tmp.data[oi + 3] = clampByte(a);
    }
  }

  const dst = new Raster(dstW, dstH);
  for (let y = 0; y < dstH; y++) {
    const f = yfilter[y];
    const outBase = y * dstW * 4;
    for (let x = 0; x < dstW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < f.count; k++) {
        const si = (f.first + k) * dstW * 4 + x * 4;
        const w = f.weights[k];
        r += tmp.data[si] * w;
        g += tmp.data[si + 1] * w;
        b += tmp.data[si + 2] * w;
        a += tmp.data[si + 3] * w;
      }
      const oi = outBase + x * 4;
      dst.data[oi] = clampByte(r);
      dst.data[oi + 1] = clampByte(g);
      dst.data[oi + 2] = clampByte(b);
      dst.data[oi + 3] = clampByte(a);
    }
  }
  return dst;
}

function buildFilter(srcLen, dstLen, scale) {
  // Triangle kernel with radius 1, support scaled up for downscales
  // (support = filterscale * radius, exactly Pillow's ImagingResample).
  const filterscale = Math.max(1, scale);
  const support = filterscale; // triangle radius 1 * filterscale
  const filters = [];
  for (let i = 0; i < dstLen; i++) {
    const center = (i + 0.5) * scale;
    const first = Math.max(0, Math.ceil(center - support));
    const last = Math.min(srcLen, Math.floor(center + support));
    const count = Math.max(1, last - first);
    const weights = new Float64Array(count);
    let sum = 0;
    for (let k = 0; k < count; k++) {
      const pos = first + k + 0.5;
      let w = 1 - Math.abs(pos - center) / filterscale;
      if (w < 0) w = 0;
      weights[k] = w;
      sum += w;
    }
    if (sum > 0) for (let k = 0; k < count; k++) weights[k] /= sum;
    filters.push({ first, count, weights });
  }
  return filters;
}

export function resizeNearest(src, dstW, dstH) {
  const dst = new Raster(dstW, dstH);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(src.height - 1, (y * src.height / dstH) | 0);
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(src.width - 1, (x * src.width / dstW) | 0);
      const si = (sy * src.width + sx) * 4;
      const di = (y * dstW + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return dst;
}

// Gaussian blur approximated with three successive box blurs (the standard
// IIR-free approximation; visually indistinguishable from a true Gaussian
// at the radii censor uses, 2..80 px). Runs separably, so cost is linear in
// radius rather than quadratic like a naive kernel.
export function gaussianBlur(src, radius) {
  const boxes = boxesForGauss(radius, 3);
  let current = src;
  for (let i = 0; i < boxes.length; i++) {
    const r = (boxes[i] - 1) / 2; // integer; n=3 keeps parity even/odd/even
    current = boxBlur(current, r);
  }
  return current;
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

function boxBlur(src, radius) {
  if (radius < 1) return src;
  const w = src.width, h = src.height;
  const tmp = new Raster(w, h);
  const dst = new Raster(w, h);
  const div = radius * 2 + 1;
  // horizontal pass with sliding window
  for (let y = 0; y < h; y++) {
    const rowBase = y * w * 4;
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = -radius; k <= radius; k++) {
      const x = Math.min(w - 1, Math.max(0, k));
      const si = rowBase + x * 4;
      r += src.data[si]; g += src.data[si + 1]; b += src.data[si + 2]; a += src.data[si + 3];
    }
    for (let x = 0; x < w; x++) {
      const oi = rowBase + x * 4;
      tmp.data[oi] = clampByte(r / div);
      tmp.data[oi + 1] = clampByte(g / div);
      tmp.data[oi + 2] = clampByte(b / div);
      tmp.data[oi + 3] = clampByte(a / div);
      const addX = Math.min(w - 1, x + radius + 1);
      const subX = Math.max(0, x - radius);
      const ai = rowBase + addX * 4, si = rowBase + subX * 4;
      r += src.data[ai] - src.data[si];
      g += src.data[ai + 1] - src.data[si + 1];
      b += src.data[ai + 2] - src.data[si + 2];
      a += src.data[ai + 3] - src.data[si + 3];
    }
  }
  // vertical pass
  for (let x = 0; x < w; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let k = -radius; k <= radius; k++) {
      const y = Math.min(h - 1, Math.max(0, k));
      const si = (y * w + x) * 4;
      r += tmp.data[si]; g += tmp.data[si + 1]; b += tmp.data[si + 2]; a += tmp.data[si + 3];
    }
    for (let y = 0; y < h; y++) {
      const oi = (y * w + x) * 4;
      dst.data[oi] = clampByte(r / div);
      dst.data[oi + 1] = clampByte(g / div);
      dst.data[oi + 2] = clampByte(b / div);
      dst.data[oi + 3] = clampByte(a / div);
      const addY = Math.min(h - 1, y + radius + 1);
      const subY = Math.max(0, y - radius);
      const ai = (addY * w + x) * 4, si = (subY * w + x) * 4;
      r += tmp.data[ai] - tmp.data[si];
      g += tmp.data[ai + 1] - tmp.data[si + 1];
      b += tmp.data[ai + 2] - tmp.data[si + 2];
      a += tmp.data[ai + 3] - tmp.data[si + 3];
    }
  }
  return dst;
}
