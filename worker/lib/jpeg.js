// JPEG codec: mozjpeg compiled to WASM from codec/{dec,enc}.cpp (see
// codec/build.sh; license in LICENSE.mozjpeg.md). The emscripten loaders
// fetch "mozjpeg_*.wasm" over HTTP by default, which cannot work inside a
// Worker — the module URL is virtual — so we inject the compiled module
// directly through instantiateWasm. The modules are instantiated once per
// isolate; their linear memory is reused across requests.

import mozDecFactory from './mozjpeg_dec.js';
import mozEncFactory from './mozjpeg_enc.js';
import decWasm from './mozjpeg_dec.wasm';
import encWasm from './mozjpeg_enc.wasm';
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
  if (!decModule) decModule = mozDecFactory(wasmModule(decWasm));
  return decModule;
}

let encModule;
async function encoder() {
  if (!encModule) encModule = mozEncFactory(wasmModule(encWasm));
  return encModule;
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

// Quality 92 to match the Pillow server; baseline 4:2:0, no trellis, no
// Huffman optimization (mozjpeg's JCP_FASTEST profile, set in enc.cpp).
export const JPEG_QUALITY = 92;

export async function encodeJpeg(raster) {
  const mod = await encoder();
  const out = mod.encode(raster.data, raster.width, raster.height, JPEG_QUALITY);
  if (!out) throw new CensorError('could not encode image');
  return out;
}
