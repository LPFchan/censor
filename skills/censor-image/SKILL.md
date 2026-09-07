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
- For text you must guarantee is unreadable (keys, passwords, addresses),
  prefer mosaic with strength >= 16, or overlap two regions. Very small text
  needs proportionally larger strength — the cell size must exceed the glyph
  height several times over.
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

## limits

30 MB decoded image size, 8192 px max dimension, 64 regions per call.
Rate limits are lax (default 30 requests/minute per IP) but exist — batch all
regions for one image into a single `censor_image` call instead of calling
once per region.
