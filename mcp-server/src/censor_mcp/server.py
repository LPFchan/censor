from __future__ import annotations

import asyncio
import fnmatch
import math
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from mcp.server import CacheHint, MCPServer
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ImageContent, TextContent
from starlette.responses import JSONResponse
import uvicorn

from .effects import (
    BLUR_MAX, BLUR_MIN, MOSAIC_MAX, MOSAIC_MIN,
    CensorError, censor, decode_image, encode_image,
)


def _build_transport_security() -> TransportSecuritySettings:
    return TransportSecuritySettings(enable_dns_rebinding_protection=False)


class _CORSMiddleware:
    def __init__(self, app):
        self.app = app
        raw = os.environ.get("ALLOWED_ORIGINS", "https://*.lost.plus")
        self.allowed_origins = [o.strip() for o in raw.split(",") if o.strip()]
        self.cors_methods = b"GET, POST, DELETE, OPTIONS"
        self.cors_allow_headers = (
            b"authorization, content-type, accept, mcp-session-id, mcp-protocol-version, "
            b"mcp-method, mcp-name, mcp-param-*, last-event-id, x-api-key"
        )
        self.cors_expose_headers = b"mcp-session-id, mcp-protocol-version, content-type"

    def _echo_origin(self, origin: str | None) -> str | None:
        if not origin:
            return None
        for pattern in self.allowed_origins:
            if fnmatch.fnmatch(origin, pattern):
                return origin
        return None

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", []))
        origin_raw = headers.get(b"origin")
        origin = origin_raw.decode() if origin_raw else None
        matched = self._echo_origin(origin)

        # MCP transport requirement: any request carrying an Origin we do not
        # approve is rejected, not merely denied a CORS header. Clients that
        # send no Origin at all (CLI agents, curl) are unaffected.
        if origin and not matched:
            await send({"type": "http.response.start", "status": 403, "headers": [(b"content-type", b"text/plain")]})
            await send({"type": "http.response.body", "body": b"origin not allowed"})
            return

        if scope["method"] == "OPTIONS":
            resp_headers = [
                (b"access-control-allow-methods", self.cors_methods),
                (b"access-control-allow-headers", self.cors_allow_headers),
                (b"access-control-max-age", b"86400"),
                (b"access-control-expose-headers", self.cors_expose_headers),
            ]
            if matched:
                resp_headers.insert(0, (b"access-control-allow-origin", matched.encode()))
            await send({"type": "http.response.start", "status": 204, "headers": resp_headers})
            await send({"type": "http.response.body", "body": b""})
            return

        async def send_with_cors(message):
            if message["type"] == "http.response.start":
                hlist = list(message.get("headers", []))
                if matched:
                    hlist.append((b"access-control-allow-origin", matched.encode()))
                hlist.append((b"access-control-expose-headers", self.cors_expose_headers))
                hlist.append((b"vary", b"Origin"))
                message["headers"] = hlist
            await send(message)

        await self.app(scope, receive, send_with_cors)


