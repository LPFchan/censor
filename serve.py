import http.server, functools, json, base64, os, pathlib

ICONS = pathlib.Path(__file__).parent / 'icons'
ALLOWED = {'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'}
ENABLE_LOCAL_WRITES = os.environ.get('CENSOR_ENABLE_LOCAL_WRITES') == '1'

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
        # Icon-lab writes are a local development tool. Production leaves the
        # opt-in unset because a reverse proxy also connects from loopback.
        if not ENABLE_LOCAL_WRITES:
            self.send_error(404); return
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
        self.send_error(405)

    def do_OPTIONS(self):
        self.send_error(405)

    def end_headers(self):
        # app under active development: never let the CDN or browser serve stale code
        if 'nostore' in self.path:
            self.send_header('Cache-Control', 'no-store')
        elif self.path.endswith(('.js', '.css', '.html', '.webmanifest')) or self.path in ('/', ''):
            self.send_header('Cache-Control', 'no-cache')
        # agent discovery: advertise the MCP server (RFC 8288)
        if self.path in ('/', '/index.html'):
            self.send_header('Link', '</.well-known/mcp/server-card.json>; rel="mcp-server-card", </mcp>; rel="service"')
        super().end_headers()
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(('127.0.0.1', 8600), Handler).serve_forever()
