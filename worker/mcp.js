// The censor MCP server on Cloudflare Workers, built on
// @modelcontextprotocol/server v2 (McpServer + createMcpHandler).
//
// Two tools, censor_image and get_image_info, with the same names, JSON
// schemas, and result shapes as the original Pillow server. The image lives in
// this request's isolate memory only: no KV, no Cache API, no logging of
// payloads.
//
// Admission runs BEFORE the SDK sees a byte, as the Python server's
// _AdmissionMiddleware did: declared and streamed body caps (413), an absolute
// upload deadline (408), a structural cap on non-image JSON (413), a per-IP
// fixed-window rate limit (429), and a small per-isolate in-flight cap (503).
// The parsed body is then handed to the SDK, which never re-reads it.
//
// There is no CORS and no auth here. censor.lost.plus is fronted by the
// Common Auth cloud gateway; on its `mcp` route the gateway answers OPTIONS
// preflight and /.well-known/oauth-protected-resource itself, strips the
// backend's Access-Control-Allow-Origin/Expose-Headers, and strips
// Authorization before forwarding. What arrives instead, when the caller
// presented a token, is the x-lost-plus-* identity headers, read by the shared
// @lpfchan/gateway-identity parser. Identity is optional here: the `/mcp`
// route is `allow_anonymous`, so a request with no identity headers is a
// legitimate anonymous caller, `identityFrom` returns null for it, and it is
// served exactly like an identified one. Identity gates nothing; it is
// logged for attribution only.

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  createMcpHandler,
  fromJsonSchema,
  isLegacyRequest,
} from '@modelcontextprotocol/server';

import {
  CensorError, decodeImage, encodeImage, censor, imageInfo as headerInfo,
  MAX_PIXELS, MAX_IMAGE_BYTES, MAX_DIMENSION,
} from './lib/effects.js';
import { identityFrom } from '@lpfchan/gateway-identity';

export const SERVER_INFO = { name: 'censor', version: '2.1.0' };

// The image cap (MAX_IMAGE_BYTES) as base64, plus the JSON envelope; anything
// past it in one JSON-RPC body is attack surface, not a request. The body
// bytes, the decoded text and the parsed base64 string are all alive at once
// during JSON.parse, so this cap is also a memory bound.
export const MAX_MCP_BODY = 14_000_000;

// Cap on JSON bytes EXCLUDING the single largest string literal (the image
// payload). A legitimate call is one envelope, one params object, and at most
// 64 small region objects: kilobytes, not megabytes. Checked on the raw bytes
// before JSON.parse so region-shaped structure cannot expand into objects.
export const MAX_JSON_NON_IMAGE = 262_144;

// Absolute wall-clock limit for receiving the complete body. Anonymous slow
// uploads must not hold an in-flight slot indefinitely.
export const BODY_READ_TIMEOUT_MS = 30_000;

// Bodies buffered at once in this isolate. A Worker isolate has 128 MB; two
// 14 MB bodies plus their rasters and the codecs' heaps is the ceiling.
export const MAX_INFLIGHT = 2;

// Fixed-window per-IP rate limit, same lax defaults as the Python server
// (30/min, 240/hour). Kept in isolate memory: best-effort across isolates and
// restarts, which matches how lax these limits are meant to be.
export const RATE_PER_MINUTE = 30;
export const RATE_PER_HOUR = 240;

const state = { hits: new Map(), inflight: 0 };

/** Test hook: forget rate-limit and in-flight state. */
export function resetAdmissionState() {
  state.hits.clear();
  state.inflight = 0;
}

function rateLimited(ip, now = Date.now()) {
  let list = state.hits.get(ip) || [];
  list = list.filter((t) => now - t < 3_600_000);
  const recent = list.filter((t) => now - t < 60_000).length;
  if (list.length >= RATE_PER_HOUR || recent >= RATE_PER_MINUTE) {
    state.hits.set(ip, list);
    const oldest = list[list.length - RATE_PER_MINUTE] ?? now;
    return Math.max(1, Math.ceil((60_000 - (now - oldest)) / 1000));
  }
  list.push(now);
  state.hits.set(ip, list);
  if (state.hits.size > 10_000) {
    for (const [k, v] of state.hits) {
      if (!v.length || now - v[v.length - 1] > 3_600_000) state.hits.delete(k);
    }
  }
  return 0;
}

// --- tool definitions ------------------------------------------------------

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

export const CENSOR_IMAGE_INPUT_SCHEMA = {
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
};

