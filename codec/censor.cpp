// censor's DCT-domain JPEG entry point. Takes JPEG bytes and a list of
// regions and returns JPEG bytes at the original resolution, having
// re-encoded ONLY the 8x8 blocks that the regions touch. Everything else is
// transcoded verbatim (jpeg_read_coefficients -> jpeg_write_coefficients, the
// path jpegtran uses), so pixels outside the regions are bit-exact and the
// full raster never exists: memory is the coefficient arrays (2 bytes per
// sample) instead of 4 bytes per pixel of RGBA, and CPU is proportional to
// the region area, not the image area.
//
// Per region and per colour component: the region (given in luma pixels, in
// the JPEG's stored orientation; the JS side undoes EXIF rotation) snaps
// outward to the MCU grid (8 px for 4:4:4 and greyscale, 16 px for 4:2:0),
// a ring of context blocks around it is read as well, all of those blocks
// are dequantized and inverse-DCT'd into a float patch, the effect runs on
// the patch in that component's own plane and resolution, and the blocks
// inside the snapped region are forward-DCT'd, quantized with the
// component's own table and written back. Mosaic cells and blur radii are
// specified in luma pixels and scaled by the component's sampling factor.
//
// Output is baseline Huffman with the source's quantization tables, no
// Huffman optimisation. Progressive input is fine (the coefficient reader
// buffers it); arithmetic-coded and non-8-bit input are refused with a
// readable error. Markers: only APP2 (ICC profile) is carried over, plus a
// minimal EXIF holding just the orientation so viewers still rotate the
// result; GPS, camera and XMP metadata are dropped as the pixel path does.

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <emscripten.h>  // emscripten_get_now
#include <math.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <string>
#include <vector>

extern "C" {
#include "jpeglib.h"
}

using namespace emscripten;

struct censor_error_mgr {
  struct jpeg_error_mgr pub;
  jmp_buf setjmp_buffer;
  char message[JMSG_LENGTH_MAX];
};

static void censor_error_exit(j_common_ptr cinfo) {
  censor_error_mgr* err = reinterpret_cast<censor_error_mgr*>(cinfo->err);
  (*cinfo->err->format_message)(cinfo, err->message);
  longjmp(err->setjmp_buffer, 1);
}

static void censor_output_message(j_common_ptr) {}

// --- 8x8 float DCT ---------------------------------------------------------
// Separable matrix form: X = C f C^T, f = C^T X C, with C[u][x] =
// c(u)/2 * cos((2x+1) u pi / 16). Plain and obviously correct. Every stage
// is written with the contiguous 8-wide axis as the innermost loop so that
// -O3 -msimd128 turns it into two f32x4 multiply-adds per step; ~1k
// multiplies per transform.

static float DCT_C[8][8];   // C[u][x]
static float DCT_CT[8][8];  // C[x][u], the transpose
static bool dct_ready = false;

static void dct_init() {
  if (dct_ready) return;
  for (int u = 0; u < 8; u++) {
    const double cu = u == 0 ? sqrt(0.5) : 1.0;
    for (int x = 0; x < 8; x++) {
      DCT_C[u][x] = static_cast<float>(cu / 2.0 * cos((2 * x + 1) * u * M_PI / 16.0));
      DCT_CT[x][u] = DCT_C[u][x];
    }
  }
  dct_ready = true;
}

// Dequantized coefficients (natural order) -> 64 samples in [0, 255],
// written into `out` with row stride `stride`.
static void idct8x8(const JCOEF* blk, const UINT16* q, float* out, int stride) {
  float tmp[8][8];  // tmp[v][x] = sum_u C[u][x] F[v][u]
  for (int v = 0; v < 8; v++) {
    for (int x = 0; x < 8; x++) tmp[v][x] = 0;
    for (int u = 0; u < 8; u++) {
      const float f = static_cast<float>(blk[v * 8 + u] * q[v * 8 + u]);
      if (f == 0) continue;
      for (int x = 0; x < 8; x++) tmp[v][x] += f * DCT_C[u][x];
    }
  }
  for (int y = 0; y < 8; y++) {  // out[y][x] = sum_v C[v][y] tmp[v][x]
    float row[8] = { 128, 128, 128, 128, 128, 128, 128, 128 };
    for (int v = 0; v < 8; v++) {
      const float c = DCT_C[v][y];
      for (int x = 0; x < 8; x++) row[x] += c * tmp[v][x];
    }
    for (int x = 0; x < 8; x++) out[y * stride + x] = row[x] < 0 ? 0 : (row[x] > 255 ? 255 : row[x]);
  }
}

