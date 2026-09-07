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

# Decompression-bomb guard, sized from the container's 512 MiB limit: the
# persistent rasters (decoded image, RGBA source, output copy) plus transient
# region/crop/layer buffers stay under roughly 6 bytes per pixel even for a
# full-image region. Pillow raises above this instead of just warning.
Image.MAX_IMAGE_PIXELS = 20_000_000

MAX_DIMENSION = 8192
MAX_PIXELS = 20_000_000
MAX_BASE64_CHARS = 40_000_000  # ~30 MB of image data once decoded
MAX_REGION_COORD = 100_000     # geometry beyond this is nonsense and only
                               # feeds Pillow's rasterizer pointless work

# Regions bigger than this are processed in horizontal chunks so transient
# buffers stay small no matter how large the censored area is.
CHUNK_PIXELS = 4_000_000

BLUR_MIN, BLUR_MAX = 2, 80      # radius in px, same as the app's slider
MOSAIC_MIN, MOSAIC_MAX = 1, 64  # square cell side in px, same as the app's slider

# Effects bleed a few strength-lengths past their region, so process a padded
# crop rather than the full image. This keeps peak memory independent of how
# small the censored area is relative to the whole picture.
def _pad_for(effect: str, strength: int) -> int:
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


def _blur_layer(img: Image.Image, intensity: int) -> Image.Image:
    # Port of the app's blur: for large radii the browser blurs a downscaled
    # scratch image and stretches it back, which is visually equivalent to a
    # full-size blur. GaussianBlur needs no such trick, but we keep the
    # downscale for large radii to stay fast on big images.
    scale = min(8, 2 ** max(0, math.ceil(math.log2(intensity / 4)))) if intensity > 4 else 1
    bilinear, _ = _resample()
    if scale > 1:
        small = img.resize(
            (max(1, math.ceil(img.width / scale)), max(1, math.ceil(img.height / scale))),
            bilinear,
        )
        small = small.filter(ImageFilter.GaussianBlur(intensity / scale))
        return small.resize(img.size, bilinear)
    return img.filter(ImageFilter.GaussianBlur(intensity))


def _mosaic_chunk(img: Image.Image, intensity: int, ox: int, oy: int) -> Image.Image:
    # Mosaic one crop of the source while keeping cell boundaries on the
    # FULL-IMAGE grid, like the browser. Cells that straddle the crop edge
    # keep their full-image average, so the crop must cover every whole cell
    # it touches (the caller's padding guarantees this).
    cell = max(MOSAIC_MIN, round(intensity))
    bilinear, nearest = _resample()
    cx0 = (ox // cell) * cell
    cy0 = (oy // cell) * cell
    ox_rel, oy_rel = ox - cx0, oy - cy0
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
        # and clipped by the image boundary instead.
        if x + w < 1 or y + h < 1 or x > img.width - 1 or y > img.height - 1:
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
        bw = int(math.ceil(x1)) - int(math.floor(x0))
        bh = int(math.ceil(y1)) - int(math.floor(y0))
        if bw * bh > CHUNK_PIXELS:
            # A region covering a large image would need full-size transient
            # buffers. Process it in horizontal chunks instead: each chunk is
            # independently padded, effects stay local, and the mosaic helper
            # keeps cells on the full-image grid so chunks join seamlessly.
            rows = max(1, CHUNK_PIXELS // max(1, bw))
            y = int(math.floor(y0))
            while y < int(math.ceil(y1)):
                _apply_region(out, x0, float(y), x1, min(float(y + rows), y1),
                              r, pad, img.size)
                y += rows
        else:
            _apply_region(out, x0, y0, x1, y1, r, pad, img.size)
    return out


def _apply_region(out: Image.Image, x0: float, y0: float, x1: float, y1: float,
                  r: dict, pad: int, size: tuple[int, int]) -> None:
    width, height = size
    # Work on a padded crop of the current output: effects bleed past their
    # region, and cropping keeps peak memory proportional to the censored
    # area. Running on "out" (not the original) means overlapping regions
    # deepen censorship instead of resetting it. The pad exceeds the maximum
    # effect bleed, so chunk boundaries are invisible.
    cx0 = max(0, int(math.floor(x0)) - pad)
    cy0 = max(0, int(math.floor(y0)) - pad)
    cx1 = min(width, int(math.ceil(x1)) + pad)
    cy1 = min(height, int(math.ceil(y1)) + pad)
    crop = out.crop((cx0, cy0, cx1, cy1))
    if r["effect"] == "blur":
        layer = _blur_layer(crop, r["strength"])
    else:
        layer = _mosaic_chunk(crop, r["strength"], cx0, cy0)
    if r["shape"] == "ellipse":
        mask = _ellipse_mask(crop.size, x0 - cx0, y0 - cy0, x1 - x0, y1 - y0)
    else:
        mask = Image.new("L", crop.size, 0)
        ImageDraw.Draw(mask).rectangle((x0 - cx0, y0 - cy0, x1 - cx0, y1 - cy0), fill=255)
    out.paste(layer, (cx0, cy0), mask)
