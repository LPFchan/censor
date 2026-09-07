"""Pure blur/mosaic censor effects, ported from censor's app.js.

No disk I/O anywhere in this module: images arrive and leave as bytes in
memory, which is what lets the server keep its "nothing is stored" promise.
"""

from __future__ import annotations

import base64
import binascii
import io
import math

from PIL import Image, ImageDraw, ImageFilter, ImageOps

# Decompression-bomb guard, sized from the container's 512 MiB limit with
# everything accounted: 4 persistent rasters (~192 MiB), a worst-case padded
# chunk's source + grid + output (~67 MiB), two admitted raw+parsed input
# bodies (~153 MiB), plus interpreter overhead. Pillow raises above this
# instead of just warning.
Image.MAX_IMAGE_PIXELS = 12_000_000

MAX_DIMENSION = 8192
MAX_PIXELS = 12_000_000
MAX_BASE64_CHARS = 40_000_000  # ~30 MB of image data once decoded
MAX_REGION_COORD = 100_000     # geometry beyond this is nonsense and only
                               # feeds Pillow's rasterizer pointless work

# Chunking threshold AND the cap on padded chunk dimensions. A chunk's write
# area never exceeds 64 rows; padding (max 336px per side) then bounds the
# processed crop at 8192 x 736, so source + grid + output stay under ~25 MiB
# no matter how large the region or image is. Full worst-case budget:
# 4 image rasters ~192 MiB + chunk ~25 MiB + 2 admitted inputs (raw body +
# base64 string + decoded bytes, ~230 MiB retained) + interpreter ~50 MiB
# ~= 500 MiB of heap. The container's memory ceiling is set above this with
# headroom for allocator overhead; the measured-peak test (2 concurrent
# max-size calls through the full server) must pass before any sizing
# change ships.
CHUNK_PIXELS = 512_000
CHUNK_MAX_ROWS = 64

BLUR_MIN, BLUR_MAX = 2, 80      # radius in px, same as the app's slider
MOSAIC_MIN, MOSAIC_MAX = 1, 64  # square cell side in px, same as the app's slider

# Effects bleed a few strength-lengths past their region, so process a padded
# crop rather than the full image. This keeps peak memory independent of how
# small the censored area is relative to the whole picture.
def _pad_for(effect: str, strength: int) -> int:
    # Mosaic needs a pad of at least one full cell beyond the anchor-margin
    # so cells straddling the crop edge still average complete source
    # pixels; 5 cells covers the worst alignment case with room to spare.
    if effect == "mosaic":
        return 5 * max(MOSAIC_MIN, round(strength)) + 16
    return 4 * strength + 16


class CensorError(ValueError):
    """Raised for any bad input; the message is safe to show the caller."""


def _parse_data_url(data: str) -> tuple[str, str]:
    header, sep, payload = data.partition(",")
    if not sep or not header.startswith("data:") or ";base64" not in header:
        raise CensorError("malformed data URL: expected data:<mime>;base64,<payload>")
    return header[5:].split(";")[0] or "application/octet-stream", payload


def decode_image(image_b64: str | None = None, image_url: str | None = None) -> tuple[Image.Image, str]:
    """Decode one image from raw base64 or a data URL. Exactly one is required."""
    if image_url:
        if image_b64:
            raise CensorError("pass either image_b64 or image_url, not both")
        _, payload = _parse_data_url(image_url.strip())
    elif image_b64:
        payload = image_b64.strip()
    else:
        raise CensorError("pass one of image_b64 or image_url")

    if len(payload) > MAX_BASE64_CHARS:
        raise CensorError("image is too large (30 MB decoded limit)")
    try:
        raw = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError):
        raise CensorError("image data is not valid base64") from None
    try:
        img = Image.open(io.BytesIO(raw))
    except Exception:
        raise CensorError("could not decode image (supported: PNG, JPEG, WebP, GIF, BMP, TIFF)") from None
    src_format = (img.format or "PNG").upper()  # exif_transpose clears .format
    # Reject oversized rasters before paying for the decode: headers are read
    # at open() time, so this check is cheap.
    if max(img.size) > MAX_DIMENSION:
        raise CensorError(f"image dimensions exceed {MAX_DIMENSION}px")
    if img.width * img.height > MAX_PIXELS:
        raise CensorError(f"image exceeds {MAX_PIXELS // 1_000_000} megapixels")
    try:
        img.load()
    except Image.DecompressionBombError:
        raise CensorError("image expands beyond the safe pixel limit") from None
    except Exception:
        raise CensorError("could not decode image (supported: PNG, JPEG, WebP, GIF, BMP, TIFF)") from None
    # Browsers draw phone photos rotated per EXIF orientation; Pillow does not.
    # Normalize so region coordinates address the pixels the caller sees.
    img = ImageOps.exif_transpose(img)
    return img, src_format


