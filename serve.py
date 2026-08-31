import http.server, functools

class Handler(http.server.SimpleHTTPRequestHandler):
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