// 64 samples -> quantized coefficients, clamped to what a baseline Huffman
// encoder accepts (10 bits of magnitude for 8-bit data).
static void fdct8x8(const float* in, int stride, const UINT16* q, JCOEF* blk) {
  float tmp[8][8];  // tmp[v][x] = sum_y C[v][y] (f[y][x] - 128)
  for (int v = 0; v < 8; v++) {
    for (int x = 0; x < 8; x++) tmp[v][x] = 0;
    for (int y = 0; y < 8; y++) {
      const float c = DCT_C[v][y];
      const float* r = in + y * stride;
      for (int x = 0; x < 8; x++) tmp[v][x] += c * (r[x] - 128.0f);
    }
  }
  for (int v = 0; v < 8; v++) {  // F[v][u] = sum_x C[u][x] tmp[v][x]
    float row[8] = { 0, 0, 0, 0, 0, 0, 0, 0 };
    for (int x = 0; x < 8; x++) {
      const float t = tmp[v][x];
      for (int u = 0; u < 8; u++) row[u] += t * DCT_CT[x][u];
    }
    for (int u = 0; u < 8; u++) {
      long c = lroundf(row[u] / q[v * 8 + u]);
      if (c > 1023) c = 1023;
      if (c < -1023) c = -1023;
      blk[v * 8 + u] = static_cast<JCOEF>(c);
    }
  }
}

// --- effects on a float plane ---------------------------------------------

struct Region {
  double x0, y0, x1, y1;  // luma pixels, stored orientation, half-open box
  int shape;              // 0 rect, 1 ellipse
  int effect;             // 0 mosaic, 1 blur
  int strength;
  double ax, ay;          // mosaic grid anchor, luma pixels
};

// Same three-box Gaussian approximation as worker/lib/resize.js.
static void boxes_for_gauss(double sigma, int n, int* sizes) {
  const double w_ideal = sqrt((12 * sigma * sigma / n) + 1);
  int wl = static_cast<int>(floor(w_ideal));
  if (wl % 2 == 0) wl--;
  const int wu = wl + 2;
  const double m_ideal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const int m = static_cast<int>(lround(m_ideal));
  for (int i = 0; i < n; i++) sizes[i] = i < m ? wl : wu;
}

// One horizontal box pass over a row: sliding-window sum, clamped edges.
static void box_row(float* p, int len, int r, float* line) {
  memcpy(line, p, sizeof(float) * len);
  const float inv = 1.0f / (2 * r + 1);
  float acc = 0;
  for (int k = -r; k <= r; k++) acc += line[k < 0 ? 0 : (k >= len ? len - 1 : k)];
  for (int i = 0; i < len; i++) {
    p[i] = acc * inv;
    const int out = i - r, in = i + r + 1;
    acc += line[in >= len ? len - 1 : in] - line[out < 0 ? 0 : out];
  }
}

// One vertical box pass over the w x h window: a running column-sum array
// walks down the rows, so memory is touched sequentially. `copy` holds the
// unblurred window (w*h floats), `acc` w floats.
static void box_cols(float* p, int w, int h, int stride, int r, float* copy, float* acc) {
  for (int y = 0; y < h; y++) memcpy(copy + static_cast<size_t>(y) * w, p + static_cast<size_t>(y) * stride, sizeof(float) * w);
  auto row = [&](int y) { return copy + static_cast<size_t>(y < 0 ? 0 : (y >= h ? h - 1 : y)) * w; };
  const float inv = 1.0f / (2 * r + 1);
  for (int x = 0; x < w; x++) acc[x] = 0;
  for (int k = -r; k <= r; k++) { const float* s = row(k); for (int x = 0; x < w; x++) acc[x] += s[x]; }
  for (int y = 0; y < h; y++) {
    float* d = p + static_cast<size_t>(y) * stride;
    for (int x = 0; x < w; x++) d[x] = acc[x] * inv;
    const float* in = row(y + r + 1);
    const float* out = row(y - r);
    for (int x = 0; x < w; x++) acc[x] += in[x] - out[x];
  }
}