def encode_image(img: Image.Image, fmt: str) -> str:
    out = io.BytesIO()
    if fmt == "JPEG":
        img.convert("RGB").save(out, format="JPEG", quality=92)
    else:
        fmt = "PNG"
        img.save(out, format="PNG")
    return base64.b64encode(out.getvalue()).decode()


def _resample():
    # Pillow >= 9.1 moved the constants; support both spellings.
    f = getattr(Image, "Resampling", Image)
    return f.BILINEAR, f.NEAREST


def _blur_layer(img: Image.Image, intensity: int, gx: int = 0, gy: int = 0) -> Image.Image:
    # Port of the app's blur: for large radii the browser blurs a downscaled
    # scratch image and stretches it back, which is visually equivalent to a
    # full-size blur. The downscale is anchored to the image-origin grid
    # (offset by gx/gy) so cell samples do not shift with crop position.
    scale = min(8, 2 ** max(0, math.ceil(math.log2(intensity / 4)))) if intensity > 4 else 1
    bilinear, _ = _resample()
    if scale > 1:
        ax0 = (gx // scale) * scale
        ay0 = (gy // scale) * scale
        nx = max(1, math.ceil((gx - ax0 + img.width) / scale))
        ny = max(1, math.ceil((gy - ay0 + img.height) / scale))
        small = img.resize((nx, ny), bilinear)
        small = small.filter(ImageFilter.GaussianBlur(intensity / scale))
        big = small.resize((nx * scale, ny * scale), bilinear)
        ox, oy = gx - ax0, gy - ay0
        return big.crop((ox, oy, ox + img.width, oy + img.height))
    return img.filter(ImageFilter.GaussianBlur(intensity))


def _mosaic_chunk(img: Image.Image, intensity: int, gx: int, gy: int,
                  anchor_x: int = 0, anchor_y: int = 0) -> Image.Image:
    # Mosaic one crop of the source while keeping cell boundaries on the
    # grid established by (anchor_x, anchor_y) — the image origin for browser
    # parity, or the region's own edge for ellipses/off-image rects. gx/gy is
    # the crop's origin in full-image coordinates; the reduced image is
    # aligned to the enclosing cell boundary of that same anchor so samples
    # never shift with crop position.
    cell = max(MOSAIC_MIN, round(intensity))
    bilinear, nearest = _resample()
    ax0 = anchor_x + math.floor((gx - anchor_x) / cell) * cell
    ay0 = anchor_y + math.floor((gy - anchor_y) / cell) * cell
    ox_rel, oy_rel = gx - ax0, gy - ay0
    nx = max(1, math.ceil((ox_rel + img.width) / cell))
    ny = max(1, math.ceil((oy_rel + img.height) / cell))
    small = img.resize((nx, ny), bilinear)
    grid = small.resize((nx * cell, ny * cell), nearest)
    return grid.crop((ox_rel, oy_rel, ox_rel + img.width, oy_rel + img.height))


def _ellipse_mask(size: tuple[int, int], x: float, y: float, w: float, h: float) -> Image.Image:
    mask = Image.new("L", size, 0)
    ImageDraw.Draw(mask).ellipse((x, y, x + w, y + h), fill=255)
    return mask


def _normalize_regions(img: Image.Image, regions: list[dict]) -> list[dict]:
    if not regions:
        raise CensorError("regions must contain at least one region")
    if len(regions) > 64:
        raise CensorError("too many regions (max 64 per call)")
    out = []
    for i, r in enumerate(regions):
        try:
            x, y, w, h = float(r["x"]), float(r["y"]), float(r["w"]), float(r["h"])
        except (KeyError, TypeError, ValueError):
            raise CensorError(f"region {i}: x, y, w, h must be numbers") from None
        if w <= 0 or h <= 0:
            raise CensorError(f"region {i}: w and h must be positive")
        if not all(math.isfinite(v) for v in (x, y, w, h)):
            raise CensorError(f"region {i}: x, y, w, h must be finite")
        if max(abs(x), abs(y), w, h) > MAX_REGION_COORD:
            raise CensorError(f"region {i}: coordinates must be within +/-{MAX_REGION_COORD}")
        # Only reject regions with no visible coverage. Geometry itself is NOT
        # clipped here: clipping an ellipse's bounding box would reshape it and
        # leave requested pixels uncovered, so masks are drawn at full geometry
        # and clipped by the image boundary instead. The intersection test uses
        # the CONTINUOUS bounds so fractional slivers like {x:99.5, w:0.5} on a
        # 100px image are correctly seen as visible.
        if x + w <= 0 or y + h <= 0 or x >= img.width or y >= img.height:
            raise CensorError(f"region {i}: lies outside the {img.width}x{img.height} image")
        shape = r.get("shape", "rect")
        if shape not in ("rect", "ellipse"):
            raise CensorError(f"region {i}: shape must be 'rect' or 'ellipse'")
        effect = r.get("effect", "mosaic")
        if effect not in ("mosaic", "blur"):
            raise CensorError(f"region {i}: effect must be 'mosaic' or 'blur'")
        strength = r.get("strength")
        if strength is None:
            strength = 32 if effect == "mosaic" else 12
        try:
            strength = int(strength)
        except (TypeError, ValueError):
            raise CensorError(f"region {i}: strength must be an integer") from None
        lo, hi = (MOSAIC_MIN, MOSAIC_MAX) if effect == "mosaic" else (BLUR_MIN, BLUR_MAX)
        if not lo <= strength <= hi:
            raise CensorError(f"region {i}: {effect} strength must be {lo}..{hi}")
        out.append({"box": (x, y, x + w, y + h), "shape": shape, "effect": effect, "strength": strength})
    return out


def censor(img: Image.Image, regions: list[dict]) -> Image.Image:
    """Apply the app's effects to each region and return a new image."""
    src = img.convert("RGBA")
    out = src.copy()
    for r in _normalize_regions(img, regions):
        x0, y0, x1, y1 = r["box"]
        pad = _pad_for(r["effect"], r["strength"])
        vx0, vy0 = max(0.0, x0), max(0.0, y0)
        vx1, vy1 = min(float(img.width), x1), min(float(img.height), y1)
        bw = int(math.ceil(vx1)) - int(math.floor(vx0))
        bh = int(math.ceil(vy1)) - int(math.floor(vy0))
        if bw * bh > CHUNK_PIXELS and bh > 1:
            # A large visible area would need full-size transient buffers, so
            # process it in horizontal chunks. Masks always use the ORIGINAL
            # region geometry (never the chunk's), and every chunk reads from
            # ONE pre-region snapshot, so chunks join seamlessly and ordering
            # cannot leak already-filtered pixels into a later chunk. The same
            # snapshot serves both effects, keeping peak rasters at four.
            snapshot = out.copy()
            rows = max(1, min(CHUNK_MAX_ROWS, CHUNK_PIXELS // max(1, bw)))
            y = int(math.floor(vy0))
            yend = int(math.ceil(vy1))
            while y < yend:
                write = (x0, float(y), x1, min(float(y + rows), vy1))
                _apply_region(out, snapshot, snapshot, (x0, y0, x1, y1), write, r, pad, img.size)
                y += rows
        else:
            _apply_region(out, out, out, (x0, y0, x1, y1), (x0, y0, x1, y1), r, pad, img.size)
    return out


def _apply_region(out: Image.Image, blur_source: Image.Image, mosaic_source: Image.Image,
                  region: tuple[float, float, float, float],
                  write: tuple[float, float, float, float],
                  r: dict, pad: int, size: tuple[int, int]) -> None:
    width, height = size
    x0, y0, x1, y1 = region      # original geometry: masks and ellipse shape
    wx0, wy0, wx1, wy1 = write   # this chunk's write window
    # Work on a padded crop of the current output: effects bleed past their
    # region, and cropping keeps peak memory proportional to the censored
    # area. Blur reads blur_source ("out" unchunked, so overlapping regions
    # deepen; a pre-region snapshot when chunked, so chunk order cannot leak
    # filtered pixels). Mosaic always reads mosaic_source: its cells must
    # sample the pre-region image in BOTH modes, or chunked and unchunked
    # passes would average different pixels.
    # Mosaic crops are expanded to whole cells on ALL four sides: a partial
    # cell at any crop edge would rescale across an integer number of cells
    # and shift every sample. The grid is anchored to the region's own
    # left/top edge for ellipse shapes and off-image rects (where there is no
    # browser parity to preserve, and the region edge is what the caller
    # sees), and to the global image grid for ordinary on-image rects (the
    # browser's behavior). The mosaic pad always covers more than one cell,
    # so straddling cells still average complete source pixels.
    if r["effect"] == "mosaic":
        cell = max(MOSAIC_MIN, round(r["strength"]))
        use_region_anchor = r["shape"] == "ellipse" or x0 < 0 or y0 < 0
        anchor_x = int(math.floor(x0)) if use_region_anchor else 0
        anchor_y = int(math.floor(y0)) if use_region_anchor else 0
        cand_x = max(0, int(math.floor(wx0)) - pad)
        cand_y = max(0, int(math.floor(wy0)) - pad)
        gx0 = max(0, anchor_x + math.floor((cand_x - anchor_x) / cell) * cell)
        gy0 = max(0, anchor_y + math.floor((cand_y - anchor_y) / cell) * cell)
        end_x = min(width, int(math.ceil(wx1)) + pad)
        end_y = min(height, int(math.ceil(wy1)) + pad)
        gx1 = anchor_x + math.ceil((end_x - anchor_x) / cell) * cell
        gy1 = anchor_y + math.ceil((end_y - anchor_y) / cell) * cell
        gx1, gy1 = min(width, gx1), min(height, gy1)
    else:
        gx0 = max(0, int(math.floor(wx0)) - pad)
        gy0 = max(0, int(math.floor(wy0)) - pad)
        gx1 = min(width, int(math.ceil(wx1)) + pad)
        gy1 = min(height, int(math.ceil(wy1)) + pad)
    cx0, cy0 = gx0, gy0
    cx1, cy1 = gx1, gy1
    if cx1 <= cx0 or cy1 <= cy0:
        return  # write window is entirely off-image
    if r["effect"] == "blur":
        crop = blur_source.crop((cx0, cy0, cx1, cy1))
        layer = _blur_layer(crop, r["strength"], cx0, cy0)
    else:
        crop = mosaic_source.crop((cx0, cy0, cx1, cy1))
        layer = _mosaic_chunk(crop, r["strength"], cx0, cy0, anchor_x, anchor_y)
    # Rasterize the write window to integer pixel bounds FIRST (floor top/left,
    # ceil bottom/right), then make it exclusive on the bottom/right (Pillow
    # rectangles include both endpoints, so -1). Doing the -1 on raw floats
    # breaks fractional regions like w=0.5 (reversed rectangle).
    px0 = math.floor(max(x0, wx0))
    py0 = math.floor(max(y0, wy0))
    px1 = math.ceil(min(x1, wx1))
    py1 = math.ceil(min(y1, wy1))
    if px1 <= px0 or py1 <= py0:
        return  # write window covers no whole pixels
    mx0 = px0 - cx0
    my0 = py0 - cy0
    mx1 = px1 - cx0 - 1
    my1 = py1 - cy0 - 1
    if r["shape"] == "ellipse":
        mask = _ellipse_mask(crop.size, x0 - cx0, y0 - cy0, x1 - x0, y1 - y0)
        # Chunked writes must not paint outside this chunk's window, or the
        # next chunk (reading the pre-region snapshot) would overwrite them.
        clip = Image.new("L", crop.size, 0)
        ImageDraw.Draw(clip).rectangle((mx0, my0, mx1, my1), fill=255)
        mask = Image.composite(mask, Image.new("L", crop.size, 0), clip)
    else:
        mask = Image.new("L", crop.size, 0)
        ImageDraw.Draw(mask).rectangle((mx0, my0, mx1, my1), fill=255)
    out.paste(layer, (cx0, cy0), mask)