export const GET_IMAGE_INFO_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    image_b64: { type: 'string', description: 'Base64-encoded source image (PNG or JPEG).' },
    image_url: { type: 'string', description: 'Data URL carrying the source image, as an alternative to image_b64.' },
  },
};

const MP = MAX_PIXELS / 1_000_000;
const MB = MAX_IMAGE_BYTES / 1_000_000;

export const LIMITS_TEXT =
  `Limits: ${MB} MB image file, ${MAX_DIMENSION} px per side. ` +
  `The working raster is capped at ${MP} megapixels: a JPEG above that is decoded ` +
  'downscaled by 1/2, 1/4 or 1/8 (the smallest that fits) and the censored result ' +
  'is returned at that reduced size; region coordinates are still given in ' +
  'source pixels and are scaled for you. A PNG above the cap is rejected: ' +
  'downscale it first or send it as JPEG.';

export const SERVER_INSTRUCTIONS =
  'Apply mosaic (pixelation) or Gaussian blur to regions of an image. ' +
  'Coordinates are pixels in the source image with the origin at the top-left. ' +
  'Pass regions covering whatever should be hidden (faces, text, plates, screens). ' +
  'The image is processed in memory and discarded immediately after the response. ' +
  LIMITS_TEXT;

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

function bytesToB64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  // chunked to avoid call-stack limits on large images
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Bad input is a tool error the agent can read; anything else is reported
// without detail, because the detail would be codec internals.
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof CensorError) return toolError(e.message);
    console.error('censor tool failed:', e instanceof Error ? `${e.name} - ${e.message}` : String(e));
    return toolError('internal error while processing the image');
  }
}

async function censorImage(a) {
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

  const { raster, format, source, scale } = await decodeImage(a);
  // Regions arrive in source pixels; the raster may be a 1/scale decode.
  const scaled = scale === 1 ? regions : regions.map((r) => ({
    ...r,
    x: Number(r.x) / scale, y: Number(r.y) / scale, w: Number(r.w) / scale, h: Number(r.h) / scale,
  }));
  const result = censor(raster, scaled);
  let fmt = String(a.output_format ?? 'original').toUpperCase();
  if (fmt === 'ORIGINAL') fmt = format === 'JPEG' ? 'JPEG' : 'PNG';
  if (fmt !== 'PNG' && fmt !== 'JPEG') {
    throw new CensorError("output_format must be 'png', 'jpeg', or 'original'");
  }
  const encoded = await encodeImage(result, fmt);
  const b64 = bytesToB64(encoded);
  const size = scale === 1
    ? `a ${result.width}x${result.height} image`
    : `a ${source.width}x${source.height} image decoded at 1/${scale} (output is ${result.width}x${result.height})`;
  const meta =
    `Censored ${regions.length} region(s) on ${size}; ` +
    `output ${fmt}, ${Math.ceil(encoded.length / 1024)} KiB. ` +
    'The source image was processed in memory and discarded.';
  return {
    content: [
      { type: 'image', data: b64, mimeType: `image/${fmt.toLowerCase()}` },
      { type: 'text', text: meta },
    ],
  };
}

async function imageInfo(a) {
  // Header only: no pixel decode for a dimensions lookup.
  const info = headerInfo(a);
  return {
    content: [{ type: 'text', text: JSON.stringify(info) }],
    structuredContent: info,
  };
}

/**
 * One McpServer per request. `caller` is the gateway-vouched identity or
 * null; it is logged for attribution and gates nothing.
 */
export function buildServer(caller = null) {
  const server = new McpServer(SERVER_INFO, {
    instructions: SERVER_INSTRUCTIONS,
    cacheHints: { 'tools/list': { ttlMs: 300_000, cacheScope: 'private' } },
  });
  const who = caller ? `sub=${caller.sub}` : 'anonymous';

  server.registerTool('censor_image', {
    title: 'Censor image regions',
    description:
      'Censor regions of an image with mosaic (pixelation) or blur. ' +
      'Provide the image as base64 (image_b64) or a data URL (image_url), plus one ' +
      'or more regions to hide. Each region is {x, y, w, h} in source-image pixels, ' +
      'optionally with its own shape (rect or ellipse), effect, and strength. ' +
      'The call-level effect/strength act as defaults for regions that don\'t set ' +
      'their own. Returns the censored image and basic metadata. Nothing is stored: ' +
      'the image lives in memory only for the duration of the call. ' + LIMITS_TEXT,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: fromJsonSchema(CENSOR_IMAGE_INPUT_SCHEMA),
  }, (args) => {
    console.log(`censor_image ${who}`);
    return guarded(() => censorImage(args || {}));
  });

  server.registerTool('get_image_info', {
    title: 'Get image dimensions',
    description:
      'Return an image\'s width, height, and format. Call this first when you only ' +
      'have the image and need to plan censor_image regions in real pixel coordinates. ' +
      'Reads the header only. Nothing is stored.',
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    inputSchema: fromJsonSchema(GET_IMAGE_INFO_INPUT_SCHEMA),
  }, (args) => {
    console.log(`get_image_info ${who}`);
    return guarded(() => imageInfo(args || {}));
  });

  return server;
}

