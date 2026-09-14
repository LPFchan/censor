import asyncio

import censor_mcp.server as server
from censor_mcp.server import MAX_JSON_NON_IMAGE, _AdmissionMiddleware


def run_request(chunks: list[bytes], headers: list[tuple[bytes, bytes]] | None = None):
    downstream_bodies: list[bytes] = []
    responses: list[dict] = []

    async def downstream(scope, receive, send):
        message = await receive()
        downstream_bodies.append(message.get("body", b""))
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    messages = [
        {
            "type": "http.request",
            "body": chunk,
            "more_body": index < len(chunks) - 1,
        }
        for index, chunk in enumerate(chunks)
    ]

    async def receive():
        if messages:
            return messages.pop(0)
        return {"type": "http.disconnect"}

    async def send(message):
        responses.append(message)

    scope = {
        "type": "http",
        "method": "POST",
        "path": "/mcp",
        "headers": headers or [],
    }
    asyncio.run(_AdmissionMiddleware(downstream, 1)(scope, receive, send))
    status = next(message["status"] for message in responses if message["type"] == "http.response.start")
    return status, downstream_bodies


def test_chunked_body_without_content_length_is_replayed_exactly():
    body = b'{"jsonrpc":"2.0","method":"initialize","id":1}'

    status, downstream_bodies = run_request([body[:17], body[17:]])

    assert status == 204
    assert downstream_bodies == [body]


def test_chunked_oversized_structural_json_is_rejected_before_downstream():
    body = b"[" + (b"0," * (MAX_JSON_NON_IMAGE // 2 + 1)) + b"0]"

    status, downstream_bodies = run_request([body[:100_000], body[100_000:]])

    assert status == 413
    assert downstream_bodies == []


def test_declared_length_must_match_received_body():
    body = b'{"jsonrpc":"2.0"}'

    status, downstream_bodies = run_request(
        [body],
        [(b"content-length", str(len(body) + 1).encode())],
    )

    assert status == 413
    assert downstream_bodies == []


def test_stalled_body_times_out_and_releases_admission_permit(monkeypatch):
    monkeypatch.setattr(server, "MCP_BODY_READ_TIMEOUT", 0.01)
    responses: list[dict] = []
    downstream_calls = 0

    async def downstream(scope, receive, send):
        nonlocal downstream_calls
        downstream_calls += 1
        await receive()
        await send({"type": "http.response.start", "status": 204, "headers": []})
        await send({"type": "http.response.body", "body": b""})

    first_message = True

    async def stalled_receive():
        nonlocal first_message
        if first_message:
            first_message = False
            return {"type": "http.request", "body": b"{", "more_body": True}
        await asyncio.Event().wait()

    async def send(message):
        responses.append(message)

    scope = {"type": "http", "method": "POST", "path": "/mcp", "headers": []}
    middleware = _AdmissionMiddleware(downstream, 1)
    asyncio.run(middleware(scope, stalled_receive, send))

    assert next(message["status"] for message in responses if message["type"] == "http.response.start") == 408
    assert downstream_calls == 0

    # The timeout path must release the only permit for the next request.
    body = b'{"jsonrpc":"2.0"}'
    next_responses: list[dict] = []

    async def normal_receive():
        return {"type": "http.request", "body": body, "more_body": False}

    async def next_send(message):
        next_responses.append(message)

    asyncio.run(middleware(scope, normal_receive, next_send))
    assert next(message["status"] for message in next_responses if message["type"] == "http.response.start") == 204
    assert downstream_calls == 1
