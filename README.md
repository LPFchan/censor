# censor

A mobile-first PWA that censors photos with **blur** and **mosaic** — all
nondestructive, all on-device. No uploads, no server, no accounts.

**live: https://censor.lost.plus**

## features

- **box tool** — drag to draw a rectangular censor region
- **freehand tool** — scribble to censor arbitrary shapes (adjustable brush size)
- load an image with the file picker, drag it onto any screen, Cmd/Ctrl+V, or the clipboard button
- every censor is an **object**: tap it in move mode to select, drag to
  reposition, resize boxes from their corner handles, adjust its effect
  (mosaic / blur) and strength, or delete it
- creating a box or freehand censor returns to move mode automatically
- keyboard shortcuts: M = box, V = move, B = brush, [ / ] = effect strength, Cmd/Ctrl+C then Cmd/Ctrl+V to copy and paste the selected object, Alt-drag to duplicate an object, Shift-drag to lock movement onto the horizontal or vertical line through the object's start position
- undo and redo controls cover edits to censor objects
- opening a new image asks for confirmation when edit history would be lost
- closing or reloading the tab warns when edit history would be lost
- 32 hand-written, browser-selected language catalogs with per-message English fallback and RTL support
- strength is **per object**: mosaic = square cell size from 1×1 to 64×64 pixels,
  blur = radius in pixels
- pinch to zoom, two-finger / move-mode drag to pan
- copy or save the full-resolution result as a PNG (original stays untouched)
- installable (Add to Home Screen), works offline after first visit

## privacy

Images never leave the device. The whole app is static files; editing happens
entirely in canvas.

## for agents

The same effects are available to agents as an MCP server at
`https://censor.lost.plus/mcp` (streamable HTTP; protocol revisions
2025-03-26, 2025-06-18 and 2026-07-28). Send an image as base64 plus
`{x, y, w, h}` pixel regions, get the censored image back. Images are
processed in memory and discarded immediately after each response; nothing
is stored. Rate limits are lax (30/min and 240/hour per IP).

**JPEG in, JPEG out is censored in place.** The file is transcoded in the
DCT domain and only the 8x8 blocks the regions touch are re-encoded, so the
result keeps the **original resolution**, every pixel outside the regions is
**bit-exact** (the compressed coefficients are copied through, as `jpegtran`
does), and each censored area **snaps outward to the JPEG's block grid**: 16
px for the usual 4:2:0 chroma subsampling, 8 px for 4:4:4 and greyscale.
Ellipses keep their shape inside that snapped box. The colour profile (ICC)
and the EXIF orientation flag are carried over; all other metadata (GPS,
camera, XMP, comments) is dropped, as it always was. Progressive input comes
back baseline. Arithmetic-coded and 12-bit JPEGs are refused with a tool
error. This path is used for JPEGs whose coefficient arrays fit 80 MB: about
26 megapixels at 4:2:0, 13 at 4:4:4 (`MAX_JPEG_COEF_BYTES`).

**Limits** (a Worker isolate has 128 MB, and these are what fits in it with
headroom): 10 MB image file, 8192 px per side, 64 regions per call. PNG
input, format conversions (`output_format` differing from the source) and
JPEGs above the coefficient budget go through the pixel path, whose working
raster is capped at **4 megapixels**: a JPEG above that is decoded downscaled
by 1/2, 1/4 or 1/8 (the smallest that fits) and the censored result is
returned at that reduced size; region coordinates are still given in source
pixels and scaled server-side, and the response text states the source size,
the scale and the output size. A PNG above 4 MP is rejected from its header
with a tool error asking the caller to downscale first or send JPEG (PNG has
no scaled decode). `get_image_info` reads the header only and always reports
the source dimensions.

Auth is optional. The endpoint sits behind the Common Auth gateway with
anonymous access allowed: no credential is needed, and a Common Auth token
(`Authorization: Bearer ...`) is accepted and attributed but unlocks nothing
extra. A bad token is refused by the gateway (401), not silently downgraded.

