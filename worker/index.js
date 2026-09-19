// censor on Cloudflare Workers: static PWA from the asset store, plus the
// /mcp endpoint (worker/mcp.js) and the MCP server card.
//
// This Worker declares no route of its own. censor.lost.plus belongs to the
// Common Auth cloud gateway (`auth-gateway`), which invokes this Worker over
// its CENSOR service binding: `/mcp` under the `mcp` policy with
// allow_anonymous, everything else under `public`. Nothing here validates a
// credential; identity, when the gateway attached one, is read in mcp.js
// (via @lost-plus/gateway-identity) for attribution only.
//
// Privacy invariant is unchanged: image bytes live only in this request's
// isolate memory and are dropped when the response is returned. No KV, no
// Cache API, no logging of payloads.

import { handleMcp, SERVER_INFO } from './mcp.js';

const SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'plus.lost.censor/censor',
  version: SERVER_INFO.version,
  description: 'Apply mosaic or blur to regions of an image. Processed in memory, never stored.',
  title: 'censor',
  websiteUrl: 'https://censor.lost.plus',
  repository: {
    url: 'https://github.com/LPFchan/censor',
    source: 'github',
    subfolder: 'worker',
  },
  remotes: [{ type: 'streamable-http', url: 'https://censor.lost.plus/mcp' }],
  _meta: {
    'plus.lost.censor/privacy': 'Images are processed in memory only and discarded immediately after each response.',
  },
};

const APP_CACHE = 'no-cache';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/mcp' || path === '/mcp/') return handleMcp(request);
    if (path === '/healthz') return Response.json({ ok: true });
    if (path === '/.well-known/mcp/server-card.json') {
      // A public discovery document, served on the gateway's `public` route,
      // so it carries its own permissive CORS header (the gateway only owns
      // CORS on the `mcp` route).
      return Response.json(SERVER_CARD, {
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' },
      });
    }

    // Static app: serve from the asset store, preserving the caching
    // contract (code is no-cache while the app is actively developed) and
    // the agent-discovery Link header on the index page.
    const asset = await env.ASSETS.fetch(request);
    const out = new Response(asset.body, asset);
    if (path.includes('nostore')) {
      out.headers.set('cache-control', 'no-store');
    } else if (/\.(js|css|html|webmanifest)$/.test(path) || path === '/' || path === '') {
      out.headers.set('cache-control', APP_CACHE);
    }
    if (path === '/' || path === '/index.html') {
      out.headers.set(
        'link',
        '</.well-known/mcp/server-card.json>; rel="mcp-server-card", </mcp>; rel="service"',
      );
    }
    return out;
  },
};
