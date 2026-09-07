# censor-mcp

MCP server that applies [censor](https://censor.lost.plus)'s blur and mosaic
effects to images supplied by an agent.

**endpoint: `https://censor.lost.plus/mcp`** (streamable HTTP, no auth)

## privacy

Images are processed in memory and discarded immediately after each response.
Nothing is written to disk, logged, or kept. The container is read-only with a
memory-only /tmp.

## tools

- `censor_image(image_b64 | image_url, regions, effect?, strength?, output_format?)`
  — apply mosaic or blur to one or more `{x, y, w, h}` pixel regions.
  Per-region `shape` (`rect`/`ellipse`), `effect`, and `strength` are optional.
  Returns the censored image.
- `get_image_info(image_b64 | image_url)` — width, height, and format, for
  planning region coordinates.

Limits: 30 MB decoded image, 8192 px max dimension, 12 megapixels, 64 regions
per call. Phone photos are normalized to their displayed (EXIF) orientation
before regions are applied, so coordinates address the pixels you see.
Strengths mirror the app: mosaic cell 1–64 px, blur radius 2–80 px.

## rate limits

Lax fixed-window limits per client IP (defaults 30/min, 240/hour), tunable via
`RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_PER_HOUR`.

## run

```sh
docker compose up -d --build   # serves on 127.0.0.1:8610
```

Discovery card at `/.well-known/mcp/server-card.json`.