- server card: `/.well-known/mcp/server-card.json`
- OAuth protected-resource metadata: `/.well-known/oauth-protected-resource/mcp` (answered by the gateway)
- agent skill: `/skills/censor-image/SKILL.md` (index at `/.well-known/agent-skills/index.json`)
- capability manifest: `/.well-known/ai-catalog.json`
- server source: `worker/mcp.js` (tools and admission), `worker/lib/` (JavaScript port of the app's canvas effects)

## develop

```sh
npm install
npx wrangler dev        # local workerd, serves the app and /mcp together
npm test                # vitest inside workerd (@cloudflare/vitest-pool-workers)
```

Static-only work can also be served straight from `public/` with any file
server; the app has no build step.

## deploy

One Cloudflare Worker, `censor` (`wrangler.toml`), deployed with
`npm run deploy`, which fetches the deploy token from passage (`infra` /
`CF_MASTER_TOKEN`, via the `passage` setup module) and runs `wrangler
deploy`; nothing to export by hand. The static PWA is served from the Worker's asset store
(`public/`); `/mcp`, `/healthz` and the MCP server card are handled by the
script (`worker/`). Image decode/encode runs on bundled WASM codecs (UPNG.js
for PNG, libjpeg-turbo for JPEG); the effects are plain typed-array math. The
Worker holds no state: no KV, D1, R2 or Cache API, and every image is gone
when its response is returned.

**JPEG codec.** `worker/lib/jpeg_{dec,enc,censor}.{js,wasm}` are built from
`codec/dec.cpp`, `codec/enc.cpp` and `codec/censor.cpp` by `codec/build.sh`
(docker + `emscripten/emsdk`; libjpeg-turbo 3.2.0 plus
`codec/wasm-simd128.patch`, the hand-written WebAssembly SIMD128 kernel set
from jerbob92/libjpeg-turbo, licence in `worker/lib/LICENSE.libjpeg-turbo.md`).
The SIMD kernels are bit-identical to libjpeg-turbo's scalar paths and roughly
halve codec CPU under V8 (1.5 MP: decode 40 -> 27 ms, encode 42 -> 26 ms on
the OCI arm64 box; a larger gain on x86). The decoder takes a DCT scale
denominator (1, 2, 4, 8) so a large photo is decoded straight to the 4 MP
working size without the full raster ever existing. The encoder is baseline,
quality 92, no progressive, no Huffman optimisation: the earlier
mozjpeg/@jsquash build spent ~1.9 s of CPU encoding a 1.5 MP image.

**DCT-domain censor** (`codec/censor.cpp`). `jpeg_read_coefficients` loads
the quantized coefficient arrays, `jpeg_copy_critical_parameters` +
`jpeg_write_coefficients` write them back with the source's quantization
tables (baseline, no Huffman optimisation). For each region and each colour
component, the region (mapped by `effects.js` into the JPEG's stored
orientation) snaps outward to the MCU grid; those blocks plus a ring of
context (one mosaic cell, or the blur's support) are dequantized and
inverse-DCT'd into a float patch in the component's own plane and resolution;
the effect runs on the patch (mosaic: plain mean of each cell, cells in luma
pixels on the same anchored grid as the pixel path; blur: the same three-box
Gaussian, sigma scaled per axis by the sampling factor); the snapped blocks
are forward-DCT'd and re-quantized. The 8x8 DCTs are a plain separable
matrix form, ~100 lines. Work is banded so patch buffers stay under 8 MB.
Peak WASM heap is the coefficient arrays (3 bytes/px at 4:2:0, 6 at 4:4:4)
plus the file about twice, measured 69 MB at 12 MP 4:2:0 and 117 MB at 24 MP;
live, 24 MP 4:2:0 (72 MB of arrays) served concurrent pairs without an OOM
and 122 MB of arrays served single requests, so `MAX_JPEG_COEF_BYTES` = 80 MB
keeps measured headroom. Cost, on the OCI arm64 box under Node (workerd's
clock is frozen during a request, so stages are timed outside it), median ms
read coefficients / block work / write, for a region of 3% of the area:
0.4 MP 3/1/3, 1.5 MP 10/2/11, 6 MP 38/7/46, 12 MP 75/14/92; for a 50% blur
region the block work grows to 32 ms at 1.5 MP and 260 ms at 12 MP, still at
full output resolution.

**Routing.** The Worker declares no route of its own and is off workers.dev.
`censor.lost.plus/*` belongs to the `auth-gateway` Worker (repo `auth`,
`gateway/config/cloudflare.gateway.json`), which reaches this Worker over its
`CENSOR` service binding: `/mcp` under the `mcp` policy with
`allow_anonymous: true` (token scope `censor`), and `/` under `public` for
the app, the server card and `/healthz`. The gateway owns CORS and the
OAuth metadata document on `/mcp`, strips `Authorization` before forwarding,
and attaches `x-lost-plus-*` identity headers only when the caller presented a
valid token (`worker/mcp.js` reads them with the shared
[`@lpfchan/gateway-identity`](https://github.com/LPFchan/auth/tree/main/packages/gateway-identity)
package, for attribution and nothing else). This Worker never validates a credential.

**Rollback.** `git revert` the offending commit and `npm run deploy` again;
there is no state to migrate. The route stays with the gateway either way.

**Admission.** `worker/mcp.js` enforces, before the MCP SDK reads anything:
14 MB body cap (413; the 10 MB image cap as base64 plus envelope), 30 s
upload deadline (408), 256 KiB cap on JSON outside the image string (413),
30/min and 240/hour per IP (429, best-effort per isolate), and two bodies in
flight per isolate (503).

**Memory budget.** For one request the isolate holds, at peak: the body
bytes, the decoded text and the parsed base64 string during `JSON.parse`
(3x the base64 size, so ~40 MB at the 14 MB body cap), then the image bytes
plus the codec's copy of them, and on the pixel path the working raster (16
MB at 4 MP; the decoder writes it once in WASM memory and the binding copies
it out), region-sized scratch layers, and on encode a second copy of the
raster inside the encoder's WASM heap plus the output. On the DCT path it is
the coefficient arrays instead (see above). All three WASM heaps persist per
isolate and never shrink, which is why the pixel-path raster cap is 4 MP and
not 12: 12 MP would put ~150 MB of raster copies alone through a 128 MB
isolate.

Bump `CACHE` in `public/sw.js` when shipping app changes so installed copies
pick up the update.

The icon lab is a static page under `public/icon-lab.html`; its `/save-icons`
and `/save-zip` helpers have no backend. Download the icons from the lab and
commit them by hand.
