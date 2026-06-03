#!/usr/bin/env python3
"""Static server for the ingenue web preview. Binds all interfaces; no caching."""
import http.server, socketserver, os, sys

os.chdir(os.path.dirname(os.path.abspath(__file__)))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8780

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, max-age=0')
        super().end_headers()
    def log_message(self, *a):
        pass

socketserver.TCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), H) as httpd:
    print(f"ingenue preview on 0.0.0.0:{PORT}", flush=True)
    httpd.serve_forever()
