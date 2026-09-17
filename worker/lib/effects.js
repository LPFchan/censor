// Port of the original Pillow effects server to the Workers runtime.
// Same memory philosophy: no disk, images exist only as rasters for the
// duration of one call. The one deliberate simplification versus the
// Pillow server: region processing is not chunked into 64-row bands,
// because a Worker's 128 MB is per-request (no concurrency to budget
// against) and a 12 MP raster plus a same-size layer is ~96 MB worst
// case. Chunks and full layers produce identical pixels, so this changes
// nothing a caller can observe.

import { Raster, resizeBilinear, resizeNearest, gaussianBlur } from './resize.js';
import { decodePng, encodePng } from './png.js';
import { decodeJpeg, encodeJpeg } from './jpeg.js';

export const MAX_DIMENSION = 8192;
export const MAX_PIXELS = 12_000_000;
export const MAX_BASE64_CHARS = 40_000_000; // ~30 MB decoded
export const MAX_REGION_COORD = 100_000;

export const BLUR_MIN = 2, BLUR_MAX = 80;
export const MOSAIC_MIN = 1, MOSAIC_MAX = 64;

export class CensorError extends Error {}

function parseDataUrl(data) {
  const comma = data.indexOf(',');
  const header = comma === -1 ? data : data.slice(0, comma);
  if (comma === -1 || !header.startsWith('data:') || !header.includes(';base64')) {
    throw new CensorError('malformed data URL: expected data:<mime>;base64,<payload>');
  }
  return data.slice(comma + 1);
}

function b64ToBytes(b64) {
  let bin;
  try {
    bin = atob(b64);
  } catch (e) {
    throw new CensorError('image data is not valid base64');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sniffFormat(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'JPEG';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'PNG';
  throw new CensorError('could not decode image (supported: PNG, JPEG)');
}

export async function decodeImage({ image_b64, image_url }) {
  let payload;
  if (image_url) {
    if (image_b64) throw new CensorError('pass either image_b64 or image_url, not both');
    payload = parseDataUrl(String(image_url).trim());
  } else if (image_b64) {
    payload = String(image_b64).trim();
  } else {
    throw new CensorError('pass one of image_b64 or image_url');
  }
  if (payload.length > MAX_BASE64_CHARS) {
    throw new CensorError('image is too large (30 MB decoded limit)');
  }
  const bytes = b64ToBytes(payload);
  const format = sniffFormat(bytes);
  let raster = format === 'JPEG' ? await decodeJpeg(bytes) : decodePng(bytes);
  if (Math.max(raster.width, raster.height) > MAX_DIMENSION) {
    throw new CensorError(`image dimensions exceed ${MAX_DIMENSION}px`);
  }
  if (raster.width * raster.height > MAX_PIXELS) {
    throw new CensorError(`image exceeds ${MAX_PIXELS / 1_000_000} megapixels`);
  }
  // The mozjpeg WASM decoder ignores EXIF orientation; normalize exactly
  // like Pillow's exif_transpose so region coordinates address the pixels
  // the caller sees.
  raster = applyExifOrientation(raster, bytes);
  return { raster, format };
}

export async function encodeImage(raster, format) {
  return format === 'JPEG' ? encodeJpeg(raster) : encodePng(raster);
}

// The mozjpeg WASM decoder does not apply EXIF orientation; normalize the
// raster exactly like Pillow's exif_transpose so region coordinates
// address the pixels the caller sees.
const EXIF_ORIENT_TAG = 0x0112;

export function applyExifOrientation(raster, bytes) {
  let orientation = 1;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    orientation = readExifOrientation(bytes);
  }
  if (!orientation || orientation === 1) return raster;
  const { width: w, height: h } = raster;
  const swapped = orientation >= 5; // 5-8 transpose width/height
  const out = new Raster(swapped ? h : w, swapped ? w : h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx, ny;
      switch (orientation) {
        case 2: nx = w - 1 - x; ny = y; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: nx = x; ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        case 8: nx = y; ny = w - 1 - x; break;
        default: nx = x; ny = y;
      }
      const si = (y * w + x) * 4;
      const di = (ny * out.width + nx) * 4;
      out.data[di] = raster.data[si];
      out.data[di + 1] = raster.data[si + 1];
      out.data[di + 2] = raster.data[si + 2];
      out.data[di + 3] = raster.data[si + 3];
    }
  }
  return out;
}

function readExifOrientation(bytes) {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let pos = 2;
    while (pos + 4 <= bytes.length) {
      if (bytes[pos] !== 0xff) return 1;
      const marker = bytes[pos + 1];
      const len = (bytes[pos + 2] << 8) | bytes[pos + 3];
      if (marker === 0xe1 && bytes[pos + 4] === 0x45 && bytes[pos + 5] === 0x78) { // 'Ex'
        return parseTiffOrientation(bytes, pos + 10, len - 8);
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        pos += 2;
      } else {
        pos += 2 + len;
      }
    }
  } catch (e) { /* malformed EXIF means no rotation */ }
  return 1;
}

