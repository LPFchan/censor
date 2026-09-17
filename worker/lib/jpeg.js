// JPEG codec: mozjpeg compiled to WASM (from @jsquash/jpeg, Apache-2.0
// codec license in LICENSE.mozjpeg.md). The emscripten loaders fetch
// "mozjpeg_*.wasm" over HTTP by default, which cannot work inside a
// Worker — the module URL is virtual and module workers forbid sync XHR —
// so we inject the binary directly through instantiateWasm.

import mozDecFactory from './mozjpeg_dec.js';
import mozEncFactory from './mozjpeg_enc.js';
import decWasm from './mozjpeg_dec.wasm';
import encWasm from './mozjpeg_enc.wasm';
import { Raster } from './resize.js';

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
  if (!decModule) decModule = mozDecFactory(wasmModule(decWasm));
  return decModule;
}

let encModule;
async function encoder() {
  if (!encModule) encModule = mozEncFactory(wasmModule(encWasm));
  return encModule;
}

export async function decodeJpeg(bytes) {
  const mod = await decoder();
  let result;
  try {
    // Second arg: preserveOrientation. We handle EXIF ourselves in
    // effects.js, exactly like the Pillow server does with exif_transpose.
    result = mod.decode(bytes, false);
  } catch (e) {
    throw new Error('could not decode image (supported: PNG, JPEG)');
  }
  if (!result) throw new Error('could not decode image (supported: PNG, JPEG)');
  return new Raster(result.width, result.height, new Uint8ClampedArray(result.data));
}

// @jsquash/jpeg's defaults, with quality 92 to match the Pillow server.
const ENCODE_OPTIONS = {
  quality: 92,
  baseline: false,
  arithmetic: false,
  progressive: true,
  optimize_coding: true,
  smoothing: 0,
  color_space: 3, // YCbCr
  quant_table: 3,
  trellis_multipass: false,
  trellis_opt_zero: false,
  trellis_opt_table: false,
  trellis_loops: 1,
  auto_subsample: true,
  chroma_subsample: 2,
  separate_chroma_quality: false,
  chroma_quality: 92,
};

export async function encodeJpeg(raster) {
  const mod = await encoder();
  const view = mod.encode(raster.data, raster.width, raster.height, ENCODE_OPTIONS);
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}