// In-place blur of the w x h window at `p` (stride `stride`) with per-axis
// sigmas (three box passes each, as resize.js does).
static void blur_plane(float* p, int w, int h, int stride, double sx, double sy) {
  int bx[3], by[3];
  boxes_for_gauss(sx, 3, bx);
  boxes_for_gauss(sy, 3, by);
  std::vector<float> line(w), copy(static_cast<size_t>(w) * h), acc(w);
  for (int pass = 0; pass < 3; pass++) {
    const int rx = (bx[pass] - 1) / 2, ry = (by[pass] - 1) / 2;
    if (rx >= 1) for (int y = 0; y < h; y++) box_row(p + static_cast<size_t>(y) * stride, w, rx, line.data());
    if (ry >= 1) box_cols(p, w, h, stride, ry, copy.data(), acc.data());
  }
}

struct Plane {
  jpeg_component_info* comp;
  jvirt_barray_ptr coefs;
  int hs, vs, hmax, vmax;  // sampling factors; component pixel = luma * hs/hmax
  int cw, ch;              // real (unpadded) component pixel extent
  int wb, hb;              // blocks stored
};

// Patch buffers are bounded: a region is processed in horizontal bands of
// MCU rows sized so one float plane of the band plus its context ring stays
// under this many samples (8 MB). Each band re-reads its own ring, so the
// results equal a single whole-region pass (every mosaic cell or blur
// support that touches a written block lies inside the band's patch).
static const size_t BAND_BUDGET_SAMPLES = 2u << 20;

struct Snap {
  long mx0, mx1;          // written MCU columns
  long rx0, rx1;          // read MCU columns (written + ring)
  long pad_x, pad_y;      // ring, MCUs
  long mcus_x, mcus_y;
};