function parseTiffOrientation(bytes, start, len) {
  if (start + 8 > bytes.length) return 1;
  const le = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const be = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
  if (!le && !be) return 1;
  const u16 = (p) => le ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1];
  const u32 = (p) => le
    ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0
    : ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  if (u16(start + 2) !== 42) return 1;
  const ifd = start + u32(start + 4);
  if (ifd + 2 > bytes.length) return 1;
  const count = u16(ifd);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > bytes.length) return 1;
    if (u16(entry) === EXIF_ORIENT_TAG) {
      const v = u16(entry + 8);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

function padFor(effect, strength) {
  if (effect === 'mosaic') return 5 * Math.max(MOSAIC_MIN, Math.round(strength)) + 16;
  return 4 * strength + 16;
}

function blurLayer(img, intensity, gx = 0, gy = 0) {
  // Same structure as the Pillow port: large radii blur a downscaled
  // scratch and stretch it back, anchored to the image-origin grid so
  // samples never shift with crop position.
  const scale = intensity > 4
    ? Math.min(8, 2 ** Math.max(0, Math.ceil(Math.log2(intensity / 4))))
    : 1;
  if (scale > 1) {
    const ax0 = Math.floor(gx / scale) * scale;
    const ay0 = Math.floor(gy / scale) * scale;
    const nx = Math.max(1, Math.ceil((gx - ax0 + img.width) / scale));
    const ny = Math.max(1, Math.ceil((gy - ay0 + img.height) / scale));
    const small = resizeBilinear(img, nx, ny);
    const blurred = gaussianBlur(small, intensity / scale);
    const big = resizeBilinear(blurred, nx * scale, ny * scale);
    const ox = gx - ax0, oy = gy - ay0;
    return big.crop(ox, oy, ox + img.width, oy + img.height);
  }
  return gaussianBlur(img, intensity);
}

function mosaicLayer(img, intensity, gx, gy, anchorX = 0, anchorY = 0) {
  const cell = Math.max(MOSAIC_MIN, Math.round(intensity));
  const ax0 = anchorX + Math.floor((gx - anchorX) / cell) * cell;
  const ay0 = anchorY + Math.floor((gy - anchorY) / cell) * cell;
  const oxRel = gx - ax0, oyRel = gy - ay0;
  const nx = Math.max(1, Math.ceil((oxRel + img.width) / cell));
  const ny = Math.max(1, Math.ceil((oyRel + img.height) / cell));
  const small = resizeBilinear(img, nx, ny);
  const grid = resizeNearest(small, nx * cell, ny * cell);
  return grid.crop(oxRel, oyRel, oxRel + img.width, oyRel + img.height);
}

function ellipseMask(w, h, x, y, ew, eh) {
  // Pillow's ImageDraw.ellipse approximates the curve with polygonal
  // chords; an analytic signed-distance mask matches it within the edge
  // antialiasing and is cheaper in a single pass.
  const mask = new Uint8Array(w * h);
  const cx = x + ew / 2, cy = y + eh / 2;
  const rx = ew / 2, ry = eh / 2;
  if (rx <= 0 || ry <= 0) return mask;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const dx = (px + 0.5 - cx) / rx;
      const dy = (py + 0.5 - cy) / ry;
      const d = dx * dx + dy * dy;
      if (d <= 1) {
        // soft edge over ~1px for parity with Pillow's rasterized outline
        const edge = (Math.sqrt(d) - 1) * Math.min(rx, ry);
        mask[py * w + px] = edge < -0.75 ? 255 : Math.round(255 * Math.max(0, Math.min(1, 0.25 - edge)));
      }
    }
  }
  return mask;
}

function rectMask(w, h, x0, y0, x1, y1) {
  const mask = new Uint8Array(w * h);
  for (let y = y0; y <= y1; y++) {
    if (y < 0 || y >= h) continue;
    for (let x = x0; x <= x1; x++) {
      if (x >= 0 && x < w) mask[y * w + x] = 255;
    }
  }
  return mask;
}

