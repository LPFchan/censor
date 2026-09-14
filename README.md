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
- keyboard shortcuts: M = box, V = move, B = brush, [ / ] = effect strength, Cmd/Ctrl+C then Cmd/Ctrl+V to copy and paste the selected object, Alt-drag to duplicate an object
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
- server source: `mcp-server/` (Pillow port of the app's canvas effects)

## develop

It's just static files — serve the directory over HTTP:

```sh
python3 -m http.server 8600
```

## deploy

Hosted through the OCI Common Auth gateway as an explicit `public` service:
Cloudflare Tunnel sends `censor.lost.plus` to `127.0.0.1:8740`, and the gateway
proxies to this server on `127.0.0.1:8600`. Censor intentionally remains
anonymous; the gateway strips shared cookies and machine credentials before
forwarding. Bump `CACHE` in `sw.js` when shipping changes so installed copies
pick up the update.

The icon lab's `/save-icons` and `/save-zip` helpers are disabled by default.
For a direct local development session only, set `CENSOR_ENABLE_LOCAL_WRITES=1`;
never set it on the gateway-backed production service.
