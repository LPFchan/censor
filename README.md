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
`https://censor.lost.plus/mcp` (streamable HTTP, no auth): send an image as
base64 plus `{x, y, w, h}` pixel regions, get the censored image back. Images
are processed in memory and discarded immediately after each response —
nothing is stored. Rate limits are lax (default 30/min per IP).

- server card: `/.well-known/mcp/server-card.json`
- agent skill: `/skills/censor-image/SKILL.md` (index at `/.well-known/agent-skills/index.json`)
- capability manifest: `/.well-known/ai-catalog.json`
- server source: `worker/` (JavaScript port of the app's canvas effects)

## develop

Static-only work: serve `public/` over HTTP:

```sh
python3 -m http.server 8600 -d public
```

Worker work (the full app, /mcp included; needs node):

```sh
npm install
npx wrangler dev        # local workerd, serves the app and /mcp together
```

## deploy

Runs as a single Cloudflare Worker (`worker/`). The static PWA is served from
the worker asset store (`public/`), and `/mcp` plus the MCP server card are
implemented in the worker itself (`worker/index.js`) — a JavaScript port of
the original Pillow reference implementation (kept in git history). Image
decode/encode runs on bundled WASM codecs (UPNG.js for PNG, mozjpeg for
JPEG); the effects are plain typed-array math, so images
still never leave memory and nothing is stored anywhere.

The worker is intentionally anonymous, outside Common Auth, exactly like the
tunnel setup before it. Bump `CACHE` in `public/sw.js` when shipping changes so
installed copies pick up the update.

The icon lab is a static page under `public/icon-lab.html`; its `/save-icons`
and `/save-zip` helpers wrote through the old Python host and no longer have
a backend. Download the icons from the lab and commit them by hand.
