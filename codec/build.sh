#!/bin/sh
# Rebuilds worker/lib/jpeg_{dec,enc,censor}.{js,wasm} from dec.cpp, enc.cpp
# and censor.cpp.
#
#   ./codec/build.sh            # on the host: needs docker, clones libjpeg-turbo
#
# Run without arguments on the host it fetches libjpeg-turbo $LJT_TAG into
# codec/libjpeg-turbo (git-ignored), applies wasm-simd128.patch (the
# hand-written WebAssembly SIMD128 kernel set from
# github.com/jerbob92/libjpeg-turbo, branch wasm-simd128 at 696e2a1, five
# commits originally on top of the 3.2.0 tag, rebased onto newer releases
# here; output is bit-identical to the scalar C paths), then re-enters itself
# inside the $EMSDK_IMAGE image, where it
# builds libjpeg with WITH_WASM_SIMD=1 and links the three entry points against
# it. Measured under V8 (vitest workerd pool): decode 1.5x and encode 1.6-1.9x
# faster than the scalar build, same bytes out.
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
LJT_TAG=3.2.1
EMSDK_IMAGE=emscripten/emsdk:7.0.0

if ! command -v emcc >/dev/null 2>&1; then
  # The clone and the build dir are reused only while the pins and the patch
  # are unchanged; the stamp is written after the patch applies, so a failed
  # apply never leaves a tree that later builds without the SIMD kernels.
  stamp="$LJT_TAG $EMSDK_IMAGE $(sha256sum "$HERE/wasm-simd128.patch" | cut -c1-16)"
  if [ "$(cat "$HERE/libjpeg-turbo/.censor-stamp" 2>/dev/null)" != "$stamp" ]; then
    rm -rf "$HERE/libjpeg-turbo" "$HERE/build"
    git clone -q --depth 1 -b "$LJT_TAG" https://github.com/libjpeg-turbo/libjpeg-turbo.git "$HERE/libjpeg-turbo"
    git -C "$HERE/libjpeg-turbo" apply "$HERE/wasm-simd128.patch"
    echo "$stamp" >"$HERE/libjpeg-turbo/.censor-stamp"
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
# Without the kernels libjpeg-turbo quietly falls back to its C paths, which
# give the same bytes, so the tests would not notice.
grep -q '^#define SIMD_ARCHITECTURE  WASM$' build/jconfigint.h || {
  echo "build.sh: libjpeg was configured without the WebAssembly SIMD kernels" >&2
  exit 1
}
for name in dec enc censor; do
  em++ -O3 -msimd128 --bind "$name.cpp" build/libjpeg.a \
    -I libjpeg-turbo -I libjpeg-turbo/src -I build \
    -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=16MB \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME="jpeg_$name" \
    -s ENVIRONMENT=web -s FILESYSTEM=0 -s DYNAMIC_EXECUTION=0 \
    -s TEXTDECODER=2 -s ASSERTIONS=0 -s MALLOC=emmalloc \
    -o "../worker/lib/jpeg_$name.js"
done
ls -la ../worker/lib/jpeg_*
