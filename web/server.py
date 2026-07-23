#!/usr/bin/env python3
"""Ingenue launcher: legacy HTTP API on PORT, protocol-v1 WebSocket on PORT+1."""
import os
import sys
import threading

import server_legacy
from realtime_secure import serve_realtime


def _run_realtime(port):
    try:
        serve_realtime("0.0.0.0", port, server_legacy)
    except OSError as error:
        print("ingenue realtime unavailable on :{}: {}".format(port, error), flush=True)


def main():
    http_port = int(sys.argv[1]) if len(sys.argv) > 1 else 7777
    realtime_port = int(os.environ.get("INGENUE_REALTIME_PORT", http_port + 1))
    threading.Thread(target=_run_realtime, args=(realtime_port,), daemon=True).start()
    server_legacy.main()


if __name__ == "__main__":
    main()
