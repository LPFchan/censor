// censor on Cloudflare Workers: static PWA from the asset store, plus the
// /mcp JSON-RPC endpoint implemented directly in the worker (a stateless
// port of the original Pillow server, itself a port of app.js).
//
// Privacy invariant is unchanged: image bytes live only in this request's
// isolate memory and are dropped when the response is returned. No KV, no
// Cache API, no logging of payloads.

import {
  CensorError, MAX_BASE64_CHARS,
  decodeImage, encodeImage, censor,
} from './lib/effects.js';

const SERVER_INFO = { name: 'censor', version: '2.0.0' };
const PROTOCOL_VERSION = '2025-03-26';

// One image is ~40 MB of base64; anything past it in one JSON-RPC body is
// attack surface, not a request. Same bound as the Python server.
const MAX_MCP_BODY = 41_000_000;

// Fixed-window per-IP rate limit, same lax defaults as the Python server
// (30/min, 240/hour). Kept in isolate memory: it is best-effort across
// isolate restarts, which matches how lax these limits are meant to be.
const RATE_PER_MINUTE = 30;
const RATE_PER_HOUR = 240;
const hits = new Map();

function rateLimited(ip) {
  const now = Date.now();
  let list = hits.get(ip) || [];
  list = list.filter((t) => now - t < 3_600_000);
  const recent = list.filter((t) => now - t < 60_000).length;
  if (list.length >= RATE_PER_HOUR || recent >= RATE_PER_MINUTE) {
    hits.set(ip, list);
    const oldest = list[list.length - RATE_PER_MINUTE] ?? now;
    return Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000));
  }
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] > 3_600_000) hits.delete(k);
  }
  return 0;
}

const REGION_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'Left edge of the region, in pixels from the image\'s left edge.' },
    y: { type: 'number', description: 'Top edge of the region, in pixels from the image\'s top edge.' },
    w: { type: 'number', description: 'Width of the region in pixels.' },
    h: { type: 'number', description: 'Height of the region in pixels.' },
    shape: {
      type: 'string', enum: ['rect', 'ellipse'], default: 'rect',
      description: 'ellipse suits faces and heads; rect suits text, plates, and screens.',
    },
    effect: {
      type: 'string', enum: ['mosaic', 'blur'], default: 'mosaic',
      description: 'Effect for this region. Overrides the call-level default.',
    },
    strength: {
      type: 'integer',
      description: 'Effect strength for this region. mosaic: 1..64 px cell side; blur: 2..80 px radius. Overrides the call-level default.',
    },
  },
  required: ['x', 'y', 'w', 'h'],
};

const TOOLS = [
  {
    name: 'censor_image',
    title: 'Censor image regions',
    description:
      'Censor regions of an image with mosaic (pixelation) or blur. ' +
      'Provide the image as base64 (image_b64) or a data URL (image_url), plus one ' +
      'or more regions to hide. Each region is {x, y, w, h} in source-image pixels, ' +
      'optionally with its own shape (rect or ellipse), effect, and strength. ' +
      'The call-level effect/strength act as defaults for regions that don\'t set ' +
      'their own. Returns the censored image and basic metadata. Nothing is stored: ' +
      'the image lives in memory only for the duration of the call.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        image_b64: { type: 'string', description: 'Base64-encoded source image (PNG or JPEG).' },
        image_url: { type: 'string', description: 'Data URL carrying the source image, as an alternative to image_b64.' },
        regions: { type: 'array', items: REGION_SCHEMA, description: 'One or more regions to censor (max 64).' },
        effect: { type: 'string', enum: ['mosaic', 'blur'], default: 'mosaic' },
        strength: { type: 'integer' },
        output_format: { type: 'string', enum: ['original', 'png', 'jpeg'], default: 'original' },
      },
      required: ['regions'],
    },
  },
  {
    name: 'get_image_info',
    title: 'Get image dimensions',
    description:
      'Return an image\'s width, height, and format. Call this first when you only ' +
      'have the image and need to plan censor_image regions in real pixel coordinates. ' +
      'Nothing is stored.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        image_b64: { type: 'string', description: 'Base64-encoded source image (PNG or JPEG).' },
        image_url: { type: 'string', description: 'Data URL carrying the source image, as an alternative to image_b64.' },
      },
    },
  },
];

const SERVER_INSTRUCTIONS =
  'Apply mosaic (pixelation) or Gaussian blur to regions of an image. ' +
  'Coordinates are pixels in the source image with the origin at the top-left. ' +
  'Pass regions covering whatever should be hidden (faces, text, plates, screens). ' +
  'The image is processed in memory and discarded immediately after the response.';

function jsonRpcResult(id, result) {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, result });
}