static void censor_band(j_decompress_ptr src, const Plane& P, const Region& R, const Snap& S,
                        long my0, long my1) {
  const double fx = static_cast<double>(P.hs) / P.hmax, fy = static_cast<double>(P.vs) / P.vmax;
  const long ry0 = my0 - S.pad_y < 0 ? 0 : my0 - S.pad_y;
  const long ry1 = my1 + S.pad_y > S.mcus_y ? S.mcus_y : my1 + S.pad_y;

  // Block ranges in this component (clipped to what is stored).
  auto bl = [&](long m, int s, int lim) { long b = m * s; return static_cast<int>(b > lim ? lim : b); };
  const int rbx0 = bl(S.rx0, P.hs, P.wb), rbx1 = bl(S.rx1, P.hs, P.wb);
  const int rby0 = bl(ry0, P.vs, P.hb), rby1 = bl(ry1, P.vs, P.hb);
  const int wbx0 = bl(S.mx0, P.hs, P.wb), wbx1 = bl(S.mx1, P.hs, P.wb);
  const int wby0 = bl(my0, P.vs, P.hb), wby1 = bl(my1, P.vs, P.hb);
  if (wbx1 <= wbx0 || wby1 <= wby0) return;

  const int pw = (rbx1 - rbx0) * 8, ph = (rby1 - rby0) * 8;  // patch, component px
  const int ox = rbx0 * 8, oy = rby0 * 8;                     // patch origin, component px
  const UINT16* q = P.comp->quant_table->quantval;
  std::vector<float> patch(static_cast<size_t>(pw) * ph);

  for (int by = rby0; by < rby1; by++) {
    JBLOCKARRAY rows = (*src->mem->access_virt_barray)((j_common_ptr)src, P.coefs, by, 1, FALSE);
    for (int bx = rbx0; bx < rbx1; bx++) {
      idct8x8(rows[0][bx], q, &patch[static_cast<size_t>(by - rby0) * 8 * pw + (bx - rbx0) * 8], pw);
    }
  }

  // Real-image extent inside the patch (the last block row/column carries
  // encoder padding that must not feed averages or blur).
  const int realw = (P.cw - ox) < pw ? (P.cw - ox) : pw;
  const int realh = (P.ch - oy) < ph ? (P.ch - oy) : ph;
  // Written box inside the patch.
  const int wx0 = (wbx0 - rbx0) * 8, wx1 = (wbx1 - rbx0) * 8;
  const int wy0 = (wby0 - rby0) * 8, wy1 = (wby1 - rby0) * 8;
  const int ww = wx1 - wx0;

  // Per-pixel coverage of the written box: 1 everywhere for a rect (it
  // snapped outward already); the analytic soft-edged ellipse otherwise.
  std::vector<float> mask;
  if (R.shape == 1) {
    mask.assign(static_cast<size_t>(ww) * (wy1 - wy0), 0.0f);
    const double cx = (R.x0 + R.x1) / 2 * fx - ox, cy = (R.y0 + R.y1) / 2 * fy - oy;
    const double rx = (R.x1 - R.x0) / 2 * fx, ry = (R.y1 - R.y0) / 2 * fy;
    if (rx <= 0 || ry <= 0) return;
    const double rmin = rx < ry ? rx : ry;
    for (int y = wy0; y < wy1; y++) {
      for (int x = wx0; x < wx1; x++) {
        const double dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
        const double d = dx * dx + dy * dy;
        if (d > 1) continue;
        const double edge = (sqrt(d) - 1) * rmin;
        double m = edge < -0.75 ? 1.0 : 0.25 - edge;
        mask[static_cast<size_t>(y - wy0) * ww + (x - wx0)] = static_cast<float>(m < 0 ? 0 : (m > 1 ? 1 : m));
      }
    }
  }
  auto cover = [&](int x, int y) { return mask.empty() ? 1.0f : mask[static_cast<size_t>(y - wy0) * ww + (x - wx0)]; };

  if (R.effect == 0) {
    // Mosaic: each pixel takes the plain average of the cell that contains
    // its centre, cells being `strength` luma pixels on the grid anchored at
    // (ax, ay). Averages are gathered over the whole patch (minus padding),
    // then written in place.
    const double cell = R.strength;
    auto kx_of = [&](int x) { return static_cast<long>(floor(((ox + x + 0.5) / fx - R.ax) / cell)); };
    auto ky_of = [&](int y) { return static_cast<long>(floor(((oy + y + 0.5) / fy - R.ay) / cell)); };
    const long kx0 = kx_of(0), ky0 = ky_of(0);
    const int nkx = static_cast<int>(kx_of(pw - 1) - kx0 + 1), nky = static_cast<int>(ky_of(ph - 1) - ky0 + 1);
    std::vector<double> sum(static_cast<size_t>(nkx) * nky, 0.0);
    std::vector<int> cnt(static_cast<size_t>(nkx) * nky, 0);
    std::vector<int> kxs(pw), kys(ph);
    for (int x = 0; x < pw; x++) kxs[x] = static_cast<int>(kx_of(x) - kx0);
    for (int y = 0; y < ph; y++) kys[y] = static_cast<int>(ky_of(y) - ky0);
    for (int y = 0; y < realh; y++) {
      const float* row = &patch[static_cast<size_t>(y) * pw];
      const int kyo = kys[y] * nkx;
      for (int x = 0; x < realw; x++) { sum[kyo + kxs[x]] += row[x]; cnt[kyo + kxs[x]]++; }
    }
    for (int y = wy0; y < wy1; y++) {
      float* row = &patch[static_cast<size_t>(y) * pw];
      const int kyo = kys[y] * nkx;
      for (int x = wx0; x < wx1; x++) {
        const int k = kyo + kxs[x];
        if (!cnt[k]) continue;
        const float m = cover(x, y);
        if (m == 0) continue;
        row[x] = static_cast<float>(sum[k] / cnt[k]) * m + row[x] * (1 - m);
      }
    }
  } else {
    // Blur: three-box Gaussian over the real-image part of the patch, sigma
    // scaled to this component's resolution per axis. An ellipse keeps a
    // copy of the written box to blend the original back in.
    std::vector<float> keep;
    if (!mask.empty()) {
      keep.resize(static_cast<size_t>(ww) * (wy1 - wy0));
      for (int y = wy0; y < wy1; y++) memcpy(&keep[static_cast<size_t>(y - wy0) * ww], &patch[static_cast<size_t>(y) * pw + wx0], sizeof(float) * ww);
    }
    blur_plane(patch.data(), realw, realh, pw, R.strength * fx, R.strength * fy);
    if (!mask.empty()) {
      for (int y = wy0; y < wy1; y++) {
        for (int x = wx0; x < wx1; x++) {
          const float m = cover(x, y);
          const size_t i = static_cast<size_t>(y) * pw + x;
          patch[i] = patch[i] * m + keep[static_cast<size_t>(y - wy0) * ww + (x - wx0)] * (1 - m);
        }
      }
    }
  }

  for (int by = wby0; by < wby1; by++) {
    JBLOCKARRAY rows = (*src->mem->access_virt_barray)((j_common_ptr)src, P.coefs, by, 1, TRUE);
    for (int bx = wbx0; bx < wbx1; bx++) {
      if (!mask.empty()) {  // skip blocks the ellipse does not reach at all
        bool any = false;
        const int bx0 = (bx - rbx0) * 8, by0 = (by - rby0) * 8;
        for (int y = by0; y < by0 + 8 && !any; y++) for (int x = bx0; x < bx0 + 8; x++) if (cover(x, y) != 0) { any = true; break; }
        if (!any) continue;
      }
      fdct8x8(&patch[static_cast<size_t>(by - rby0) * 8 * pw + (bx - rbx0) * 8], pw, q, rows[0][bx]);
    }
  }
}