class _RateLimitMiddleware:
    """Fixed-window, per-client-IP rate limiter. Defaults are deliberately lax:
    30 requests/minute and 240/hour, plenty for any real agent workflow."""

    def __init__(self, app):
        self.app = app
        self.per_minute = int(os.environ.get("RATE_LIMIT_PER_MINUTE", "30"))
        self.per_hour = int(os.environ.get("RATE_LIMIT_PER_HOUR", "240"))
        self.exempt_paths = {"/healthz", "/.well-known/mcp/server-card.json"}
        self._hits: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def _client_ip(self, scope) -> str:
        headers = dict(scope.get("headers", []))
        # Cf-Connecting-Ip is set by the Cloudflare edge and forwarded by
        # cloudflared; behind the tunnel it cannot be spoofed by clients.
        # serve.py deliberately strips X-Forwarded-For (Cloudflare preserves
        # and appends, so every hop in it is client-influenced). The header
        # is only honored from the two peers that can legitimately carry it:
        # loopback (local tests) and the Docker bridge gateway (serve.py's
        # proxied requests, which is how all tunnel traffic arrives). ufw
        # blocks external direct ingress to this listener.
        cf_ip = headers.get(b"cf-connecting-ip", b"").decode().strip()
        peer = scope.get("client", ("unknown", 0))[0]
        trusted = {"127.0.0.1", "::1", os.environ.get("TRUSTED_PROXY_IP", "172.30.0.1")}
        if cf_ip and peer in trusted:
            return cf_ip
        return peer

    def _allow(self, ip: str) -> tuple[bool, int]:
        now = time.monotonic()
        with self._lock:
            hits = [t for t in self._hits.get(ip, []) if now - t < 3600]
            recent = sum(1 for t in hits if now - t < 60)
            if len(hits) >= self.per_hour or recent >= self.per_minute:
                self._hits[ip] = hits
                oldest_in_window = hits[-self.per_minute] if hits else now
                retry = max(1, int(60 - (now - oldest_in_window)))
                return False, retry
            hits.append(now)
            self._hits[ip] = hits
            # keep the dict from growing without bound on a long-lived process
            if len(self._hits) > 10_000:
                self._hits = {k: v for k, v in self._hits.items() if v and now - v[-1] < 3600}
        return True, 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path", "") in self.exempt_paths:
            await self.app(scope, receive, send)
            return
        allowed, retry_after = self._allow(self._client_ip(scope))
        if not allowed:
            body = b'{"error":"rate limit exceeded, try again later"}'
            await send({
                "type": "http.response.start",
                "status": 429,
                "headers": [
                    (b"content-type", b"application/json"),
                    (b"retry-after", str(retry_after).encode()),
                ],
            })
            await send({"type": "http.response.body", "body": body})
            return
        await self.app(scope, receive, send)


class _AdmissionMiddleware:
    """Server-wide admission control, applied BEFORE any body is buffered.

    Without this, concurrent requests each materialize their full base64
    image (up to ~40 MB) during HTTP parsing, ahead of any tool-level
    semaphore — a burst within the rate limit can exceed the container's
    memory budget through input strings alone. Excess requests get a fast 503
    and never read a byte of body.

    This gate bounds buffered-body memory; the worker semaphore bounds actual
    image-processing work. The two use separate counters so one request never
    acquires both. The limit is sized against worst-case retained bytes:
    each admitted request can hold a ~45 MB body, and the container must keep
    total memory under 512 MiB including image rasters.
    """

    def __init__(self, app, limit: int):
        self.app = app
        self.semaphore = threading.BoundedSemaphore(limit)
        self.exempt_paths = {"/healthz", "/.well-known/mcp/server-card.json"}

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope.get("path", "") in self.exempt_paths:
            await self.app(scope, receive, send)
            return
        if not self.semaphore.acquire(blocking=False):
            body = b'{"error":"server busy, try again in a few seconds"}'
            await send({
                "type": "http.response.start",
                "status": 503,
                "headers": [(b"content-type", b"application/json"), (b"retry-after", b"5")],
            })
            await send({"type": "http.response.body", "body": body})
            return
        try:
            await self.app(scope, receive, send)
        finally:
            self.semaphore.release()


# Image decode + effects are CPU-bound, so run them off the event loop.
_pool = ThreadPoolExecutor(max_workers=int(os.environ.get("CENSOR_WORKERS", "1")))

# Bound retained work: without this, uploads (each up to ~45 MB of base64)
# pile into the executor's unbounded queue and can exceed the container's
# memory limit before any rate limit trips. The semaphore is acquired in the
# TOOL (before submission, so queued requests are bounded too) and released
# inside the worker's own finally (so a cancelled coroutine cannot free the
# slot while work continues).
_admission = threading.BoundedSemaphore(int(os.environ.get("CENSOR_MAX_INFLIGHT", "2")))


def _process(image_b64: str | None, image_url: str | None, regions: list[dict],
             output_format: str) -> tuple[str, str, int, int]:
    # Release happens INSIDE the worker: if the awaiting coroutine is
    # cancelled, the slot stays held until the work actually finishes instead
    # of being freed early by the coroutine's finally. (Acquire is in the
    # tool, before submission, so the queue of waiting calls is bounded.)
    # Errors are returned, not raised, so the tool can tell "worker ran and
    # released" apart from "submission failed" without double-releasing.
    try:
        try:
            img, src_fmt = decode_image(image_b64=image_b64, image_url=image_url)
            width, height = img.size
            result = censor(img, regions)
            fmt = output_format.upper()
            if fmt == "ORIGINAL":
                fmt = "JPEG" if src_fmt == "JPEG" else "PNG"
            if fmt not in ("PNG", "JPEG"):
                raise CensorError("output_format must be 'png', 'jpeg', or 'original'")
            return (encode_image(result, fmt), fmt, width, height)
        except CensorError as e:
            return e
    finally:
        _admission.release()


