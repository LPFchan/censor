// Port of the original Pillow effects server to the Workers runtime.
// Same memory philosophy: no disk, images exist only as rasters for the
// duration of one call. Memory is the binding constraint (a Worker isolate
// has 128 MB, and the base64 body, the raster and both codecs' WASM heaps
// all share it), so the raster this module works on is capped at MAX_PIXELS:
// a larger JPEG is decoded straight to 1/2, 1/4 or 1/8 size by libjpeg's
// DCT scaling (the full raster never exists) and a larger PNG is refused
// from its header before any decode. Effects are applied in place; the only
// allocations are region-sized scratch layers.

import { Raster, resizeBilinear, resizeNearest, gaussianBlur } from './resize.js';
import { decodePng, encodePng } from './png.js';
import { decodeJpeg, encodeJpeg } from './jpeg.js';

// Largest raster this Worker will hold: 4 MP = 16 MB of RGBA. JPEGs above it
// are decoded downscaled; PNGs above it are rejected.
export const MAX_PIXELS = 4_000_000;
// Header-declared sanity cap on either side, before scaling is considered.
export const MAX_DIMENSION = 8192;
// Decoded image bytes. The base64 string, its bytes, and the codec's copy
// of them are all alive at once during decode.
export const MAX_IMAGE_BYTES = 10_000_000;
export const MAX_BASE64_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
export const MAX_REGION_COORD = 100_000;

export const BLUR_MIN = 2, BLUR_MAX = 80;
export const MOSAIC_MIN = 1, MOSAIC_MAX = 64;

import { CensorError } from './errors.js';
export { CensorError };

function parseDataUrl(data) {
  const comma = data.indexOf(',');
  const header = comma === -1 ? data : data.slice(0, comma);
  if (comma === -1 || !header.startsWith('data:') || !header.includes(';base64')) {
    throw new CensorError('malformed data URL: expected data:<mime>;base64,<payload>');
  }
  return data.slice(comma + 1);
}

// Uint8Array.fromBase64 decodes straight into bytes; the atob fallback
// holds an extra binary string the size of the image for the loop's duration.
export function b64ToBytes(b64) {
  try {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (e) {
    throw new CensorError('image data is not valid base64');
  }
}

function sniffFormat(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'JPEG';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return 'PNG';
  throw new CensorError('could not decode image (supported: PNG, JPEG)');
}

/** Base64 payload out of the tool arguments, with the size cap applied. */
export function imageBytes({ image_b64, image_url }) {
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
    throw new CensorError(`image is too large (${MAX_IMAGE_BYTES / 1_000_000} MB limit); re-encode it smaller first`);
  }
  const bytes = b64ToBytes(payload);
  return { bytes, format: sniffFormat(bytes) };
}

/**
 * Dimensions the caller sees (after EXIF rotation), read from the header
 * alone: get_image_info never decodes pixels.
 */
export function imageInfo(args) {
  const { bytes, format } = imageBytes(args);
  let { width, height } = headerDimensions(bytes, format);
  if (readExifOrientation(bytes) >= 5) [width, height] = [height, width];
  return { width, height, format };
}

/**
 * Smallest of 1, 2, 4, 8 that brings a width x height JPEG under
 * MAX_PIXELS when decoded at 1/n (libjpeg rounds each axis up).
 */
export function scaleDenomFor(width, height) {
  for (const d of [1, 2, 4, 8]) {
    if (Math.ceil(width / d) * Math.ceil(height / d) <= MAX_PIXELS) return d;
  }
  return 8;
}

/**
 * Decode to a raster of at most MAX_PIXELS. Returns the raster, the
 * container format, the source dimensions as the caller sees them, and the
 * scale denominator applied (1 = full size). Region coordinates stay in
 * source pixels; the caller divides them by `scale`.
 */
