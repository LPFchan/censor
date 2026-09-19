// PNG codec: thin wrapper over the vendored UPNG.js (public domain,
// see LICENSE.upng). Decode returns raw RGBA; encode takes raw RGBA.
// EXIF orientation is applied by the caller (decodeToRaster in jpeg.js
// exports nothing EXIF-aware; PNGs rarely carry orientation anyway, and
// the shared applyExif step in effects.js handles any format).

import pako from 'pako';
// png-upng.js is a vendored UMD script that reads pako from
// globalThis.__censorPako. ES module imports are hoisted but evaluated in
// order, so assigning the global here runs before png-upng.js's body.
globalThis.__censorPako = pako;
import UPNG from './png-upng.js';
import { Raster } from './resize.js';
import { CensorError } from './errors.js';

export function decodePng(bytes) {
  let img;
  try {
    img = UPNG.decode(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch (e) {
    throw new CensorError('could not decode image (supported: PNG, JPEG)');
  }
  // UPNG.toRGBA8 returns one ArrayBuffer per frame; single-frame PNGs are
  // the only sane input for a censor tool.
  const frames = UPNG.toRGBA8(img);
  // toRGBA8 already allocated a fresh RGBA buffer; wrap it, do not copy it.
  return new Raster(img.width, img.height, new Uint8ClampedArray(frames[0]));
}

export function encodePng(raster) {
  const { data } = raster;
  // UPNG reads the buffer without writing to it; hand it over as-is when the
  // view covers the whole buffer instead of copying 4 bytes per pixel.
  const whole = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength;
  const buf = UPNG.encode(
    [whole ? data.buffer : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)],
    raster.width,
    raster.height,
    0,
  );
  return new Uint8Array(buf);
}