// --- admission -------------------------------------------------------------

function reject(status, error, headers = {}) {
  return Response.json({ error }, { status, headers });
}

/**
 * Buffer the body under the byte cap and the deadline. Returns
 * `{ bytes, declared }` or a Response to send instead.
 */
async function readBody(request, timeoutMs) {
  const lengthHeader = request.headers.get('content-length');
  let declared = null;
  if (lengthHeader !== null) {
    declared = /^\d+$/.test(lengthHeader.trim()) ? Number(lengthHeader) : -1;
    if (declared < 0 || declared > MAX_MCP_BODY) return reject(413, 'request too large');
  }
  if (!request.body) return { bytes: new Uint8Array(0), declared };

  const reader = request.body.getReader();
  const chunks = [];
  let received = 0;
  let timer;
  const TIMED_OUT = Symbol('timeout');
  const deadline = new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs); });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next === TIMED_OUT) {
        reader.cancel().catch(() => {});
        return reject(408, 'request body timed out');
      }
      if (next.done) break;
      received += next.value.byteLength;
      if (received > MAX_MCP_BODY) {
        reader.cancel().catch(() => {});
        return reject(413, 'request too large');
      }
      chunks.push(next.value);
    }
  } catch {
    return reject(400, 'could not read request body');
  } finally {
    clearTimeout(timer);
  }
  const bytes = new Uint8Array(received);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  return { bytes, declared };
}

/**
 * Length of the longest JSON string literal's content, found in one pass with
 * O(1) extra memory (string boundaries and backslash escapes are tracked, no
 * regex, so a 13 MB base64 payload cannot trigger backtracking). In an honest
 * request that string is the image; everything else must fit MAX_JSON_NON_IMAGE.
 */
export function largestStringLength(bytes) {
  let best = 0, inString = false, escaped = false, start = 0;
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (!inString) {
      if (c === 0x22) { inString = true; escaped = false; start = i + 1; }
    } else if (escaped) {
      escaped = false;
    } else if (c === 0x5c) {
      escaped = true;
    } else if (c === 0x22) {
      if (i - start > best) best = i - start;
      inString = false;
    }
  }
  return best;
}

function jsonRpcError(id, code, message) {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

/**
 * Serve one /mcp request. Admission first; then the SDK, which serves the
 * 2026-07-28 revision through createMcpHandler and 2025-era clients through a
 * stateless streamable-HTTP transport with JSON responses (the shape the
 * Python server ran with json_response=True).
 */
export async function handleMcp(request, { bodyReadTimeoutMs = BODY_READ_TIMEOUT_MS } = {}) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST' } });
  }
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const retry = rateLimited(ip);
  if (retry) {
    return reject(429, 'rate limit exceeded, try again later', { 'retry-after': String(retry) });
  }
  if (state.inflight >= MAX_INFLIGHT) {
    return reject(503, 'server busy, try again in a few seconds', { 'retry-after': '5' });
  }
  state.inflight++;
  try {
    const read = await readBody(request, bodyReadTimeoutMs);
    if (read instanceof Response) return read;
    const { bytes, declared } = read;
    if (declared !== null && declared !== bytes.length) {
      return reject(413, 'request rejected: invalid length or too much non-image JSON');
    }
    if (bytes.length - largestStringLength(bytes) > MAX_JSON_NON_IMAGE) {
      return reject(413, 'request rejected: invalid length or too much non-image JSON');
    }
    let parsedBody;
    try {
      parsedBody = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return jsonRpcError(null, -32700, 'Parse error');
    }

    const caller = identityFrom(request.headers);
    const factory = () => buildServer(caller);
    const onerror = (e) => console.error('censor mcp:', e.message);

    if (await isLegacyRequest(request, parsedBody)) {
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      transport.onerror = onerror;
      const server = factory();
      await server.connect(transport);
      return transport.handleRequest(request, { parsedBody });
    }
    return createMcpHandler(factory, { legacy: 'reject', onerror })
      .fetch(request, { parsedBody });
  } finally {
    state.inflight--;
  }
}
