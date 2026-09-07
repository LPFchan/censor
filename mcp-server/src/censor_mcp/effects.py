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

# Decompression-bomb guard. 32 MP keeps peak RGBA memory for source + layers
# + output around 400 MiB, inside the container's 512 MiB limit. Pillow raises
# above this instead of just warning.
Image.MAX_IMAGE_PIXELS = 32_000_000

MAX_DIMENSION = 8192
MAX_PIXELS = 32_000_000
MAX_BASE64_CHARS = 40_000_000  # ~30 MB of image data once decoded

BLUR_MIN, BLUR_MAX = 2, 80      # radius in px, same as the app's slider
MOSAIC_MIN, MOSAIC_MAX = 1, 64  # square cell side in px, same as the app's slider


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
    return img, (img.format or "PNG").upper()


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


def _mosaic_layer(img: Image.Image, intensity: int) -> Image.Image:
    # Port of the app's mosaic: shrink to one pixel per cell with smoothing,
    # then scale back up to the grid size with smoothing off and crop, so cell
    # widths match the browser (the final cell may be clipped at the edge).
    cell = max(MOSAIC_MIN, round(intensity))
    bilinear, nearest = _resample()
    nx = max(1, math.ceil(img.width / cell))
    ny = max(1, math.ceil(img.height / cell))
    small = img.resize((nx, ny), bilinear)
    grid = small.resize((nx * cell, ny * cell), nearest)
    return grid.crop((0, 0, img.width, img.height))


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
        # Effects run on the current output, so overlapping regions deepen
        # censorship instead of resetting it to the original.
        layer = _blur_layer(out, r["strength"]) if r["effect"] == "blur" else _mosaic_layer(out, r["strength"])
        if r["shape"] == "ellipse":
            mask = _ellipse_mask(img.size, x0, y0, x1 - x0, y1 - y0)
        else:
            mask = Image.new("L", img.size, 0)
            ImageDraw.Draw(mask).rectangle((x0, y0, x1, y1), fill=255)
        out.paste(layer, (0, 0), mask)
    return out
