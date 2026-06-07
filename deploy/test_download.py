#!/usr/bin/env python3
"""Smoke test for GET /api/download (the file-view download fix).

Spins up server.py against a throwaway dust tree and exercises:
  - single text file  -> attachment, exact bytes
  - single BINARY file -> attachment, byte-exact (the old /api/read would corrupt this)
  - multi-select       -> zip containing both
  - folder select      -> zip with nested structure
  - path escape        -> rejected (no dust breakout)

Run:  python3 deploy/test_download.py
"""
import io, os, sys, time, zipfile, tempfile, subprocess, urllib.request, urllib.error, socket

HERE = os.path.dirname(os.path.abspath(__file__))
SERVER = os.path.join(HERE, "..", "web", "server.py")


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def get(url):
    return urllib.request.urlopen(url, timeout=5)


def main():
    dust = tempfile.mkdtemp(prefix="ingenue-dl-")
    code = os.path.join(dust, "code", "awake")
    os.makedirs(code)
    # text file
    open(os.path.join(dust, "hello.txt"), "w").write("hello norns\n")
    # binary file with bytes that utf-8 text mode would mangle
    binblob = bytes(range(256)) * 4
    open(os.path.join(dust, "sample.wav"), "wb").write(binblob)
    # nested file inside a folder
    open(os.path.join(code, "awake.lua"), "w").write("-- awake\n")

    port = free_port()
    env = {**os.environ, "INGENUE_DUST": dust}
    proc = subprocess.Popen([sys.executable, SERVER, str(port)], env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = "http://127.0.0.1:%d" % port
    try:
        # wait for boot
        for _ in range(50):
            try:
                get(base + "/api/ls?path="); break
            except Exception:
                time.sleep(0.1)
        fails = []

        # 1) single text file -> attachment, exact bytes
        r = get(base + "/api/download?path=&name=hello.txt")
        cd = r.headers.get("Content-Disposition", "")
        body = r.read()
        if "attachment" not in cd or "hello.txt" not in cd:
            fails.append("single-file: missing attachment disposition: %r" % cd)
        if body != b"hello norns\n":
            fails.append("single-file: body mismatch: %r" % body)

        # 2) single binary file -> byte-exact (regression guard vs text-mode /api/read)
        r = get(base + "/api/download?path=&name=sample.wav")
        body = r.read()
        if body != binblob:
            fails.append("binary-file: corrupted (got %d bytes, want %d)" % (len(body), len(binblob)))

        # 3) multi-select -> zip with both files
        r = get(base + "/api/download?path=&name=hello.txt&name=sample.wav")
        if "zip" not in r.headers.get("Content-Type", ""):
            fails.append("multi: not a zip: %r" % r.headers.get("Content-Type"))
        z = zipfile.ZipFile(io.BytesIO(r.read()))
        if set(z.namelist()) != {"hello.txt", "sample.wav"}:
            fails.append("multi: wrong zip contents: %r" % z.namelist())
        elif z.read("sample.wav") != binblob:
            fails.append("multi: binary in zip corrupted")

        # 4) folder select -> zip preserving nested path
        r = get(base + "/api/download?path=code&name=awake")
        z = zipfile.ZipFile(io.BytesIO(r.read()))
        if "awake/awake.lua" not in z.namelist():
            fails.append("folder: nested path missing: %r" % z.namelist())

        # 5) path escape -> rejected
        try:
            get(base + "/api/download?path=&name=" + urllib.parse.quote("../../etc/hosts"))
            fails.append("escape: traversal was NOT rejected")
        except urllib.error.HTTPError as e:
            if e.code not in (400, 404):
                fails.append("escape: unexpected status %d" % e.code)

        if fails:
            print("FAIL:")
            for f in fails:
                print("  -", f)
            return 1
        print("PASS: all download cases (single/binary/multi/folder/escape)")
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()
        shutil_rmtree(dust)


def shutil_rmtree(p):
    import shutil
    shutil.rmtree(p, ignore_errors=True)


if __name__ == "__main__":
    import urllib.parse  # noqa: E402 (used in escape test)
    sys.exit(main())
