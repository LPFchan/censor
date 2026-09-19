// censor's mozjpeg decoder entry point. Same shape as @jsquash/jpeg's
// (a std::string of JPEG bytes in, an ImageData-like {data, width, height}
// out) with one addition: a DCT scale denominator, so a 12 MP phone photo
// can be decoded straight to 1/2, 1/4 or 1/8 size without ever holding the
// full raster. libjpeg does the scaling inside the IDCT, so a baseline JPEG
// decodes in memory proportional to the OUTPUT size, not the input.
//
// Returns null on any decode error; the JS wrapper turns that into a
// caller-readable CensorError. EXIF orientation is left to the caller.

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <setjmp.h>
#include <stdint.h>
#include <string>

extern "C" {
#include "jpeglib.h"
}

using namespace emscripten;

struct censor_error_mgr {
  struct jpeg_error_mgr pub;
  jmp_buf setjmp_buffer;
};

static void censor_error_exit(j_common_ptr cinfo) {
  censor_error_mgr* err = reinterpret_cast<censor_error_mgr*>(cinfo->err);
  longjmp(err->setjmp_buffer, 1);
}

static void censor_output_message(j_common_ptr) {}

val decode(std::string image_in, int scale_denom) {
  if (scale_denom != 1 && scale_denom != 2 && scale_denom != 4 && scale_denom != 8) {
    return val::null();
  }

  jpeg_decompress_struct cinfo;
  censor_error_mgr jerr;
  uint8_t* pixels = nullptr;

  cinfo.err = jpeg_std_error(&jerr.pub);
  jerr.pub.error_exit = censor_error_exit;
  jerr.pub.output_message = censor_output_message;
  if (setjmp(jerr.setjmp_buffer)) {
    jpeg_destroy_decompress(&cinfo);
    free(pixels);
    return val::null();
  }

  jpeg_create_decompress(&cinfo);
  jpeg_mem_src(&cinfo, reinterpret_cast<const unsigned char*>(image_in.data()), image_in.size());
  jpeg_read_header(&cinfo, TRUE);

  cinfo.out_color_space = JCS_EXT_RGBA;
  cinfo.scale_num = 1;
  cinfo.scale_denom = scale_denom;
  jpeg_calc_output_dimensions(&cinfo);

  jpeg_start_decompress(&cinfo);
  const size_t width = cinfo.output_width;
  const size_t height = cinfo.output_height;
  const size_t stride = width * 4;
  pixels = static_cast<uint8_t*>(malloc(stride * height));
  if (!pixels) {
    jpeg_destroy_decompress(&cinfo);
    return val::null();
  }
  while (cinfo.output_scanline < cinfo.output_height) {
    JSAMPROW row = pixels + static_cast<size_t>(cinfo.output_scanline) * stride;
    jpeg_read_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_decompress(&cinfo);
  jpeg_destroy_decompress(&cinfo);

  // Copy out of WASM memory into a JS-owned array, then free the WASM side
  // so the linear memory can be reused by the next call.
  val data = val::global("Uint8ClampedArray").new_(typed_memory_view(stride * height, pixels));
  free(pixels);

  val result = val::object();
  result.set("data", data);
  result.set("width", static_cast<int>(width));
  result.set("height", static_cast<int>(height));
  return result;
}

EMSCRIPTEN_BINDINGS(censor_mozjpeg_dec) {
  function("decode", &decode);
}