export async function decodeImage(args) {
  const { bytes, format } = imageBytes(args);
  // Reject from the header BEFORE paying for the decode, as the Pillow
  // server did: a kilobyte of PNG can declare a raster that would exhaust
  // the isolate's memory if decoded first and measured after.
  const header = headerDimensions(bytes, format);
  if (Math.max(header.width, header.height) > MAX_DIMENSION) {
    throw new CensorError(`image dimensions exceed ${MAX_DIMENSION}px`);
  }
  let scale = 1;
  let raster;
  if (format === 'JPEG') {
    scale = scaleDenomFor(header.width, header.height);
    raster = await decodeJpeg(bytes, scale);
  } else {
    if (header.width * header.height > MAX_PIXELS) {
      throw new CensorError(
        `PNG is ${header.width}x${header.height}, above the ${MAX_PIXELS / 1_000_000} megapixel limit. ` +
        'PNG is not downscaled here: downscale it first, or send it as JPEG (JPEGs above the limit are decoded downscaled).',
      );
    }
    raster = decodePng(bytes);
  }
  if (raster.width * raster.height > MAX_PIXELS) {
    // Header lied (or a codec quirk); never let an oversized raster proceed.
    throw new CensorError(`image exceeds ${MAX_PIXELS / 1_000_000} megapixels`);
  }
  // The libjpeg-turbo WASM decoder ignores EXIF orientation; normalize exactly
  // like Pillow's exif_transpose so region coordinates address the pixels
  // the caller sees.
  const orientation = format === 'JPEG' ? readExifOrientation(bytes) : 1;
  raster = applyExifOrientation(raster, orientation);
  const source = orientation >= 5
    ? { width: header.height, height: header.width }
    : { width: header.width, height: header.height };
  return { raster, format, source, scale };
}

/**
 * Width and height read from the container header without decoding pixels.
 * PNG: the IHDR chunk, always first. JPEG: the first SOFn marker. A file too
 * broken to carry either is reported as undecodable here rather than handed
 * to a codec.
 */
export function headerDimensions(bytes, format) {
  const undecodable = () => new CensorError('could not decode image (supported: PNG, JPEG)');
  const u16 = (p) => (bytes[p] << 8) | bytes[p + 1];
  const u32 = (p) => ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  if (format === 'PNG') {
    // signature (8) + length (4) + 'IHDR' (4) + width (4) + height (4)
    if (bytes.length < 24 || bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) {
      throw undecodable();
    }
    return { width: u32(16), height: u32(20) };
  }
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) throw undecodable();
    const marker = bytes[pos + 1];
    if (marker === 0xff) { pos++; continue; }            // fill byte
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) break;        // EOI / SOS: no SOF seen
    const len = u16(pos + 2);
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (pos + 9 > bytes.length) throw undecodable();
      return { width: u16(pos + 7), height: u16(pos + 5) };
    }
    pos += 2 + len;
  }
  throw undecodable();
}

export async function encodeImage(raster, format) {
  return format === 'JPEG' ? encodeJpeg(raster) : encodePng(raster);
}

// The libjpeg-turbo WASM decoder does not apply EXIF orientation; normalize the
// raster exactly like Pillow's exif_transpose so region coordinates
// address the pixels the caller sees.
const EXIF_ORIENT_TAG = 0x0112;

export function applyExifOrientation(raster, orientation) {
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

export function readExifOrientation(bytes) {
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

// Margin around a region so the layer's pixels inside the region come out
// exactly as they would from a whole-image pass. Mosaic: the bilinear
// downscale's triangle kernel reaches one cell past each cell, so cells that
// touch the region need one full neighbour cell on every side; two cells is
// that plus grid rounding. Blur: the three-box Gaussian's total support.
function padFor(effect, strength) {
  if (effect === 'mosaic') return 2 * Math.max(MOSAIC_MIN, Math.round(strength));
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

/** Applies the regions to `img` in place and returns it. */
export function censor(img, regions) {
  const out = img;
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