def _info(image_b64: str | None, image_url: str | None) -> dict:
    try:
        try:
            img, fmt = decode_image(image_b64=image_b64, image_url=image_url)
            return {"width": img.width, "height": img.height, "format": fmt}
        except CensorError as e:
            return e
    finally:
        _admission.release()


_REGION_SCHEMA = {
    "type": "object",
    "properties": {
        "x": {"type": "number", "description": "Left edge of the region, in pixels from the image's left edge."},
        "y": {"type": "number", "description": "Top edge of the region, in pixels from the image's top edge."},
        "w": {"type": "number", "description": "Width of the region in pixels."},
        "h": {"type": "number", "description": "Height of the region in pixels."},
        "shape": {
            "type": "string", "enum": ["rect", "ellipse"], "default": "rect",
            "description": "ellipse suits faces and heads; rect suits text, plates, and screens.",
        },
        "effect": {
            "type": "string", "enum": ["mosaic", "blur"], "default": "mosaic",
            "description": "Effect for this region. Overrides the call-level default.",
        },
        "strength": {
            "type": "integer",
            "description": (
                "Effect strength for this region. mosaic: 1..64 px cell side; "
                "blur: 2..80 px radius. Overrides the call-level default."
            ),
        },
    },
    "required": ["x", "y", "w", "h"],
}


mcp = MCPServer(
    "censor",
    version="1.0.0",
    instructions=(
        "Apply mosaic (pixelation) or Gaussian blur to regions of an image. "
        "Coordinates are pixels in the source image with the origin at the top-left. "
        "Pass regions covering whatever should be hidden (faces, text, plates, screens). "
        "The image is processed in memory and discarded immediately after the response."
    ),
    website_url="https://censor.lost.plus",
    cache_hints={
        "server/discover": CacheHint(ttl_ms=3_600_000, scope="public"),
        "tools/list": CacheHint(ttl_ms=3_600_000, scope="public"),
    },
)


