#!/usr/bin/env python3
"""
ingenue backend — serves the web app AND a small device API over the real norns
filesystem (dust). Runs alongside maiden as an independent service.

  python3 server.py [PORT]          # default 7777
  INGENUE_DUST=/path/to/dust python3 server.py

API (all confined to the dust tree):
  GET  /api/installed               -> ["awake", "glut", ...]   (dirs in dust/code)
  GET  /api/ls?path=code/awake      -> [{name,type,size,mod}, ...]
  GET  /api/read?path=code/awake/awake.lua   -> raw file text
  PUT  /api/write?path=...          -> {ok:true}   (body = content)
"""
import http.server, socketserver, os, sys, json, posixpath, urllib.parse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
DUST = os.environ.get("INGENUE_DUST", "/storage/roms/ports/norns/data/dust")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7777


def safe(rel):
    """Resolve a dust-relative path, refusing anything that escapes the dust root."""
    rel = urllib.parse.unquote(rel or "").lstrip("/")
    full = os.path.realpath(os.path.join(DUST, rel))
    root = os.path.realpath(DUST)
    if full != root and not full.startswith(root + os.sep):
        raise ValueError("path escapes dust")
    return full


def listing(full):
    out = []
    for name in sorted(os.listdir(full)):
        p = os.path.join(full, name)
        try:
            st = os.stat(p)
            out.append({
                "name": name,
                "type": "dir" if os.path.isdir(p) else "file",
                "size": st.st_size,
                "mod": datetime.date.fromtimestamp(st.st_mtime).isoformat(),
            })
        except OSError:
            pass
    return out


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _query(self):
        q = urllib.parse.urlparse(self.path).query
        return urllib.parse.parse_qs(q)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/installed":
                code = safe("code")
                scripts = [d for d in sorted(os.listdir(code)) if os.path.isdir(os.path.join(code, d)) and not d.startswith(".")]
                return self._json(scripts)
            if path == "/api/ls":
                return self._json(listing(safe(self._query().get("path", [""])[0])))
            if path == "/api/read":
                with open(safe(self._query().get("path", [""])[0]), "r", encoding="utf-8", errors="replace") as f:
                    body = f.read().encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        except (ValueError, FileNotFoundError, NotADirectoryError) as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)
        return super().do_GET()

    def do_PUT(self):
        path = urllib.parse.urlparse(self.path).path
        if path != "/api/write":
            return self._json({"error": "not found"}, 404)
        try:
            full = safe(self._query().get("path", [""])[0])
            n = int(self.headers.get("Content-Length", 0))
            data = self.rfile.read(n)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                f.write(data)
            return self._json({"ok": True, "path": path, "bytes": n})
        except (ValueError,) as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)

    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), H) as httpd:
    print(f"ingenue backend on 0.0.0.0:{PORT}  (dust={DUST}, exists={os.path.isdir(DUST)})", flush=True)
    httpd.serve_forever()
