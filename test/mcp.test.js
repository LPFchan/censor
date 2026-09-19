// Runs inside workerd (see vitest.config.js) so the WASM codecs and the
// assets binding are the real thing. Every request goes through the Worker's
// default export exactly as the gateway's service binding would call it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';

import worker from '../worker/index.js';
import {
  handleMcp, resetAdmissionState,
  CENSOR_IMAGE_INPUT_SCHEMA, GET_IMAGE_INFO_INPUT_SCHEMA,
  MAX_MCP_BODY, MAX_JSON_NON_IMAGE, RATE_PER_MINUTE, MAX_INFLIGHT,
} from '../worker/mcp.js';
import {
  decodeImage, censor, applyExifOrientation, toStoredBox, readExifOrientation,
  headerDimensions, jpegFitsDctPath, MAX_PIXELS,
} from '../worker/lib/effects.js';
import { Raster } from '../worker/lib/resize.js';
import { encodeJpeg } from '../worker/lib/jpeg.js';
import {
  TINY_PNG, TINY_JPG, EXIF6_JPG, BOMB_HEADER_PNG,
  GRAD444_JPG, GRAD420_JPG, GRAD_PROG_JPG, EXIF6_MARK_JPG,
} from './fixtures.js';

const ORIGIN = 'https://censor.lost.plus';

// What a 2025-era streamable-HTTP client sends.
const LEGACY_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

function request(path, init = {}) {
  return new Request(ORIGIN + path, init);
}

