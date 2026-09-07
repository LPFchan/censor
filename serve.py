import http.server, functools, json, base64, pathlib, urllib.request, urllib.error

MAX_PROXY_BODY = 45_000_000  # room for a 30 MB image plus JSON/base64 overhead
UPLOAD_TIMEOUT = 30          # seconds to send the whole body
HOP_BY_HOP = {'host', 'content-length', 'connection', 'transfer-encoding',
              'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authenticate',
              'proxy-authorization'}

ICONS = pathlib.Path(__file__).parent / 'icons'
ALLOWED = {'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'}

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # reverse-proxy the censor MCP server (127.0.0.1:8610, see mcp-server/)
        if self.path.startswith('/mcp') or self.path == '/.well-known/mcp/server-card.json':
            return self._proxy()
        super().do_GET()

    def do_POST(self):
        if self.path.startswith('/mcp'):
            return self._proxy()
        # icon-lab save endpoints: only from tailnet/loopback
        ip = self.client_address[0]
        if not (ip.startswith('100.') or ip in ('127.0.0.1', '::1')):
            self.send_error(403); return
        raw = self.rfile.read(int(self.headers['Content-Length']))
        try:
            if self.path == '/save-icons':
                body = json.loads(raw)
                saved = []
                for name, b64 in body.items():
                    if name not in ALLOWED: continue
                    (ICONS / name).write_bytes(base64.b64decode(b64))
                    saved.append(name)
                data = json.dumps({'saved': saved}).encode()
            elif self.path == '/save-zip':
                dl = pathlib.Path.home() / 'Downloads'
                dl.mkdir(exist_ok=True)
                (dl / 'censor-icons.zip').write_bytes(raw)
                data = json.dumps({'saved': str(dl / 'censor-icons.zip')}).encode()
            else:
                self.send_error(404); return
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except Exception as e:
            self.send_error(500, str(e))

    def do_DELETE(self):
        if self.path.startswith('/mcp'):
            return self._proxy()
        self.send_error(405)

    def do_OPTIONS(self):
        if self.path.startswith('/mcp'):
            return self._proxy()
        self.send_error(405)

    def _proxy(self):
        # Enforce the body cap BEFORE reading anything, so a hostile
        # Content-Length cannot make this process allocate the body first.
        # The socket timeout bounds how long a slow or stalled upload can
        # hold this thread.
        transfer_encoding = self.headers.get('Transfer-Encoding', '').lower()
        content_length = self.headers.get('Content-Length')
        if transfer_encoding and transfer_encoding != 'identity':
            # The base handler never decodes chunked bodies; forwarding the
            # framing without the chunks would desync the upstream.
            self.send_error(411, 'use Content-Length, chunked bodies are not proxied'); return
        try:
            length = int(content_length) if content_length is not None else 0
        except ValueError:
            self.send_error(400, 'bad Content-Length'); return
        if length < 0 or length > MAX_PROXY_BODY:
            self.send_error(413, 'request too large'); return
        self.connection.settimeout(UPLOAD_TIMEOUT)
        try:
            raw = self.rfile.read(length) if length else None
        except (TimeoutError, OSError):
            return  # stalled or interrupted upload; drop the thread
        finally:
            self.connection.settimeout(None)
        if raw is not None and len(raw) < length:
            return  # client went away mid-upload; just drop the thread
        extra_hop = {h.strip().lower() for h in self.headers.get('Connection', '').split(',') if h.strip()}
        skip = HOP_BY_HOP | extra_hop
        headers = {k: v for k, v in self.headers.items() if k.lower() not in skip}
        # X-Forwarded-For is client-spoofable (Cloudflare preserves and
        # appends), so it is not forwarded at all. The visitor identity the
        # rate limiter trusts is Cf-Connecting-Ip, set by the Cloudflare edge
        # and unspoofable behind the tunnel; local direct tests pass it by hand.
        headers.pop('X-Forwarded-For', None)
        req = urllib.request.Request('http://127.0.0.1:8610' + self.path, data=raw,
                                     headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
                self.send_response(resp.status)
                resp_skip = HOP_BY_HOP | {h.strip().lower() for h in resp.headers.get('Connection', '').split(',') if h.strip()}
                for k, v in resp.headers.items():
                    if k.lower() not in resp_skip:
                        self.send_header(k, v)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            err_skip = HOP_BY_HOP | {h.strip().lower() for h in (e.headers.get('Connection', '') if e.headers else '').split(',') if h.strip()}
            for k, v in e.headers.items():
                if k.lower() not in err_skip:
                    self.send_header(k, v)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as e:
            self.send_error(502, str(e))

    def end_headers(self):
        # app under active development: never let the CDN or browser serve stale code
        if 'nostore' in self.path:
            self.send_header('Cache-Control', 'no-store')
        elif self.path.endswith(('.js', '.css', '.html', '.webmanifest')) or self.path in ('/', ''):
            self.send_header('Cache-Control', 'no-cache')
        elif self.path.startswith('/mcp') or self.path == '/.well-known/mcp/server-card.json':
            self.send_header('Cache-Control', 'no-store')
        # agent discovery: advertise the MCP server (RFC 8288)
        if self.path in ('/', '/index.html'):
            self.send_header('Link', '</.well-known/mcp/server-card.json>; rel="mcp-server-card", </mcp>; rel="service"')
        super().end_headers()
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(('0.0.0.0', 8600), Handler).serve_forever()
