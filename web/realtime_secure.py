#!/usr/bin/env python3
"""Origin-checked production wrapper for the Ingenue realtime server."""
import os
import urllib.parse

try:
    from .realtime_bridge import StateBridge
    from .realtime_midi import MidiAppliedAdapter, MidiAppliedHub
    from .realtime_server import RealtimeRequestHandler, ThreadingRealtimeServer
except ImportError:
    from realtime_bridge import StateBridge
    from realtime_midi import MidiAppliedAdapter, MidiAppliedHub
    from realtime_server import RealtimeRequestHandler, ThreadingRealtimeServer


def _default_port(scheme):
    return 443 if scheme == "https" else 80


def _split_host(host_header):
    try:
        return urllib.parse.urlsplit("//" + (host_header or "")).hostname
    except ValueError:
        return None


def origin_allowed(origin, host_header, http_port, extra_origins=None):
    """Allow only the Ingenue HTTP origin for this host, or an exact override."""
    if not origin or origin == "null":
        return False
    normalized = origin.rstrip("/")
    if normalized in set(extra_origins or ()):
        return True
    try:
        parsed = urllib.parse.urlsplit(normalized)
        origin_port = parsed.port or _default_port(parsed.scheme)
    except ValueError:
        return False
    if parsed.scheme != "http" or parsed.username or parsed.password:
        return False
    request_host = _split_host(host_header)
    return bool(request_host and parsed.hostname and
                parsed.hostname.lower() == request_host.lower() and
                origin_port == int(http_port))


class OriginCheckedHandler(RealtimeRequestHandler):
    def _read_request(self):
        request = RealtimeRequestHandler._read_request(self)
        if request is None:
            return None
        method, path, headers = request
        if path == "/realtime":
            allowed = origin_allowed(
                headers.get("origin"),
                headers.get("host"),
                self.server.http_port,
                self.server.allowed_origins,
            )
            if not allowed:
                self._http(403, b"forbidden websocket origin\n")
                return None
        return method, path, headers


class OriginCheckedServer(ThreadingRealtimeServer):
    def __init__(self, address, hub, http_port, allowed_origins):
        self.http_port = int(http_port)
        self.allowed_origins = frozenset(allowed_origins)
        import socketserver
        socketserver.TCPServer.__init__(self, address, OriginCheckedHandler)


def serve_realtime(host, port, legacy):
    http_port = int(getattr(legacy, "PORT", 7777))
    state_port = int(os.environ.get("INGENUE_STATE_PORT", int(port) + 1))
    allowed = [item.strip().rstrip("/") for item in
               os.environ.get("INGENUE_REALTIME_ORIGINS", "").split(",")
               if item.strip()]
    adapter = MidiAppliedAdapter(legacy, realtime_port=port, state_port=state_port)
    hub = MidiAppliedHub(adapter)
    bridge = StateBridge(hub, "127.0.0.1", state_port)
    bridge.start()
    try:
        with OriginCheckedServer((host, port), hub, http_port, allowed) as server:
            print("ingenue realtime on {}:{}/realtime (Lua-applied, MIDI-ready, origin-checked)".format(host, port), flush=True)
            server.serve_forever()
    finally:
        bridge.close()
