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
for PNG, mozjpeg for JPEG); the effects are plain typed-array math. The
Worker holds no state: no KV, D1, R2 or Cache API, and every image is gone
when its response is returned.

**Routing.** The Worker declares no route of its own and is off workers.dev.
`censor.lost.plus/*` belongs to the `auth-gateway` Worker (repo `auth`,
`gateway/config/cloudflare.gateway.json`), which reaches this Worker over its
`CENSOR` service binding: `/mcp` under the `mcp` policy with
`allow_anonymous: true` (token scope `censor`), and `/` under `public` for
the app, the server card and `/healthz`. The gateway owns CORS and the
OAuth metadata document on `/mcp`, strips `Authorization` before forwarding,
and attaches `x-lost-plus-*` identity headers only when the caller presented a
valid token (`worker/mcp.js` reads them with the shared
[`@lost-plus/gateway-identity`](https://github.com/LPFchan/gateway-identity)
package, for attribution and nothing else). This Worker never validates a credential.

**Rollback.** `git revert` the offending commit and `npm run deploy` again;
there is no state to migrate. The route stays with the gateway either way.

**Admission.** `worker/mcp.js` enforces, before the MCP SDK reads anything:
41 MB body cap (413), 30 s upload deadline (408), 256 KiB cap on JSON
outside the image string (413), 30/min and 240/hour per IP (429, best-effort
per isolate), and two bodies in flight per isolate (503).

Bump `CACHE` in `public/sw.js` when shipping app changes so installed copies
pick up the update.

The icon lab is a static page under `public/icon-lab.html`; its `/save-icons`
and `/save-zip` helpers have no backend. Download the icons from the lab and
commit them by hand.