function normalizeRegions(img, regions) {
  if (!Array.isArray(regions) || regions.length === 0) {
    throw new CensorError('regions must contain at least one region');
  }
  if (regions.length > 64) throw new CensorError('too many regions (max 64 per call)');
  return regions.map((r, i) => {
    const x = Number(r?.x), y = Number(r?.y), w = Number(r?.w), h = Number(r?.h);
    if ([x, y, w, h].some((v) => Number.isNaN(v))) {
      throw new CensorError(`region ${i}: x, y, w, h must be numbers`);
    }
    if (w <= 0 || h <= 0) throw new CensorError(`region ${i}: w and h must be positive`);
    if (![x, y, w, h].every(Number.isFinite)) {
      throw new CensorError(`region ${i}: x, y, w, h must be finite`);
    }
    if (Math.max(Math.abs(x), Math.abs(y), w, h) > MAX_REGION_COORD) {
      throw new CensorError(`region ${i}: coordinates must be within +/-${MAX_REGION_COORD}`);
    }
    if (x + w <= 0 || y + h <= 0 || x >= img.width || y >= img.height) {
      throw new CensorError(`region ${i}: lies outside the ${img.width}x${img.height} image`);
    }
    const shape = r.shape ?? 'rect';
    if (shape !== 'rect' && shape !== 'ellipse') {
      throw new CensorError(`region ${i}: shape must be 'rect' or 'ellipse'`);
    }
    const effect = r.effect ?? 'mosaic';
    if (effect !== 'mosaic' && effect !== 'blur') {
      throw new CensorError(`region ${i}: effect must be 'mosaic' or 'blur'`);
    }
    let strength = r.strength;
    if (strength === undefined || strength === null) strength = effect === 'mosaic' ? 32 : 12;
    strength = Math.trunc(Number(strength));
    const [lo, hi] = effect === 'mosaic' ? [MOSAIC_MIN, MOSAIC_MAX] : [BLUR_MIN, BLUR_MAX];
    if (!(strength >= lo && strength <= hi)) {
      throw new CensorError(`region ${i}: ${effect} strength must be ${lo}..${hi}`);
    }
    return { box: [x, y, x + w, y + h], shape, effect, strength };
  });
}

export function censor(img, regions) {
  const out = new Raster(img.width, img.height, new Uint8ClampedArray(img.data));
  for (const r of normalizeRegions(img, regions)) {
    const [x0, y0, x1, y1] = r.box;
    const pad = padFor(r.effect, r.strength);
    if (r.effect === 'mosaic') {
      const cell = Math.max(MOSAIC_MIN, Math.round(r.strength));
      const useRegionAnchor = r.shape === 'ellipse' || x0 < 0 || y0 < 0;
      const anchorX = useRegionAnchor ? Math.floor(x0) : 0;
      const anchorY = useRegionAnchor ? Math.floor(y0) : 0;
      const candX = Math.max(0, Math.floor(x0) - pad);
      const candY = Math.max(0, Math.floor(y0) - pad);
      var gx0 = Math.max(0, anchorX + Math.floor((candX - anchorX) / cell) * cell);
      var gy0 = Math.max(0, anchorY + Math.floor((candY - anchorY) / cell) * cell);
      const endX = Math.min(img.width, Math.ceil(x1) + pad);
      const endY = Math.min(img.height, Math.ceil(y1) + pad);
      var gx1 = Math.min(img.width, anchorX + Math.ceil((endX - anchorX) / cell) * cell);
      var gy1 = Math.min(img.height, anchorY + Math.ceil((endY - anchorY) / cell) * cell);
    } else {
      var gx0 = Math.max(0, Math.floor(x0) - pad);
      var gy0 = Math.max(0, Math.floor(y0) - pad);
      var gx1 = Math.min(img.width, Math.ceil(x1) + pad);
      var gy1 = Math.min(img.height, Math.ceil(y1) + pad);
    }
    if (gx1 <= gx0 || gy1 <= gy0) continue;
    const crop = out.crop(gx0, gy0, gx1, gy1);
    const layer = r.effect === 'blur'
      ? blurLayer(crop, r.strength, gx0, gy0)
      : mosaicLayer(crop, r.strength, gx0, gy0,
          r.shape === 'ellipse' || x0 < 0 || y0 < 0 ? Math.floor(x0) : 0,
          r.shape === 'ellipse' || x0 < 0 || y0 < 0 ? Math.floor(y0) : 0);
    const px0 = Math.floor(x0), py0 = Math.floor(y0);
    const px1 = Math.ceil(x1), py1 = Math.ceil(y1);
    if (px1 <= px0 || py1 <= py0) continue;
    const mx0 = px0 - gx0, my0 = py0 - gy0;
    const mx1 = px1 - gx0 - 1, my1 = py1 - gy0 - 1;
    let mask;
    if (r.shape === 'ellipse') {
      mask = ellipseMask(crop.width, crop.height, x0 - gx0, y0 - gy0, x1 - x0, y1 - y0);
      const clip = rectMask(crop.width, crop.height, mx0, my0, mx1, my1);
      for (let i = 0; i < mask.length; i++) if (!clip[i]) mask[i] = 0;
    } else {
      mask = rectMask(crop.width, crop.height, mx0, my0, mx1, my1);
    }
    out.paste(layer, gx0, gy0, mask);
  }
  return out;
}
