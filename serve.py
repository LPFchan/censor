import http.server, functools, json, base64, pathlib, urllib.request, urllib.error

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
        # hop-by-hop on loopback, so the 30 MB image limit lives here too
        raw = self.rfile.read(int(self.headers.get('Content-Length') or 0)) if self.headers.get('Content-Length') else None
        if raw and len(raw) > 45_000_000:
            self.send_error(413, 'request too large'); return
        headers = {k: v for k, v in self.headers.items()
                   if k.lower() not in ('host', 'content-length', 'connection')}
        headers['X-Forwarded-For'] = (self.headers.get('X-Forwarded-For', '') + ', ' + self.client_address[0]).strip(', ')
        req = urllib.request.Request('http://127.0.0.1:8610' + self.path, data=raw,
                                     headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                body = resp.read()
                self.send_response(resp.status)
                for k, v in resp.headers.items():
                    if k.lower() not in ('connection', 'transfer-encoding', 'content-length'):
                        self.send_header(k, v)
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            body = e.read()
            self.send_response(e.code)
            for k, v in e.headers.items():
                if k.lower() not in ('connection', 'transfer-encoding', 'content-length'):
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