function jsonRpcError(id, code, message) {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function bytesToB64(bytes) {
  // chunked to avoid call-stack limits on large images
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

async function callTool(name, args) {
  if (name === 'get_image_info') {
    const { raster, format } = await decodeImage(args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify({ width: raster.width, height: raster.height, format }) }],
      structuredContent: { width: raster.width, height: raster.height, format },
    };
  }
  if (name !== 'censor_image') throw new CensorError(`unknown tool: ${name}`);

  const a = args || {};
  const effect = a.effect ?? 'mosaic';
  if (effect !== 'mosaic' && effect !== 'blur') {
    throw new CensorError("effect must be 'mosaic' or 'blur'");
  }
  const defaultStrength = a.strength ?? (effect === 'mosaic' ? 32 : 12);
  const [lo, hi] = effect === 'mosaic' ? [1, 64] : [2, 80];
  if (!(defaultStrength >= lo && defaultStrength <= hi)) {
    throw new CensorError(`${effect} strength must be ${lo}..${hi}`);
  }
  if (!Array.isArray(a.regions)) throw new CensorError('regions must be an array');
  const regions = a.regions.map((r) => {
    const merged = { effect, strength: defaultStrength };
    for (const [k, v] of Object.entries(r || {})) if (v !== null && v !== undefined) merged[k] = v;
    return merged;
  });

  const { raster, format } = await decodeImage(a);
  const result = censor(raster, regions);
  let fmt = String(a.output_format ?? 'original').toUpperCase();
  if (fmt === 'ORIGINAL') fmt = format === 'JPEG' ? 'JPEG' : 'PNG';
  if (fmt !== 'PNG' && fmt !== 'JPEG') {
    throw new CensorError("output_format must be 'png', 'jpeg', or 'original'");
  }
  const outBytes = await encodeImage(result, fmt);
  const b64 = bytesToB64(outBytes);
  const meta =
    `Censored ${regions.length} region(s) on a ${result.width}x${result.height} image; ` +
    `output ${fmt}, ${Math.ceil(b64.length * 3 / 4 / 1024)} KiB. ` +
    'The source image was processed in memory and discarded.';
  return {
    content: [
      { type: 'image', data: b64, mimeType: `image/${fmt.toLowerCase()}` },
      { type: 'text', text: meta },
    ],
  };
}

async function handleMcp(request) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_MCP_BODY) {
    return Response.json({ error: 'request too large' }, { status: 413 });
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const retry = rateLimited(ip);
  if (retry) {
    return Response.json(
      { error: 'rate limit exceeded, try again later' },
      { status: 429, headers: { 'retry-after': String(retry) } },
    );
  }
  let body;
  try {
    body = await request.text();
  } catch (e) {
    return Response.json({ error: 'could not read request body' }, { status: 400 });
  }
  if (body.length > MAX_MCP_BODY) {
    return Response.json({ error: 'request too large' }, { status: 413 });
  }
  let msg;
  try {
    msg = JSON.parse(body);
  } catch (e) {
    return jsonRpcError(null, -32700, 'Parse error');
  }
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    return jsonRpcError(msg?.id ?? null, -32600, 'Invalid Request');
  }
  const id = msg.id ?? null;

  if (msg.method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      instructions: SERVER_INSTRUCTIONS,
    });
  }
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') {
    return new Response(null, { status: 202 });
  }
  if (msg.method === 'ping') return jsonRpcResult(id, {});
  if (msg.method === 'tools/list') return jsonRpcResult(id, { tools: TOOLS });
  if (msg.method === 'tools/call') {
    try {
      const result = await callTool(msg.params?.name, msg.params?.arguments);
      return jsonRpcResult(id, result);
    } catch (e) {
      if (e instanceof CensorError) return jsonRpcResult(id, toolError(e.message));
      return jsonRpcResult(id, toolError('internal error while processing the image'));
    }
  }
  return jsonRpcError(id, -32601, `Method not found: ${msg.method}`);
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, accept, mcp-session-id, mcp-protocol-version, last-event-id',
  'access-control-expose-headers': 'mcp-session-id, mcp-protocol-version, content-type',
  'access-control-max-age': '86400',
};

function withCors(response) {
  const out = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
  return out;
}

const SERVER_CARD = {
  $schema: 'https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json',
  name: 'plus.lost.censor/censor',
  version: '2.0.0',
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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/mcp' || path === '/mcp/') {
      if (request.method === 'OPTIONS') return withCors(new Response(null, { status: 204 }));
      return withCors(await handleMcp(request));
    }
    if (path === '/healthz') return Response.json({ ok: true });
    if (path === '/.well-known/mcp/server-card.json') {
      return Response.json(SERVER_CARD, {
        headers: { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=3600' },
      });
    }

    // Static app: serve from the asset store, preserving the caching
    // contract (code is no-cache while the app is actively developed) and
    // the agent-discovery Link header on the index page.
    const asset = await env.ASSETS.fetch(request);
    const out = new Response(asset.body, asset);
    if (
      path.includes('nostore')
    ) {
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
