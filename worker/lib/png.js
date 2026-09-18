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
  const raster = new Raster(img.width, img.height);
  raster.data.set(new Uint8ClampedArray(frames[0]));
  return raster;
}

export function encodePng(raster) {
  const buf = UPNG.encode(
    [raster.data.buffer.slice(raster.data.byteOffset, raster.data.byteOffset + raster.data.byteLength)],
    raster.width,
    raster.height,
    0,
  );
  return new Uint8Array(buf);
}
