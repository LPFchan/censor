// censor's libjpeg-turbo encoder entry point. Takes an RGBA buffer and a
// quality, returns baseline JPEG bytes: no progressive, no Huffman-table
// optimization, no trellis (libjpeg-turbo has none). The tool re-encodes a
// photo once so the caller can forward it; mozjpeg-style size tuning cost
// seconds of CPU per megapixel in WASM and bought nothing here.

#include <emscripten/bind.h>
#include <emscripten/val.h>
#include <setjmp.h>
#include <stdint.h>
#include <stdlib.h>
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

val encode(std::string image_in, int width, int height, int quality) {
  if (width <= 0 || height <= 0 || image_in.size() != static_cast<size_t>(width) * height * 4) {
    return val::null();
  }

  jpeg_compress_struct cinfo;
  censor_error_mgr jerr;
  unsigned char* out = nullptr;
  unsigned long out_size = 0;

  cinfo.err = jpeg_std_error(&jerr.pub);
  jerr.pub.error_exit = censor_error_exit;
  jerr.pub.output_message = censor_output_message;
  if (setjmp(jerr.setjmp_buffer)) {
    jpeg_destroy_compress(&cinfo);
    free(out);
    return val::null();
  }

  jpeg_create_compress(&cinfo);
  jpeg_mem_dest(&cinfo, &out, &out_size);
  cinfo.image_width = width;
  cinfo.image_height = height;
  cinfo.input_components = 4;
  cinfo.in_color_space = JCS_EXT_RGBA;
  jpeg_set_defaults(&cinfo);
  jpeg_set_quality(&cinfo, quality, TRUE);
  cinfo.optimize_coding = FALSE;
  cinfo.dct_method = JDCT_ISLOW;

  jpeg_start_compress(&cinfo, TRUE);
  const size_t stride = static_cast<size_t>(width) * 4;
  const uint8_t* pixels = reinterpret_cast<const uint8_t*>(image_in.data());
  while (cinfo.next_scanline < cinfo.image_height) {
    JSAMPROW row = const_cast<JSAMPROW>(pixels + static_cast<size_t>(cinfo.next_scanline) * stride);
    jpeg_write_scanlines(&cinfo, &row, 1);
  }
  jpeg_finish_compress(&cinfo);
  jpeg_destroy_compress(&cinfo);

  val result = val::global("Uint8Array").new_(typed_memory_view(static_cast<size_t>(out_size), out));
  free(out);
  return result;
}

EMSCRIPTEN_BINDINGS(censor_jpeg_enc) {
  function("encode", &encode);
}
