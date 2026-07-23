#!/usr/bin/env python3
"""Ingenue launcher: legacy HTTP API plus protocol-v1 realtime transport."""
import os
import sys
import threading

import server_legacy
from ensure_mod_enabled import ensure_enabled
from realtime_secure import serve_realtime


def _ensure_lua_adapter():
    path = os.path.join(server_legacy.DUST, "data", "system.mods")
    try:
        changed, _mods = ensure_enabled(path, "ingenue")
        if os.getuid() == 0:
            uid, gid, _name, _home = server_legacy.target_owner()
            try:
                os.lchown(path, uid, gid)
            except OSError:
                pass
        if changed:
            print("ingenue Lua adapter enabled; restart norns/matron once to load it", flush=True)
    except (OSError, ValueError) as error:
        # The editor and legacy API remain useful even if an unusual port cannot
        # persist system.mods. Realtime commands will time out honestly instead
        # of being acknowledged before Lua applies them.
        print("ingenue could not enable Lua adapter: {}".format(error), flush=True)


def _run_realtime(port):
    try:
        serve_realtime("0.0.0.0", port, server_legacy)
    except OSError as error:
        # Keep the established HTTP/editor service usable if optional realtime
        # ports are occupied on an unusual norns port build.
        print("ingenue realtime unavailable on :{}: {}".format(port, error), flush=True)


def main():
    http_port = int(sys.argv[1]) if len(sys.argv) > 1 else 7777
    realtime_port = int(os.environ.get("INGENUE_REALTIME_PORT", http_port + 1))
    _ensure_lua_adapter()
    threading.Thread(target=_run_realtime, args=(realtime_port,), daemon=True).start()
    server_legacy.main()


if __name__ == "__main__":
    main()
