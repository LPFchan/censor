#!/bin/sh
# Rebuilds worker/lib/mozjpeg_{dec,enc}.{js,wasm} from dec.cpp and enc.cpp.
#
#   ./codec/build.sh            # on the host: needs docker, clones mozjpeg
#
# Run without arguments on the host it fetches mozjpeg v4.1.5 into
# codec/mozjpeg (git-ignored), then re-enters itself inside the
# emscripten/emsdk image, where it builds libjpeg (scalar C, wasm SIMD via
# autovectorization only) and links the two entry points against it.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
MOZJPEG_TAG=v4.1.5
EMSDK_IMAGE=emscripten/emsdk:latest

if ! command -v emcc >/dev/null 2>&1; then
  [ -d "$HERE/mozjpeg" ] || git clone -q --depth 1 -b "$MOZJPEG_TAG" https://github.com/mozilla/mozjpeg.git "$HERE/mozjpeg"
  exec docker run --rm -u "$(id -u):$(id -g)" -v "$HERE/..:/repo" "$EMSDK_IMAGE" sh /repo/codec/build.sh
fi

cd /repo/codec
if [ ! -f build/libjpeg.a ]; then
  emcmake cmake -S mozjpeg -B build -DCMAKE_C_FLAGS="-msimd128" \
    -DCMAKE_BUILD_TYPE=Release \
    -DWITH_SIMD=0 -DENABLE_SHARED=0 -DWITH_TURBOJPEG=0 -DPNG_SUPPORTED=0 \
    -DWITH_ARITH_ENC=0 -DWITH_ARITH_DEC=0 -DWITH_JPEG8=1
  cmake --build build --target jpeg-static -j4
fi
for name in dec enc; do
  em++ -O3 -msimd128 --bind "$name.cpp" build/libjpeg.a \
    -I mozjpeg -I build \
    -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=16MB \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME="mozjpeg_$name" \
    -s ENVIRONMENT=web -s FILESYSTEM=0 -s DYNAMIC_EXECUTION=0 \
    -s TEXTDECODER=2 -s ASSERTIONS=0 -s MALLOC=emmalloc \
    -o "../worker/lib/mozjpeg_$name.js"
done
ls -la ../worker/lib/mozjpeg_*
