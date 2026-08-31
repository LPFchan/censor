import http.server, functools, json, base64, pathlib

ICONS = pathlib.Path(__file__).parent / 'icons'
ALLOWED = {'icon.svg', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'}

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_POST(self):
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

    def end_headers(self):
        # app under active development: never let the CDN or browser serve stale code
        if 'nostore' in self.path:
            self.send_header('Cache-Control', 'no-store')
        elif self.path.endswith(('.js', '.css', '.html', '.webmanifest')) or self.path in ('/', ''):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()
    def log_message(self, *a):
        pass

http.server.ThreadingHTTPServer(('0.0.0.0', 8600), Handler).serve_forever()