static void censor_region(j_decompress_ptr src, const Plane& P, const Region& R) {
  const int mw = 8 * P.hmax, mh = 8 * P.vmax;  // MCU in luma pixels
  // Pixel path masks [floor(x0), ceil(x1)); snap that outward to the MCU grid.
  const long px0 = static_cast<long>(floor(R.x0)), py0 = static_cast<long>(floor(R.y0));
  const long px1 = static_cast<long>(ceil(R.x1)), py1 = static_cast<long>(ceil(R.y1));
  Snap S;
  S.mcus_x = (src->image_width + mw - 1) / mw;
  S.mcus_y = (src->image_height + mh - 1) / mh;
  S.mx0 = px0 < 0 ? 0 : px0 / mw;
  S.mx1 = (px1 + mw - 1) / mw;
  long my0 = py0 < 0 ? 0 : py0 / mh, my1 = (py1 + mh - 1) / mh;
  if (S.mx1 > S.mcus_x) S.mx1 = S.mcus_x;
  if (my1 > S.mcus_y) my1 = S.mcus_y;
  if (S.mx1 <= S.mx0 || my1 <= my0) return;
  // Context ring: one full mosaic cell (a cell touching the written blocks
  // then lies entirely inside the patch) or the blur's whole support.
  const long pad_px = R.effect == 0 ? R.strength : 4L * R.strength + 16;
  S.pad_x = (pad_px + mw - 1) / mw;
  S.pad_y = (pad_px + mh - 1) / mh;
  S.rx0 = S.mx0 - S.pad_x < 0 ? 0 : S.mx0 - S.pad_x;
  S.rx1 = S.mx1 + S.pad_x > S.mcus_x ? S.mcus_x : S.mx1 + S.pad_x;

  // Band height from the buffer budget: block rows of this component that
  // fit, minus the ring on both sides, at least one MCU row.
  const long pw = (S.rx1 - S.rx0) * P.hs * 8;
  long band = static_cast<long>(BAND_BUDGET_SAMPLES / (pw * 8)) / P.vs - 2 * S.pad_y;
  if (band < 1) band = 1;
  for (long b0 = my0; b0 < my1; b0 += band) {
    const long b1 = b0 + band < my1 ? b0 + band : my1;
    censor_band(src, P, R, S, b0, b1);
  }
}

// --- entry point -------------------------------------------------------------

static val fail(const char* message) {
  val r = val::object();
  r.set("error", std::string(message));
  return r;
}

// A minimal EXIF APP1: one IFD0 entry, Orientation = `orientation`.
static void write_orientation_marker(j_compress_ptr dst, int orientation) {
  const uint8_t buf[32] = {
    'E', 'x', 'i', 'f', 0, 0,
    'M', 'M', 0, 42, 0, 0, 0, 8,        // big-endian TIFF header, IFD0 at 8
    0, 1,                               // one entry
    0x01, 0x12, 0, 3, 0, 0, 0, 1,       // Orientation, SHORT, count 1
    0, static_cast<uint8_t>(orientation), 0, 0,
    0, 0, 0, 0,                         // no next IFD
  };
  jpeg_write_marker(dst, JPEG_APP0 + 1, buf, sizeof buf);
}

