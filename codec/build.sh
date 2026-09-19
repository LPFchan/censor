#!/bin/sh
# Rebuilds worker/lib/jpeg_{dec,enc}.{js,wasm} from dec.cpp and enc.cpp.
#
#   ./codec/build.sh            # on the host: needs docker, clones libjpeg-turbo
#
# Run without arguments on the host it fetches libjpeg-turbo 3.2.0 into
# codec/libjpeg-turbo (git-ignored), applies wasm-simd128.patch (the
# hand-written WebAssembly SIMD128 kernel set from
# github.com/jerbob92/libjpeg-turbo, branch wasm-simd128 at 696e2a1, five
# commits on top of the 3.2.0 tag; output is bit-identical to the scalar C
# paths), then re-enters itself inside the emscripten/emsdk image, where it
# builds libjpeg with WITH_WASM_SIMD=1 and links the two entry points against
# it. Measured under V8 (vitest workerd pool): decode 1.5x and encode 1.6-1.9x
# faster than the scalar build, same bytes out.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
LJT_TAG=3.2.0
EMSDK_IMAGE=emscripten/emsdk:latest

if ! command -v emcc >/dev/null 2>&1; then
  if [ ! -d "$HERE/libjpeg-turbo" ]; then
    git clone -q --depth 1 -b "$LJT_TAG" https://github.com/libjpeg-turbo/libjpeg-turbo.git "$HERE/libjpeg-turbo"
    git -C "$HERE/libjpeg-turbo" apply "$HERE/wasm-simd128.patch"
  fi
  exec docker run --rm -u "$(id -u):$(id -g)" -v "$HERE/..:/repo" "$EMSDK_IMAGE" sh /repo/codec/build.sh
fi

cd /repo/codec
if [ ! -f build/libjpeg.a ]; then
  emcmake cmake -S libjpeg-turbo -B build -DCMAKE_C_FLAGS="-msimd128" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWITH_WASM_SIMD=1 -DENABLE_SHARED=0 -DWITH_TURBOJPEG=0 -DPNG_SUPPORTED=0 \
    -DWITH_ARITH_ENC=0 -DWITH_ARITH_DEC=0
  cmake --build build --target jpeg-static -j4
fi
for name in dec enc; do
  em++ -O3 -msimd128 --bind "$name.cpp" build/libjpeg.a \
    -I libjpeg-turbo -I libjpeg-turbo/src -I build \
    -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=16MB \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME="jpeg_$name" \
    -s ENVIRONMENT=web -s FILESYSTEM=0 -s DYNAMIC_EXECUTION=0 \
    -s TEXTDECODER=2 -s ASSERTIONS=0 -s MALLOC=emmalloc \
    -o "../worker/lib/jpeg_$name.js"
done
ls -la ../worker/lib/jpeg_*