async function rpc(method, params = {}, { headers = {}, id = 1 } = {}) {
  const res = await worker.fetch(request('/mcp', {
    method: 'POST',
    headers: { ...LEGACY_HEADERS, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  }), env);
  return { status: res.status, headers: res.headers, json: res.status === 202 ? null : await res.json() };
}

/** A 2026-07-28 request: per-request _meta envelope plus the two headers. */
async function modern(method, params = {}) {
  const headers = { 'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': method };
  if (params.name) headers['Mcp-Name'] = params.name;
  return rpc(method, { ...params, _meta: MODERN_META }, { headers });
}

async function callTool(name, args, via = rpc) {
  const r = await via('tools/call', { name, arguments: args });
  expect(r.status).toBe(200);
  return r.json.result;
}

const IDENTITY = {
  'x-lost-plus-sub': '42',
  'x-lost-plus-email': 'me%40lost.plus',
  'x-lost-plus-name': '%EC%82%AC%EC%9A%A9%EC%9E%90',
  'x-lost-plus-role': 'user',
  'x-lost-plus-encoding': 'percent-utf8',
};

beforeEach(() => resetAdmissionState());
afterEach(() => resetAdmissionState());

// --- protocol -----------------------------------------------------------------

describe('initialize', () => {
  for (const version of ['2025-03-26', '2025-06-18']) {
    it(`negotiates ${version}`, async () => {
      const r = await rpc('initialize', {
        protocolVersion: version,
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/application\/json/);
      expect(r.json.result.protocolVersion).toBe(version);
      expect(r.json.result.serverInfo).toMatchObject({ name: 'censor' });
      expect(r.json.result.capabilities.tools).toBeDefined();
      expect(r.json.result.instructions).toMatch(/mosaic/);
    });
  }

  it('acknowledges notifications/initialized with 202', async () => {
    const res = await worker.fetch(request('/mcp', {
      method: 'POST',
      headers: LEGACY_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    }), env);
    expect(res.status).toBe(202);
  });

  it('answers ping', async () => {
    const r = await rpc('ping');
    expect(r.json).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });
});

describe('tools/list', () => {
  it('advertises the two tools with the original JSON schemas (2025 era, no cache fields)', async () => {
    const r = await rpc('tools/list');
    expect(r.status).toBe(200);
    const tools = r.json.result.tools;
    expect(tools.map((t) => t.name)).toEqual(['censor_image', 'get_image_info']);
    expect(tools[0].inputSchema).toEqual(CENSOR_IMAGE_INPUT_SCHEMA);
    expect(tools[1].inputSchema).toEqual(GET_IMAGE_INFO_INPUT_SCHEMA);
    expect(tools[0].annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    expect(tools[0].title).toBe('Censor image regions');
    expect(r.json.result.ttlMs).toBeUndefined();
    expect(r.json.result.cacheScope).toBeUndefined();
  });

  it('carries the 5-minute private cache hint on 2026-07-28', async () => {
    const r = await modern('tools/list');
    expect(r.status).toBe(200);
    expect(r.json.result.tools.map((t) => t.name)).toEqual(['censor_image', 'get_image_info']);
    expect(r.json.result.ttlMs).toBe(300_000);
    expect(r.json.result.cacheScope).toBe('private');
  });

  it('serves server/discover on 2026-07-28', async () => {
    const r = await modern('server/discover');
    expect(r.status).toBe(200);
    expect(r.json.result.supportedVersions).toContain('2026-07-28');
  });
});

describe('unknown methods and bad envelopes', () => {
  it('returns -32601 for an unknown method', async () => {
    const r = await rpc('nope/nothing');
    expect(r.json.error.code).toBe(-32601);
  });

  it('returns -32700 for a body that is not JSON', async () => {
    const res = await worker.fetch(request('/mcp', { method: 'POST', headers: LEGACY_HEADERS, body: '{not json' }), env);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });

  it('refuses non-POST with 405', async () => {
    const res = await worker.fetch(request('/mcp'), env);
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
  });
});

// --- tools --------------------------------------------------------------------

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pixel(raster, x, y) {
  const i = (y * raster.width + x) * 4;
  return Array.from(raster.data.subarray(i, i + 3));
}

/**
 * A synthetic photo-sized JPEG, made here rather than committed: vertical
 * black/white stripes 4 px wide, so a mosaic cell averages to mid grey while
 * untouched areas keep their contrast even after a 1/2 decode.
 */
async function stripedJpeg(width, height) {
  const r = new Raster(width, height);
  const row = new Uint8ClampedArray(width * 4);
  for (let x = 0; x < width; x++) {
    const v = (x >> 2) & 1 ? 255 : 0;
    row[x * 4] = v; row[x * 4 + 1] = v; row[x * 4 + 2] = v; row[x * 4 + 3] = 255;
  }
  for (let y = 0; y < height; y++) r.data.set(row, y * width * 4);
  return (await encodeJpeg(r)).toBase64();
}

/** tiny.png with its IHDR rewritten to declare width x height (CRC left stale). */
function pngDeclaring(width, height) {
  const bytes = Uint8Array.fromBase64(TINY_PNG);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes.toBase64();
}

function rowContrast(raster, y, x0, x1) {
  let lo = 255, hi = 0;
  for (let x = x0; x < x1; x++) { const v = raster.data[(y * raster.width + x) * 4]; if (v < lo) lo = v; if (v > hi) hi = v; }
  return hi - lo;
}

describe('get_image_info', () => {
  it('reads a PNG', async () => {
    const result = await callTool('get_image_info', { image_b64: TINY_PNG });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({ width: 32, height: 24, format: 'PNG' });
    expect(JSON.parse(result.content[0].text)).toEqual({ width: 32, height: 24, format: 'PNG' });
  });

  it('reads a JPEG from a data URL', async () => {
    const result = await callTool('get_image_info', { image_url: `data:image/jpeg;base64,${TINY_JPG}` });
    expect(result.structuredContent).toEqual({ width: 32, height: 24, format: 'JPEG' });
  });

  it('reports EXIF-rotated dimensions as the caller sees them', async () => {
    const result = await callTool('get_image_info', { image_b64: EXIF6_JPG });
    expect(result.structuredContent).toEqual({ width: 4, height: 6, format: 'JPEG' });
  });

  it('reads the header only: an over-budget PNG still reports its size', async () => {
    const result = await callTool('get_image_info', { image_b64: pngDeclaring(2100, 2000) });
    expect(result.structuredContent).toEqual({ width: 2100, height: 2000, format: 'PNG' });
  });
});

describe('censor_image', () => {
  it('mosaics a PNG region and leaves the rest untouched', async () => {
    const result = await callTool('censor_image', {
      image_b64: TINY_PNG,
      regions: [{ x: 0, y: 0, w: 16, h: 24 }],
      effect: 'mosaic',
      strength: 16,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(result.content[1].text).toMatch(/^Censored 1 region\(s\) on a 32x24 image; output PNG/);

    const { raster: before } = await decodeImage({ image_b64: TINY_PNG });
    const { raster: after } = await decodeImage({ image_b64: result.content[0].data });
    expect([after.width, after.height]).toEqual([32, 24]);
    // Inside a 16px mosaic cell every pixel is the same colour.
    expect(pixel(after, 0, 0)).toEqual(pixel(after, 15, 15));
    expect(pixel(after, 0, 0)).not.toEqual(pixel(before, 0, 0));
    // Right half is untouched, pixel for pixel.
    for (let y = 0; y < 24; y++) {
      for (let x = 16; x < 32; x++) expect(pixel(after, x, y)).toEqual(pixel(before, x, y));
    }
  });

  it('blurs a JPEG region and returns JPEG by default', async () => {
    const result = await callTool('censor_image', {
      image_b64: TINY_JPG,
      regions: [{ x: 4, y: 4, w: 12, h: 12, shape: 'ellipse' }],
      effect: 'blur',
      strength: 6,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/jpeg' });
    expect(result.content[1].text).toMatch(/output JPEG/);
    const bytes = b64ToBytes(result.content[0].data);
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xd8]);
  });

  it('honours output_format and per-region overrides', async () => {
    const result = await callTool('censor_image', {
      image_b64: TINY_JPG,
      regions: [
        { x: 0, y: 0, w: 8, h: 8, effect: 'mosaic', strength: 8 },
        { x: 16, y: 8, w: 8, h: 8, effect: 'blur', strength: 4 },
      ],
      output_format: 'png',
    });
    expect(result.content[0].mimeType).toBe('image/png');
    expect(result.content[1].text).toMatch(/Censored 2 region\(s\)/);
  });

  it('censors a 1.5 MP JPEG in place at full size', async () => {
    const image_b64 = await stripedJpeg(1500, 1000);
    const result = await callTool('censor_image', {
      image_b64, regions: [{ x: 0, y: 0, w: 750, h: 1000 }], strength: 32,
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[1].text).toMatch(/^Censored 1 region\(s\) on a 1500x1000 JPEG in place at full resolution/);
    const { raster } = await decodeImage({ image_b64: result.content[0].data });
    expect([raster.width, raster.height]).toEqual([1500, 1000]);
    expect(rowContrast(raster, 500, 0, 700)).toBeLessThan(40);      // mosaicked: flat grey
    expect(rowContrast(raster, 500, 800, 1500)).toBeGreaterThan(150); // untouched: stripes
  });

  it('converts a 12 MP JPEG to PNG through the pixel path: decoded at 1/2, regions scaled', async () => {
    const image_b64 = await stripedJpeg(4000, 3000);
    expect(4000 * 3000).toBeGreaterThan(MAX_PIXELS);
    const info = await callTool('get_image_info', { image_b64 });
    expect(info.structuredContent).toEqual({ width: 4000, height: 3000, format: 'JPEG' });

    // Region in SOURCE pixels: the left half.
    const result = await callTool('censor_image', {
      image_b64, regions: [{ x: 0, y: 0, w: 2000, h: 3000 }], strength: 32, output_format: 'png',
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[1].text).toMatch(
      /^Censored 1 region\(s\) on a 4000x3000 image decoded at 1\/2 \(output is 2000x1500\); output PNG/,
    );
    const { raster, scale } = await decodeImage({ image_b64: result.content[0].data });
    expect(scale).toBe(1);
    expect([raster.width, raster.height]).toEqual([2000, 1500]);
    expect(rowContrast(raster, 750, 0, 950)).toBeLessThan(40);        // left half mosaicked
    expect(rowContrast(raster, 750, 1050, 2000)).toBeGreaterThan(100); // right half still striped
  }, 30_000);


  // --- the DCT path: JPEG in, JPEG out --------------------------------------
  describe('JPEG in place (DCT domain)', () => {
    /**
     * Pixels of `after` that differ from `before`, split into those inside
     * `box` [x0, y0, x1, y1) and those outside it by more than `margin` px.
     * The 1 px margin is the decoder's chroma upsampling, which blends a
     * changed chroma block into the neighbouring pixel row/column; the
     * coefficients there are untouched.
     */
    function changed(before, after, box, margin = 1) {
      const w = before.width, h = before.height;
      let inside = 0, outside = 0, boxPixels = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const d = before.data[i] !== after.data[i] || before.data[i + 1] !== after.data[i + 1] || before.data[i + 2] !== after.data[i + 2];
          const inBox = x >= box[0] && x < box[2] && y >= box[1] && y < box[3];
          const near = x >= box[0] - margin && x < box[2] + margin && y >= box[1] - margin && y < box[3] + margin;
          if (inBox) { boxPixels++; if (d) inside++; } else if (!near && d) outside++;
        }
      }
      return { inside, outside, boxPixels };
    }
    async function roundTrip(image_b64, args) {
      const result = await callTool('censor_image', { image_b64, ...args });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].mimeType).toBe('image/jpeg');
      const { raster: before } = await decodeImage({ image_b64 });
      const { raster: after } = await decodeImage({ image_b64: result.content[0].data });
      expect([after.width, after.height]).toEqual([before.width, before.height]);
      return { result, before, after, bytes: b64ToBytes(result.content[0].data) };
    }
    function sofMarker(bytes) {
      let p = 2;
      while (p + 4 <= bytes.length) {
        const m = bytes[p + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return m;
        p += 2 + ((bytes[p + 2] << 8) | bytes[p + 3]);
      }
      return null;
    }

    it('leaves every pixel outside the snapped region bit-exact (4:2:0, region inside)', async () => {
      const image_b64 = await stripedJpeg(640, 480);
      const { before, after } = await roundTrip(image_b64, { regions: [{ x: 100, y: 100, w: 200, h: 120 }], strength: 16 });
      // Requested [100,300)x[100,220) snaps outward to the 16 px MCU grid.
      const c = changed(before, after, [96, 96, 304, 224]);
      expect(c.outside).toBe(0);
      expect(c.inside).toBeGreaterThan(c.boxPixels * 0.9);
    });

    it('snaps to 16 px for 4:2:0 and 8 px for 4:4:4', async () => {
      for (const [fixture, grid] of [[GRAD420_JPG, 16], [GRAD444_JPG, 8]]) {
        const { before, after } = await roundTrip(fixture, { regions: [{ x: 41, y: 21, w: 10, h: 10 }], strength: 4 });
        const box = [Math.floor(41 / grid) * grid, Math.floor(21 / grid) * grid, Math.ceil(51 / grid) * grid, Math.ceil(31 / grid) * grid];
        const c = changed(before, after, box);
        expect(c.outside).toBe(0);
        expect(c.inside).toBeGreaterThan(c.boxPixels * 0.8);
        // Column 36 is inside the 16 px snap but outside the 8 px one.
        const col36 = changed(before, after, [36, 0, 37, 48], 0).inside;
        if (grid === 16) expect(col36).toBeGreaterThan(0); else expect(col36).toBe(0);
      }
    });

    it('handles a region touching and crossing the image border', async () => {
      const image_b64 = await stripedJpeg(300, 200);
      const { before, after, result } = await roundTrip(image_b64, { regions: [{ x: -20, y: 150, w: 120, h: 100 }], strength: 8 });
      expect(result.content[1].text).toMatch(/300x200 JPEG in place/);
      const c = changed(before, after, [0, 144, 112, 200]);
      expect(c.outside).toBe(0);
      expect(c.inside).toBeGreaterThan(c.boxPixels * 0.9);
    });

    it('blurs in place too, with the same bit-exact outside', async () => {
      const image_b64 = await stripedJpeg(400, 300);
      const { before, after } = await roundTrip(image_b64, { regions: [{ x: 100, y: 100, w: 100, h: 80 }], effect: 'blur', strength: 6 });
      const c = changed(before, after, [96, 96, 208, 192]);
      expect(c.outside).toBe(0);
      expect(c.inside).toBeGreaterThan(c.boxPixels * 0.9);
      expect(rowContrast(after, 140, 112, 192)).toBeLessThan(60);   // blurred stripes
      expect(rowContrast(after, 140, 250, 400)).toBeGreaterThan(150); // untouched
    });

    it('keeps an ellipse round: corner blocks of its box stay bit-exact', async () => {
      const image_b64 = await stripedJpeg(320, 240);
      const { before, after } = await roundTrip(image_b64, { regions: [{ x: 64, y: 64, w: 128, h: 96, shape: 'ellipse' }], strength: 64 });
      expect(changed(before, after, [64, 64, 80, 80], 0).inside).toBe(0);   // top-left corner block, outside the ellipse
      expect(changed(before, after, [120, 104, 136, 120], 0).inside).toBeGreaterThan(200); // centre
      expect(changed(before, after, [64, 64, 192, 160]).outside).toBe(0);
    });

    it('accepts progressive input and writes baseline', async () => {
      const { before, after, bytes } = await roundTrip(GRAD_PROG_JPG, { regions: [{ x: 16, y: 16, w: 16, h: 16 }], strength: 8 });
      expect(sofMarker(b64ToBytes(GRAD_PROG_JPG))).toBe(0xc2);
      expect(sofMarker(bytes)).toBe(0xc0);
      expect(changed(before, after, [16, 16, 32, 32]).outside).toBe(0);
    });

    it('censors a 12 MP JPEG at full output resolution', async () => {
      const image_b64 = await stripedJpeg(4000, 3000);
      const result = await callTool('censor_image', {
        image_b64, regions: [{ x: 0, y: 0, w: 2000, h: 3000 }], strength: 32,
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[1].text).toMatch(/^Censored 1 region\(s\) on a 4000x3000 JPEG in place at full resolution/);
      const { raster } = await decodeImage({ image_b64: result.content[0].data });
      expect([raster.width, raster.height]).toEqual([2000, 1500]); // decodeImage itself still works at 1/2
      expect(rowContrast(raster, 750, 0, 950)).toBeLessThan(40);
      expect(rowContrast(raster, 750, 1050, 2000)).toBeGreaterThan(100);
    }, 30_000);

    it('rejects arithmetic-coded input with a readable error', async () => {
      const bytes = b64ToBytes(GRAD420_JPG);
      let p = 2;
      while (bytes[p + 1] !== 0xc0) p += 2 + ((bytes[p + 2] << 8) | bytes[p + 3]);
      bytes[p + 1] = 0xc9; // SOF9: arithmetic sequential
      const result = await callTool('censor_image', { image_b64: bytes.toBase64(), regions: [{ x: 0, y: 0, w: 16, h: 16 }] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/arithmetic-coded JPEG is not supported/);
    });

    it('maps regions through EXIF orientation like the pixel path and keeps the flag', async () => {
      // The red square shows at x 40..59, y 70..89 in the 64x96 the caller sees.
      const info = await callTool('get_image_info', { image_b64: EXIF6_MARK_JPG });
      expect(info.structuredContent).toEqual({ width: 64, height: 96, format: 'JPEG' });
      const region = { x: 40, y: 70, w: 20, h: 20 };
      const { before, after, bytes } = await roundTrip(EXIF6_MARK_JPG, { regions: [region], strength: 64 });
      expect([after.width, after.height]).toEqual([64, 96]);
      expect(readExifOrientation(bytes)).toBe(6);
      const out = await callTool('get_image_info', { image_b64: bytes.toBase64() });
      expect(out.structuredContent).toEqual({ width: 64, height: 96, format: 'JPEG' });
      // The pure-red square is replaced by its cell's average in the DCT
      // output (green rises from ~0)...
      expect(pixel(before, 50, 80)[1]).toBeLessThan(20);
      expect(pixel(after, 50, 80)[1]).toBeGreaterThan(80);
      // ...the same average the pixel path produces: both outputs agree within
      // JPEG noise over the requested rect, and nothing changed far from it.
      const { raster: ref } = await decodeImage({ image_b64: EXIF6_MARK_JPG });
      censor(ref, [{ ...region, effect: 'mosaic', strength: 64 }]);
      let maxDiff = 0;
      for (let y = 70; y < 90; y++) for (let x = 40; x < 60; x++) {
        const a = pixel(after, x, y), b = pixel(ref, x, y);
        maxDiff = Math.max(maxDiff, Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
      }
      // (The pixel path's cell colour is a triangle-weighted mean, the DCT
      // path's a plain mean; a saturated red square near the cell centre is
      // where they differ most.)
      expect(maxDiff).toBeLessThan(48);
      // Placement: everything that changed lies within one 16 px MCU of the
      // requested rect, in the caller's frame.
      const bbox = [64, 96, 0, 0];
      for (let y = 0; y < 96; y++) for (let x = 0; x < 64; x++) {
        if (pixel(before, x, y).some((v, i) => v !== pixel(after, x, y)[i])) {
          bbox[0] = Math.min(bbox[0], x); bbox[1] = Math.min(bbox[1], y); bbox[2] = Math.max(bbox[2], x + 1); bbox[3] = Math.max(bbox[3], y + 1);
        }
      }
      expect(bbox[0]).toBeLessThanOrEqual(40); expect(bbox[0]).toBeGreaterThanOrEqual(40 - 17);
      expect(bbox[1]).toBeLessThanOrEqual(70); expect(bbox[1]).toBeGreaterThanOrEqual(70 - 17);
      expect(bbox[2]).toBeGreaterThanOrEqual(60); expect(bbox[2]).toBeLessThanOrEqual(60 + 17);
      expect(bbox[3]).toBeGreaterThanOrEqual(90); expect(bbox[3]).toBeLessThanOrEqual(90 + 17);
    });

    it('toStoredBox inverts applyExifOrientation for all eight orientations', () => {
      const w = 5, h = 3;
      for (let o = 1; o <= 8; o++) {
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const src = new Raster(w, h);
            src.data[(y * w + x) * 4] = 255;
            const shown = applyExifOrientation(src, o);
            let nx = -1, ny = -1;
            for (let i = 0; i < shown.width * shown.height; i++) if (shown.data[i * 4] === 255) { nx = i % shown.width; ny = Math.floor(i / shown.width); }
            expect(toStoredBox(o, w, h, [nx, ny, nx + 1, ny + 1])).toEqual([x, y, x + 1, y + 1]);
          }
        }
      }
    });

    it('routes JPEGs above the coefficient budget to the pixel path', () => {
      const c420 = [{ h: 2, v: 2 }, { h: 1, v: 1 }, { h: 1, v: 1 }];
      const c444 = [{ h: 1, v: 1 }, { h: 1, v: 1 }, { h: 1, v: 1 }];
      expect(jpegFitsDctPath({ width: 6000, height: 4000, components: c420 })).toBe(true);   // 24 MP, 72 MB
      expect(jpegFitsDctPath({ width: 7000, height: 4000, components: c420 })).toBe(false);  // 28 MP, 84 MB
      expect(jpegFitsDctPath({ width: 4000, height: 3000, components: c444 })).toBe(true);   // 12 MP, 72 MB
      expect(jpegFitsDctPath({ width: 4600, height: 3450, components: c444 })).toBe(false);  // 16 MP, 95 MB
      expect(headerDimensions(b64ToBytes(GRAD420_JPG), 'JPEG').components).toEqual(c420);
      expect(headerDimensions(b64ToBytes(GRAD444_JPG), 'JPEG').components).toEqual(c444);
    });
  });

  it('works over the 2026-07-28 envelope too', async () => {
    const result = await callTool('censor_image', {
      image_b64: TINY_PNG,
      regions: [{ x: 0, y: 0, w: 8, h: 8 }],
    }, modern);
    expect(result.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
  });

  describe('rejects bad input as a tool error', () => {
    const cases = [
      ['no image', { regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'pass one of image_b64 or image_url'],
      ['both images', { image_b64: TINY_PNG, image_url: `data:image/png;base64,${TINY_PNG}`, regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'not both'],
      ['bad base64', { image_b64: '@@@@', regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'not valid base64'],
      ['not an image', { image_b64: btoa('hello world, not a picture'), regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'could not decode image'],
      ['truncated JPEG', { image_b64: btoa(atob(TINY_JPG).slice(0, 200)), regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'could not decode image'],
      ['malformed data URL', { image_url: 'data:image/png,abc', regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'malformed data URL'],
      ['unknown effect', { image_b64: TINY_PNG, regions: [{ x: 0, y: 0, w: 1, h: 1 }], effect: 'swirl' }, 'Input validation error'],
      ['mosaic strength too high', { image_b64: TINY_PNG, regions: [{ x: 0, y: 0, w: 1, h: 1 }], strength: 65 }, 'mosaic strength must be 1..64'],
      ['blur strength too low', { image_b64: TINY_PNG, regions: [{ x: 0, y: 0, w: 1, h: 1 }], effect: 'blur', strength: 1 }, 'blur strength must be 2..80'],
      ['empty regions', { image_b64: TINY_PNG, regions: [] }, 'at least one region'],
      ['region outside', { image_b64: TINY_PNG, regions: [{ x: 100, y: 100, w: 5, h: 5 }] }, 'lies outside the 32x24 image'],
      ['negative size', { image_b64: TINY_PNG, regions: [{ x: 0, y: 0, w: -5, h: 5 }] }, 'must be positive'],
      ['missing coords', { image_b64: TINY_PNG, regions: [{ x: 0, y: 0 }] }, 'Input validation error'],
      ['bad shape', { image_b64: TINY_PNG, regions: [{ x: 0, y: 0, w: 1, h: 1, shape: 'star' }] }, 'Input validation error'],
      ['too many regions', { image_b64: TINY_PNG, regions: Array.from({ length: 65 }, () => ({ x: 0, y: 0, w: 1, h: 1 })) }, 'too many regions'],
      ['bad output_format', { image_b64: TINY_PNG, regions: [{ x: 0, y: 0, w: 1, h: 1 }], output_format: 'gif' }, 'Input validation error'],
      ['header-declared bomb', { image_b64: BOMB_HEADER_PNG, regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'image dimensions exceed 8192px'],
      ['PNG over the pixel budget (rejected from the header, never decoded)', { image_b64: pngDeclaring(2100, 2000), regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'PNG is 2100x2000, above the 4 megapixel limit. PNG is not downscaled here: downscale it first'],
      ['image over the byte cap', { image_b64: 'A'.repeat(13_400_000), regions: [{ x: 0, y: 0, w: 1, h: 1 }] }, 'image is too large (10 MB limit)'],
    ];
    for (const [label, args, message] of cases) {
      it(label, async () => {
        const result = await callTool('censor_image', args);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(message);
      });
    }
  });

  it('reports an unknown tool as a JSON-RPC error', async () => {
    const r = await rpc('tools/call', { name: 'nope', arguments: {} });
    expect(r.json.error ?? r.json.result?.isError).toBeTruthy();
  });
});

// --- admission ----------------------------------------------------------------

function streamOf(chunks) {
  return new ReadableStream({
    pull(controller) {
      if (chunks.length === 0) controller.close();
      else controller.enqueue(chunks.shift());
    },
  });
}

describe('admission', () => {
  it('rejects a declared body over the cap with 413 before reading it', async () => {
    const req = request('/mcp', {
      method: 'POST',
      headers: { ...LEGACY_HEADERS, 'content-length': String(MAX_MCP_BODY + 1) },
      body: new ReadableStream({ pull() { return new Promise(() => {}); } }),
    });
    const res = await worker.fetch(req, env);
    expect(res.status).toBe(413);
    expect(req.bodyUsed).toBe(false);
  });

  it('rejects a streamed body that grows past the cap with 413', async () => {
    const chunk = new Uint8Array(1_000_000).fill(0x20);
    const res = await worker.fetch(request('/mcp', {
      method: 'POST',
      headers: LEGACY_HEADERS,
      body: streamOf(Array.from({ length: 42 }, () => chunk)),
    }), env);
    expect(res.status).toBe(413);
  });

  it('rejects a declared length that does not match the body', async () => {
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    const res = await worker.fetch(request('/mcp', {
      method: 'POST',
      headers: { ...LEGACY_HEADERS, 'content-length': String(body.length + 1) },
      body: streamOf([new TextEncoder().encode(body)]),
    }), env);
    expect(res.status).toBe(413);
  });

  it('rejects too much non-image JSON (a regions bomb) with 413 before parsing', async () => {
    const body = '[' + '0,'.repeat(MAX_JSON_NON_IMAGE / 2 + 1) + '0]';
    const res = await worker.fetch(request('/mcp', { method: 'POST', headers: LEGACY_HEADERS, body }), env);
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ error: 'request rejected: invalid length or too much non-image JSON' });
  });

  it('lets a large image string through the structural cap', async () => {
    // A single 2 MB string is "the image"; only the rest is counted.
    const big = 'A'.repeat(2_000_000);
    const r = await rpc('tools/call', { name: 'censor_image', arguments: { image_b64: big, regions: [{ x: 0, y: 0, w: 1, h: 1 }] } });
    expect(r.status).toBe(200);
    expect(r.json.result.isError).toBe(true); // not a real image, but it got to the tool
  });

  it('times out a stalled upload with 408 and frees the in-flight slot', async () => {
    const stalled = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
      pull() { return new Promise(() => {}); },
    });
    const res = await handleMcp(request('/mcp', { method: 'POST', headers: LEGACY_HEADERS, body: stalled }), { bodyReadTimeoutMs: 50 });
    expect(res.status).toBe(408);
    const next = await rpc('ping');
    expect(next.status).toBe(200);
  });

  it('answers 503 when the in-flight cap is reached, then recovers', async () => {
    const holds = [];
    const inflight = Array.from({ length: MAX_INFLIGHT }, () => {
      let release;
      const body = new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0","id":1,"method":"ping"}')); },
        pull() { return new Promise((resolve) => { release = () => { resolve(); }; }); },
      });
      const p = handleMcp(request('/mcp', { method: 'POST', headers: LEGACY_HEADERS, body }));
      holds.push(() => release());
      return p;
    });
    await new Promise((r) => setTimeout(r, 20));
    const res = await rpc('ping');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('5');
    // Releasing lets the pull resolve, but the stream never closes; cancel by
    // resetting state as an isolate restart would.
    holds.forEach((h) => h());
    resetAdmissionState();
    expect((await rpc('ping')).status).toBe(200);
    void inflight;
  });

  it('rate limits per IP with retry-after', async () => {
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    for (let i = 0; i < RATE_PER_MINUTE; i++) {
      expect((await rpc('ping', {}, { headers })).status).toBe(200);
    }
    const limited = await rpc('ping', {}, { headers });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another address is unaffected.
    expect((await rpc('ping', {}, { headers: { 'cf-connecting-ip': '203.0.113.10' } })).status).toBe(200);
  });
});

// --- auth posture -------------------------------------------------------------

describe('identity', () => {
  it('serves anonymous callers (no x-lost-plus-* headers)', async () => {
    expect((await rpc('tools/list')).status).toBe(200);
  });

  it('serves callers the gateway identified, identically', async () => {
    const r = await rpc('tools/list', {}, { headers: IDENTITY });
    expect(r.status).toBe(200);
    expect(r.json.result.tools).toHaveLength(2);
  });

  it('ignores a bearer token: it neither validates nor refuses it', async () => {
    const r = await rpc('tools/list', {}, { headers: { authorization: 'Bearer lp_bogus' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('www-authenticate')).toBeNull();
  });

  it('sets no CORS headers on /mcp (the gateway owns them)', async () => {
    const r = await rpc('tools/list');
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});

// --- non-MCP routes -----------------------------------------------------------

describe('static and discovery routes', () => {
  it('serves /healthz', async () => {
    const res = await worker.fetch(request('/healthz'), env);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('serves the server card with public CORS', async () => {
    const res = await worker.fetch(request('/.well-known/mcp/server-card.json'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const card = await res.json();
    expect(card.remotes).toEqual([{ type: 'streamable-http', url: 'https://censor.lost.plus/mcp' }]);
    expect(card.name).toBe('plus.lost.censor/censor');
  });

  it('serves the app from the asset store with the discovery Link header', async () => {
    const res = await worker.fetch(request('/'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('link')).toContain('rel="mcp-server-card"');
  });

  it('serves the agent skill from the asset store', async () => {
    const res = await worker.fetch(request('/skills/censor-image/SKILL.md'), env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('censor_image');
  });
});
