#!/usr/bin/env python3
"""Serve Ingenue through a trustworthy localhost origin for Browser MIDI.

Run this file on the computer connected to the MIDI controller, not on norns:

    python3 midi-local.py --device norns.local

The proxy binds only to 127.0.0.1. Static UI requests are fetched from norns,
while browser realtime connects directly to the configured device host.
"""
from __future__ import annotations

import argparse
import http.client
import http.server
import json
import socket
import urllib.parse
import webbrowser
from dataclasses import dataclass

DEFAULT_DEVICE = "norns.local"
DEFAULT_DEVICE_PORT = 7777
DEFAULT_REALTIME_PORT = 7778
DEFAULT_LOCAL_PORT = 7780
BRIDGE_PREFIX = "/__ingenue_midi_bridge__"
HOP_BY_HOP_HEADERS = frozenset({
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailer", "transfer-encoding", "upgrade",
})


def normalize_device(value):
    raw = str(value or "").strip()
    if not raw or any(character.isspace() for character in raw):
        raise ValueError("device must be a hostname or IP address")
    try:
        parsed = urllib.parse.urlsplit("//" + raw)
    except ValueError as error:
        raise ValueError("invalid device host: {}".format(error))
    if parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment or not parsed.hostname:
        raise ValueError("device must not contain a scheme, path, query, or credentials")
    if parsed.port is not None:
        raise ValueError("use --device-port instead of embedding a port in --device")
    return parsed.hostname


def valid_port(value):
    try:
        port = int(value)
    except (TypeError, ValueError):
        raise argparse.ArgumentTypeError("port must be an integer")
    if port < 1 or port > 65535:
        raise argparse.ArgumentTypeError("port must be between 1 and 65535")
    return port


def query_host(host):
    return "[{}]".format(host) if ":" in host and not host.startswith("[") else host


@dataclass(frozen=True)
class BridgeConfig:
    device: str = DEFAULT_DEVICE
    device_port: int = DEFAULT_DEVICE_PORT
    realtime_port: int = DEFAULT_REALTIME_PORT
    local_port: int = DEFAULT_LOCAL_PORT
    timeout: float = 8.0

    def launch_path(self):
        query = urllib.parse.urlencode({
            "device": query_host(self.device),
            "rt": self.realtime_port,
            "bridge": "localhost",
        })
        return "/midi.html?{}".format(query)

    def launch_url(self):
        return "http://localhost:{}{}".format(self.local_port, self.launch_path())


class MidiBridgeHandler(http.server.BaseHTTPRequestHandler):
    server_version = "IngenueMidiBridge/1"
    protocol_version = "HTTP/1.1"

    @property
    def config(self):
        return self.server.config

    def log_message(self, format_value, *args):
        print("midi-local: " + (format_value % args), flush=True)

    def do_GET(self):
        self._handle(head_only=False)

    def do_HEAD(self):
        self._handle(head_only=True)

    def do_POST(self):
        self.send_error(405, "localhost MIDI bridge is read-only")

    def do_PUT(self):
        self.send_error(405, "localhost MIDI bridge is read-only")

    def do_DELETE(self):
        self.send_error(405, "localhost MIDI bridge is read-only")

    def _handle(self, head_only):
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path == BRIDGE_PREFIX + "/health":
            payload = json.dumps({
                "ok": True,
                "device": self.config.device,
                "device_port": self.config.device_port,
                "realtime_port": self.config.realtime_port,
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head_only:
                self.wfile.write(payload)
            return

        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if parsed.path in ("", "/") or (parsed.path == "/midi.html" and "device" not in query):
            self.send_response(302)
            self.send_header("Location", self.config.launch_path())
            self.send_header("Content-Length", "0")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            return

        upstream_query = []
        for key, values in query.items():
            if key in {"device", "rt", "bridge"}:
                continue
            for value in values:
                upstream_query.append((key, value))
        upstream_path = parsed.path or "/"
        if upstream_query:
            upstream_path += "?" + urllib.parse.urlencode(upstream_query)
        self._proxy(upstream_path, head_only)

    def _proxy(self, upstream_path, head_only):
        connection = http.client.HTTPConnection(
            self.config.device,
            self.config.device_port,
            timeout=self.config.timeout,
        )
        try:
            method = "HEAD" if head_only else "GET"
            connection.request(method, upstream_path, headers={
                "Host": "{}:{}".format(query_host(self.config.device), self.config.device_port),
                "Accept": self.headers.get("Accept", "*/*"),
                "Accept-Encoding": "identity",
                "User-Agent": "Ingenue-MIDI-Local/1",
                "Connection": "close",
            })
            response = connection.getresponse()
            self.send_response(response.status, response.reason)
            for name, value in response.getheaders():
                lower = name.lower()
                if lower in HOP_BY_HOP_HEADERS or lower in {"server", "date"}:
                    continue
                self.send_header(name, value)
            self.send_header("X-Ingenue-MIDI-Bridge", "localhost")
            if upstream_path.startswith("/midi.html"):
                self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if not head_only:
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (OSError, http.client.HTTPException, socket.timeout) as error:
            if not self.wfile.closed:
                self.send_error(502, "could not reach Ingenue at {}:{} ({})".format(
                    self.config.device, self.config.device_port, error
                ))
        finally:
            connection.close()


class MidiBridgeServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, config):
        self.config = config
        http.server.ThreadingHTTPServer.__init__(
            self, ("127.0.0.1", config.local_port), MidiBridgeHandler
        )


def build_parser():
    parser = argparse.ArgumentParser(
        description="Expose Ingenue MIDI Learn on a trustworthy localhost origin."
    )
    parser.add_argument("--device", default=DEFAULT_DEVICE, help="norns hostname or IP")
    parser.add_argument("--device-port", type=valid_port, default=DEFAULT_DEVICE_PORT)
    parser.add_argument("--realtime-port", type=valid_port, default=DEFAULT_REALTIME_PORT)
    parser.add_argument("--local-port", type=valid_port, default=DEFAULT_LOCAL_PORT)
    parser.add_argument("--open", action="store_true", help="open the MIDI page in the default browser")
    return parser


def configuration_from_args(args):
    return BridgeConfig(
        device=normalize_device(args.device),
        device_port=args.device_port,
        realtime_port=args.realtime_port,
        local_port=args.local_port,
    )


def main(argv=None):
    parser = build_parser()
    try:
        config = configuration_from_args(parser.parse_args(argv))
    except ValueError as error:
        parser.error(str(error))
    server = MidiBridgeServer(config)
    print("Ingenue MIDI localhost bridge", flush=True)
    print("  device: http://{}:{}".format(query_host(config.device), config.device_port), flush=True)
    print("  browser: {}".format(config.launch_url()), flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    if parser.parse_args(argv).open:
        webbrowser.open(config.launch_url())
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
