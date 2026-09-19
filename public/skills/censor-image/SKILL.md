---
name: censor-image
description: "Censor regions of an image with mosaic (pixelation) or Gaussian blur before sharing or uploading it. Use when a screenshot or photo contains faces, names, addresses, license plates, API keys, or anything else that should be hidden. Works through the public censor MCP server; images are processed in memory and never stored."
---

# censor-image

Hide sensitive regions of an image by applying the same mosaic and blur
effects as the [censor](https://censor.lost.plus) web app, via its public MCP
server at `https://censor.lost.plus/mcp` (streamable HTTP, no auth).

## privacy

Images are processed in memory on the server and discarded immediately after
each response. Nothing is stored, written to disk, or logged. Even so, prefer
censoring *before* an image travels further than it needs to.

## workflow

1. If you don't know the image dimensions, call `get_image_info` with the
   image (base64 in `image_b64`, or a data URL in `image_url`). Region
   coordinates are pixels in the source image, origin at the top-left.
2. Decide what must be hidden and estimate each region as `{x, y, w, h}`.
   Pad generously — a censor box that is 10 px too small is a leak.
3. Call `censor_image` with the image and the regions. Returns the censored
   image; save or forward that result, never the original.

## choosing effects

- **mosaic** (default, strength 32 = 32x32 px cells): faces, people, license
  plates, anything where hard pixels read as "deliberately hidden".
- **blur** (strength 12 = 12 px radius): softer look; good for backgrounds and
  large areas.
- For text you need unreadable (keys, passwords, addresses), prefer mosaic
  with strength >= 16. Overlapping regions deepen censorship (effects stack).
  Very small text needs proportionally larger strength — the cell size must
  exceed the glyph height several times over. No mosaic strength *guarantees*
  removal of arbitrary text: if the material is genuinely sensitive, look at
  the returned image before forwarding it.
- Use per-region `shape: "ellipse"` for faces and heads; `"rect"` (default)
  for text, plates, and screens.

Each region may override `effect` and `strength` individually; the
call-level values are defaults.

## example

```json
{
  "image_b64": "<base64 of screenshot.png>",
  "regions": [
    {"x": 410, "y": 88, "w": 120, "h": 140, "shape": "ellipse", "effect": "mosaic", "strength": 24},
    {"x": 60, "y": 720, "w": 540, "h": 40, "effect": "mosaic", "strength": 16}
  ],
  "output_format": "png"
}
```

## JPEG in, JPEG out

A JPEG censored to JPEG (the default `output_format: "original"`) is edited
in place: the result keeps the **original resolution**, every pixel outside
your regions is **unchanged byte for byte**, and each censored area **snaps
outward to the JPEG's block grid** (16 px for typical 4:2:0 photos, 8 px for
4:4:4), so the censored box can be up to 15 px larger on each side than you
asked; it is never smaller. Ellipses keep their shape. Colour profile and
orientation are kept; other metadata (GPS, camera, comments) is dropped. The
response text says "in place at full resolution" when this path was used.

## limits

10 MB image file, 8192 px per side, 64 regions per call. In-place JPEG
editing covers photos up to about 26 megapixels (4:2:0) or 13 (4:4:4).
Everything else — PNG input, converting between formats, or a JPEG above
that — goes through a working raster capped at 4 megapixels:

- A **JPEG above 4 MP is decoded downscaled** by 1/2, 1/4 or 1/8 (the
  smallest that fits: a 12 MP photo comes back at 2000x1500, 24 MP at 1/4) and
  the censored result is returned at that reduced size. Keep giving regions in
  source pixels (what `get_image_info` reports); they are scaled for you. The
  response text says the source size, the scale and the output size.
- A **PNG above 4 MP is rejected** with a tool error (PNG has no scaled
  decode): downscale it first, or send it as JPEG.
- Arithmetic-coded and 12-bit JPEGs are refused with a tool error; re-save
  them as ordinary (Huffman, 8-bit) JPEG first.

Rate limits are lax (default 30 requests/minute per IP) but exist — batch all
regions for one image into a single `censor_image` call instead of calling
once per region.
