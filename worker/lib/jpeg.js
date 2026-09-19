// JPEG codec: libjpeg-turbo 3.2.0 with hand-written WebAssembly SIMD128
// kernels, compiled from codec/{dec,enc,censor}.cpp (see codec/build.sh;
// license in LICENSE.libjpeg-turbo.md). The emscripten loaders fetch
// "jpeg_*.wasm" over HTTP by default, which cannot work inside a Worker — the
// module URL is virtual — so we inject the compiled module directly through
// instantiateWasm. The modules are instantiated once per isolate; their
// linear memory is reused across requests.

import decFactory from './jpeg_dec.js';
import encFactory from './jpeg_enc.js';
import censorFactory from './jpeg_censor.js';
import decWasm from './jpeg_dec.wasm';
import encWasm from './jpeg_enc.wasm';
import censorWasm from './jpeg_censor.wasm';
import { Raster } from './resize.js';
import { CensorError } from './errors.js';

function wasmModule(binary) {
  return {
    instantiateWasm(imports, receive) {
      WebAssembly.instantiate(binary, imports).then((instance) => receive(instance));
      return {};
    },
  };
}

let decModule;
async function decoder() {
  if (!decModule) decModule = decFactory(wasmModule(decWasm));
  return decModule;
}

let encModule;
async function encoder() {
  if (!encModule) encModule = encFactory(wasmModule(encWasm));
  return encModule;
}

let censorModule;
async function censorer() {
  if (!censorModule) censorModule = censorFactory(wasmModule(censorWasm));
  return censorModule;
}

/**
 * Decode at 1/scaleDenom size (1, 2, 4 or 8). libjpeg scales inside the
 * IDCT, so a baseline JPEG decodes in memory and time proportional to the
 * OUTPUT raster; the full-size raster never exists. The returned pixel
 * buffer is JS-owned (copied out of WASM memory by the binding).
 */
export async function decodeJpeg(bytes, scaleDenom = 1) {
  const mod = await decoder();
  let result;
  try {
    result = mod.decode(bytes, scaleDenom);
  } catch (e) {
    throw new CensorError('could not decode image (supported: PNG, JPEG)');
  }
  if (!result) throw new CensorError('could not decode image (supported: PNG, JPEG)');
  return new Raster(result.width, result.height, result.data);
}

// Quality 92 to match the Pillow server; baseline 4:2:0, no Huffman
// optimization (enc.cpp).
export const JPEG_QUALITY = 92;

export async function encodeJpeg(raster) {
  const mod = await encoder();
  const out = mod.encode(raster.data, raster.width, raster.height, JPEG_QUALITY);
  if (!out) throw new CensorError('could not encode image');
  return out;
}

/**
 * DCT-domain censor (codec/censor.cpp): re-encodes only the 8x8 blocks the
 * regions touch and transcodes the rest verbatim, so the output is at the
 * source resolution and pixels outside the regions are bit-exact.
 * `regions` is a flat Float64Array, 9 numbers each: x0, y0, x1, y1 (luma
 * pixels in the JPEG's stored orientation), shape (0 rect / 1 ellipse),
 * effect (0 mosaic / 1 blur), strength, and the mosaic grid anchor ax, ay.
 * `orientation` is the EXIF value to stamp on the output. Returns the JPEG
 * bytes plus per-stage millisecond timings (zero inside a Worker, where the
 * clock is frozen during a request).
 */
export async function censorJpeg(bytes, regions, orientation = 1) {
  const mod = await censorer();
  let result;
  try {
    result = mod.censor(bytes, regions, orientation);
  } catch (e) {
    throw new CensorError('could not decode image (supported: PNG, JPEG)');
  }
  if (result.error) {
    // libjpeg's own message for corrupt input is codec-speak; our two
    // deliberate refusals are already caller-readable.
    const ours = /arithmetic-coded|8-bit/.test(result.error);
    throw new CensorError(ours ? result.error : 'could not decode image (supported: PNG, JPEG)');
  }
  return result;
}