// regions: flat Float64Array, 9 numbers per region (see struct Region).
// orientation: EXIF value to stamp on the output (1 = none).
val censor(std::string image_in, val regions_js, int orientation) {
  dct_init();
  std::vector<double> flat = convertJSArrayToNumberVector<double>(regions_js);
  if (flat.size() % 9 != 0) return fail("bad region list");
  std::vector<Region> regions;
  for (size_t i = 0; i < flat.size(); i += 9) {
    regions.push_back({ flat[i], flat[i + 1], flat[i + 2], flat[i + 3],
                        static_cast<int>(flat[i + 4]), static_cast<int>(flat[i + 5]),
                        static_cast<int>(flat[i + 6]), flat[i + 7], flat[i + 8] });
  }

  jpeg_decompress_struct src;
  jpeg_compress_struct dst;
  censor_error_mgr jerr;
  unsigned char* out = nullptr;
  unsigned long out_size = 0;
  bool dst_created = false;

  src.err = jpeg_std_error(&jerr.pub);
  dst.err = src.err;
  jerr.pub.error_exit = censor_error_exit;
  jerr.pub.output_message = censor_output_message;
  if (setjmp(jerr.setjmp_buffer)) {
    if (dst_created) jpeg_destroy_compress(&dst);
    jpeg_destroy_decompress(&src);
    free(out);
    return fail(jerr.message);
  }

  const double t0 = emscripten_get_now();
  jpeg_create_decompress(&src);
  jpeg_mem_src(&src, reinterpret_cast<const unsigned char*>(image_in.data()), image_in.size());
  jpeg_save_markers(&src, JPEG_APP0 + 2, 0xFFFF);  // ICC profile
  jpeg_read_header(&src, TRUE);
  if (src.arith_code) {
    jpeg_destroy_decompress(&src);
    return fail("arithmetic-coded JPEG is not supported; re-save it with Huffman coding");
  }
  if (src.data_precision != 8) {
    jpeg_destroy_decompress(&src);
    return fail("only 8-bit JPEG is supported");
  }
  jvirt_barray_ptr* coefs = jpeg_read_coefficients(&src);
  const double t1 = emscripten_get_now();

  std::vector<Plane> planes;
  for (int ci = 0; ci < src.num_components; ci++) {
    jpeg_component_info* c = src.comp_info + ci;
    planes.push_back({ c, coefs[ci], c->h_samp_factor, c->v_samp_factor,
                       src.max_h_samp_factor, src.max_v_samp_factor,
                       static_cast<int>(c->downsampled_width), static_cast<int>(c->downsampled_height),
                       static_cast<int>(c->width_in_blocks), static_cast<int>(c->height_in_blocks) });
  }
  for (const Region& r : regions) for (const Plane& p : planes) censor_region(&src, p, r);
  const double t2 = emscripten_get_now();

  jpeg_create_compress(&dst);
  dst_created = true;
  // Pre-size the output so jpeg_mem_dest does not grow by doubling (each
  // step copies, briefly holding old and new buffers). A censored baseline
  // re-encode rarely exceeds the input; std Huffman tables after optimised
  // ones, or progressive -> baseline, can add a few percent.
  out_size = image_in.size() + image_in.size() / 8 + 65536;
  out = static_cast<unsigned char*>(malloc(out_size));
  if (!out) { jpeg_destroy_compress(&dst); jpeg_destroy_decompress(&src); return fail("out of memory"); }
  jpeg_mem_dest(&dst, &out, &out_size);
  jpeg_copy_critical_parameters(&src, &dst);
  dst.optimize_coding = FALSE;
  jpeg_write_coefficients(&dst, coefs);
  if (orientation > 1 && orientation <= 8) write_orientation_marker(&dst, orientation);
  for (jpeg_saved_marker_ptr m = src.marker_list; m != nullptr; m = m->next) {
    jpeg_write_marker(&dst, m->marker, m->data, m->data_length);
  }
  jpeg_finish_compress(&dst);
  jpeg_finish_decompress(&src);
  const double t3 = emscripten_get_now();

  jpeg_destroy_compress(&dst);
  jpeg_destroy_decompress(&src);

  val result = val::object();
  result.set("data", val::global("Uint8Array").new_(typed_memory_view(static_cast<size_t>(out_size), out)));
  free(out);
  result.set("readMs", t1 - t0);
  result.set("workMs", t2 - t1);
  result.set("writeMs", t3 - t2);
  return result;
}

EMSCRIPTEN_BINDINGS(censor_jpeg_censor) {
  function("censor", &censor);
}