@mcp.tool(
    title="Censor image regions",
    annotations={
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
)
async def censor_image(
    regions: list[dict],
    image_b64: str | None = None,
    image_url: str | None = None,
    effect: str = "mosaic",
    strength: int | None = None,
    output_format: str = "original",
) -> list:
    """Censor regions of an image with mosaic (pixelation) or blur.

    Provide the image as base64 (image_b64) or a data URL (image_url), plus one
    or more regions to hide. Each region is {x, y, w, h} in source-image pixels,
    optionally with its own shape ('rect' or 'ellipse'), effect, and strength.
    The call-level effect/strength act as defaults for regions that don't set
    their own. Returns the censored image and basic metadata. Nothing is stored:
    the image lives in memory only for the duration of the call.
    """
    if effect not in ("mosaic", "blur"):
        raise ValueError("effect must be 'mosaic' or 'blur'")
    default_strength = strength if strength is not None else (32 if effect == "mosaic" else 12)
    lo, hi = (MOSAIC_MIN, MOSAIC_MAX) if effect == "mosaic" else (BLUR_MIN, BLUR_MAX)
    if not lo <= int(default_strength) <= hi:
        raise ValueError(f"{effect} strength must be {lo}..{hi}")
    regions = [
        {"effect": effect, "strength": default_strength, **{k: v for k, v in r.items() if v is not None}}
        for r in regions
    ]

    if not _admission.acquire(blocking=False):
        raise ValueError("server is busy processing other images; try again in a few seconds")
    loop = asyncio.get_running_loop()
    try:
        outcome = await loop.run_in_executor(
            _pool, _process, image_b64, image_url, regions, output_format
        )
    except BaseException:
        # Submission itself failed or the await was cancelled before the
        # worker started: its finally never runs, so release here. If the
        # worker already started, its finally releases too and BoundedSemaphore
        # raises ValueError on the over-release; swallow that exact race.
        try:
            _admission.release()
        except ValueError:
            pass
        raise
    if isinstance(outcome, CensorError):
        raise ValueError(str(outcome)) from None
    b64, fmt, width, height = outcome

    meta = (
        f"Censored {len(regions)} region(s) on a {width}x{height} image; "
        f"output {fmt}, {math.ceil(len(b64) * 3 / 4 / 1024)} KiB. "
        "The source image was processed in memory and discarded."
    )
    return [
        ImageContent(type="image", data=b64, mimeType=f"image/{fmt.lower()}"),
        TextContent(type="text", text=meta),
    ]


@mcp.tool(
    title="Get image dimensions",
    annotations={"readOnlyHint": True, "idempotentHint": True, "openWorldHint": False},
)
async def get_image_info(
    image_b64: str | None = None,
    image_url: str | None = None,
) -> dict:
    """Return an image's width, height, and format.

    Call this first when you only have the image and need to plan censor_image
    regions in real pixel coordinates. Nothing is stored.
    """
    if not _admission.acquire(blocking=False):
        raise ValueError("server is busy processing other images; try again in a few seconds")
    loop = asyncio.get_running_loop()
    try:
        outcome = await loop.run_in_executor(_pool, _info, image_b64, image_url)
    except BaseException:
        try:
            _admission.release()
        except ValueError:
            pass
        raise
    if isinstance(outcome, CensorError):
        raise ValueError(str(outcome)) from None
    return outcome


# Conforms to the experimental MCP Server Card schema (ext-server-card):
# identity/transport only; tools stay discoverable via the protocol itself.
_SERVER_CARD = {
    "$schema": "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    "name": "plus.lost.censor/censor",
    "version": "1.0.0",
    "description": "Apply mosaic or blur to regions of an image. Processed in memory, never stored.",
    "title": "censor",
    "websiteUrl": "https://censor.lost.plus",
    "repository": {
        "url": "https://github.com/LPFchan/censor",
        "source": "github",
        "subfolder": "mcp-server",
    },
    "remotes": [
        {
            "type": "streamable-http",
            "url": "https://censor.lost.plus/mcp",
        }
    ],
    "_meta": {
        "plus.lost.censor/privacy": "Images are processed in memory only and discarded immediately after each response.",
    },
}


@mcp.custom_route("/", methods=["GET"], include_in_schema=False)
async def root_route(request):
    del request
    return JSONResponse({
        "name": "censor-mcp",
        "mcp_path": "/mcp",
        "healthz": "/healthz",
        "tools": ["censor_image", "get_image_info"],
        "privacy": "images are processed in memory and never stored",
    })


@mcp.custom_route("/healthz", methods=["GET"], include_in_schema=False)
async def health_route(request):
    del request
    return JSONResponse({"ok": True})


@mcp.custom_route("/.well-known/mcp/server-card.json", methods=["GET"], include_in_schema=False)
async def server_card_route(request):
    del request
    return JSONResponse(
        _SERVER_CARD,
        headers={"access-control-allow-origin": "*", "cache-control": "public, max-age=3600"},
    )


_app = _CORSMiddleware(
    _RateLimitMiddleware(
        _AdmissionMiddleware(
            mcp.streamable_http_app(
                streamable_http_path="/mcp",
                json_response=True,
                stateless_http=True,
                host=os.environ.get("HOST", "0.0.0.0"),
                transport_security=_build_transport_security(),
            ),
            # Match the worker semaphore: at most two retained request bodies
            # (~90 MB) alongside image rasters, keeping total under 512 MiB.
            int(os.environ.get("CENSOR_MAX_INFLIGHT", "2")),
        )
    )
)


async def app(scope, receive, send):
    if scope["type"] == "http" and scope["method"] == "POST":
        path = scope.get("path", "")
        if path.rstrip("/") == "":
            scope["path"] = "/mcp"
        elif path != "/mcp" and path.rstrip("/") == "/mcp":
            scope["path"] = "/mcp"
    await _app(scope, receive, send)


def main() -> None:
    uvicorn.run(
        app,
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "8000")),
        forwarded_allow_ips="*",
        proxy_headers=True,
        timeout_keep_alive=30,
    )


if __name__ == "__main__":
    main()
