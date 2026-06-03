#!/usr/bin/env python3
"""
ingenue backend — serves the web app AND a device API over the real norns dust tree.
Portable: discovers dust relative to itself, so it works on ANY norns (not just this port).

Install layout (norns mod):  dust/code/ingenue/{index.html, *.json, server.py, lib/mod.lua}
=> dust is two levels up from here. Override with INGENUE_DUST if needed.

  python3 server.py [PORT]            # default 7777

API (confined to the dust tree):
  GET  /api/installed                 -> ["awake", ...]            (dirs in dust/code)
  GET  /api/ls?path=code/awake        -> [{name,type,size,mod},...]
  GET  /api/read?path=...             -> raw text
  PUT  /api/write?path=...            -> {ok:true}                 (body = content)
  POST /api/install  {name,url,force} -> git clone url into dust/code/name
  POST /api/remove   {name}           -> delete dust/code/name
"""
import http.server, socketserver, os, sys, json, shutil, subprocess, urllib.parse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))


def find_dust():
    env = os.environ.get("INGENUE_DUST")
    if env and os.path.isdir(os.path.join(env, "code")):
        return os.path.realpath(env)
    up = os.path.realpath(os.path.join(HERE, "..", ".."))      # dust/code/ingenue -> dust
    if os.path.isdir(os.path.join(up, "code")):
        return up
    for d in (os.path.expanduser("~/dust"), "/home/we/dust",
              "/storage/roms/ports/norns/data/dust"):
        if os.path.isdir(os.path.join(d, "code")):
            return os.path.realpath(d)
    return up


DUST = find_dust()
CODE = os.path.join(DUST, "code")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7777


def safe(rel):
    rel = urllib.parse.unquote(rel or "").lstrip("/")
    full = os.path.realpath(os.path.join(DUST, rel))
    root = os.path.realpath(DUST)
    if full != root and not full.startswith(root + os.sep):
        raise ValueError("path escapes dust")
    return full


def safe_script_dir(name):
    name = (name or "").strip().strip("/")
    if not name or "/" in name or name in (".", ".."):
        raise ValueError("bad script name")
    full = os.path.realpath(os.path.join(CODE, name))
    if os.path.dirname(full) != os.path.realpath(CODE):
        raise ValueError("script escapes dust/code")
    return full, name


def listing(full):
    out = []
    for name in sorted(os.listdir(full)):
        p = os.path.join(full, name)
        try:
            st = os.stat(p)
            out.append({"name": name, "type": "dir" if os.path.isdir(p) else "file",
                        "size": st.st_size, "mod": datetime.date.fromtimestamp(st.st_mtime).isoformat()})
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
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _q(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except Exception:
            return {"_raw": raw}

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/installed":
                return self._json(sorted(d for d in os.listdir(CODE)
                                         if os.path.isdir(os.path.join(CODE, d))
                                         and not d.startswith(".") and d != "ingenue"))
            if path == "/api/ls":
                return self._json(listing(safe(self._q().get("path", [""])[0])))
            if path == "/api/read":
                with open(safe(self._q().get("path", [""])[0]), "r", encoding="utf-8", errors="replace") as f:
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
        if urllib.parse.urlparse(self.path).path != "/api/write":
            return self._json({"error": "not found"}, 404)
        try:
            full = safe(self._q().get("path", [""])[0])
            data = self._body().get("_raw", b"")
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                f.write(data)
            return self._json({"ok": True, "bytes": len(data)})
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        b = self._body()
        try:
            if path == "/api/remove":
                full, name = safe_script_dir(b.get("name"))
                if not os.path.isdir(full):
                    return self._json({"error": f"{name} is not installed"}, 404)
                shutil.rmtree(full)
                return self._json({"ok": True, "removed": name})
            if path == "/api/install":
                full, name = safe_script_dir(b.get("name"))
                url = (b.get("url") or "").strip()
                if not url.startswith(("http://", "https://", "git@")):
                    return self._json({"error": "no/invalid git url"}, 400)
                if os.path.isdir(full):
                    if b.get("force"):
                        shutil.rmtree(full)
                    else:
                        return self._json({"error": f"{name} already installed"}, 409)
                r = subprocess.run(["git", "clone", "--depth", "1", url, full],
                                   capture_output=True, text=True, timeout=180)
                if r.returncode != 0:
                    return self._json({"error": "git clone failed", "log": (r.stderr or r.stdout)[-800:]}, 500)
                return self._json({"ok": True, "installed": name,
                                   "log": (r.stderr or r.stdout)[-400:] or f"cloned {url}"})
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except subprocess.TimeoutExpired:
            return self._json({"error": "git clone timed out"}, 504)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)
        return self._json({"error": "not found"}, 404)

    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), H) as httpd:
    print(f"ingenue backend on 0.0.0.0:{PORT}  (dust={DUST}, exists={os.path.isdir(CODE)})", flush=True)
    httpd.serve_forever()
