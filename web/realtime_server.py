#!/usr/bin/env python3
"""Stdlib-only realtime WebSocket endpoint for Ingenue protocol v1.

The endpoint deliberately runs beside the existing HTTP API. It owns browser
session semantics (subscribe/snapshot/delta/ack/reject/heartbeat) while matron
and SuperCollider remain authoritative for timing and audio.

The module intentionally stays compatible with Python 3.7: stock and ported
norns images do not all ship the same Python minor version.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import re
import select
import socket
import socketserver
import struct
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple, Union

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1_048_576
HEARTBEAT_INTERVAL = 2.0
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PARAM_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
CHANNELS = frozenset({"device", "control"})


class RealtimeError(Exception):
    """Protocol or transport input is invalid."""


def websocket_accept(key):
    raw = (key.strip() + WS_GUID).encode("ascii")
    return base64.b64encode(hashlib.sha1(raw).digest()).decode("ascii")


def encode_frame(payload, opcode=0x1):
    # type: (Union[bytes, str], int) -> bytes
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    n = len(payload)
    if n > MAX_FRAME_BYTES:
        raise RealtimeError("frame too large")
    head = bytes([0x80 | (opcode & 0x0F)])
    if n < 126:
        head += bytes([n])
    elif n <= 0xFFFF:
        head += bytes([126]) + struct.pack(">H", n)
    else:
        head += bytes([127]) + struct.pack(">Q", n)
    return head + payload


def _read_exact(sock, n):
    # type: (socket.socket, int) -> bytes
    chunks = []  # type: List[bytes]
    left = n
    while left:
        chunk = sock.recv(left)
        if not chunk:
            raise EOFError("socket closed")
        chunks.append(chunk)
        left -= len(chunk)
    return b"".join(chunks)


def read_frame(sock):
    # type: (socket.socket) -> Tuple[int, bytes]
    first, second = _read_exact(sock, 2)
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if not fin:
        raise RealtimeError("fragmented frames are not supported")
    if not masked:
        raise RealtimeError("client frames must be masked")
    if length == 126:
        length = struct.unpack(">H", _read_exact(sock, 2))[0]
    elif length == 127:
        length = struct.unpack(">Q", _read_exact(sock, 8))[0]
    if length > MAX_FRAME_BYTES:
        raise RealtimeError("frame too large")
    mask = _read_exact(sock, 4)
    payload = _read_exact(sock, length)
    return opcode, bytes(value ^ mask[i % 4] for i, value in enumerate(payload))


def validate_envelope(message):
    # type: (Any) -> Dict[str, Any]
    if not isinstance(message, dict):
        raise RealtimeError("message must be an object")
    if message.get("v") != PROTOCOL_VERSION:
        raise RealtimeError("unsupported protocol version")
    if message.get("type") not in {
        "hello", "subscribe", "command", "resync", "heartbeat"
    }:
        raise RealtimeError("unsupported client message type")
    return message


@dataclass(eq=False)
class Peer:
    sock: socket.socket
    channels: Set[str] = field(default_factory=set)
    lock: threading.Lock = field(default_factory=threading.Lock)
    alive: bool = True

    def send(self, message):
        # type: (Dict[str, Any]) -> None
        data = encode_frame(json.dumps(message, separators=(",", ":")))
        with self.lock:
            if not self.alive:
                return
            self.sock.sendall(data)

    def close(self):
        # type: () -> None
        with self.lock:
            if not self.alive:
                return
            self.alive = False
            try:
                self.sock.sendall(encode_frame(b"", opcode=0x8))
            except OSError:
                pass
            try:
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()


class LegacyAdapter:
    """Maps protocol commands to the existing Ingenue OSC implementation."""

    def __init__(self, legacy, realtime_port=None, now=time.time):
        # type: (Any, Optional[int], Callable[[], float]) -> None
        self.legacy = legacy
        self.realtime_port = int(realtime_port if realtime_port is not None else getattr(legacy, "PORT", 7777) + 1)
        self.now = now

    def snapshot(self):
        # type: () -> Dict[str, Any]
        host = socket.gethostname()
        return {
            "device": {
                "host": host,
                "http_port": int(getattr(self.legacy, "PORT", 7777)),
                "realtime_port": self.realtime_port,
                "installed_sha": self.legacy.installed_sha(),
                "dust": getattr(self.legacy, "DUST", None),
            },
            "control": dict(getattr(self.legacy, "_CTL", {})),
        }

    def execute(self, command):
        # type: (Dict[str, Any]) -> Tuple[List[Dict[str, Any]], Any]
        if not isinstance(command, dict):
            raise RealtimeError("command payload must be an object")
        target = command.get("target")
        action = command.get("action")
        args = command.get("args") or {}
        if not isinstance(args, dict):
            raise RealtimeError("command args must be an object")

        if target == "system" and action == "ping":
            return [], {"pong": self.now()}
        if target == "control" and action == "enc":
            n = _bounded_int(args.get("n"), "encoder", 1, 3)
            delta = _bounded_int(args.get("d"), "delta", -127, 127)
            self.legacy.osc_send("/remote/enc", "ii", n, delta)
            last = {"k": "enc", "n": n, "d": delta}
        elif target == "control" and action == "key":
            n = _bounded_int(args.get("n"), "key", 1, 3)
            z = _bounded_int(args.get("z"), "key state", 0, 1)
            self.legacy.osc_send("/remote/key", "ii", n, z)
            last = {"k": "key", "n": n, "z": z}
        elif target == "param" and action == "set":
            param_id = str(args.get("id") or "")
            if not PARAM_ID_RE.fullmatch(param_id):
                raise RealtimeError("invalid param id")
            value = args.get("value")
            if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
                raise RealtimeError("param value must be finite")
            self.legacy.osc_send("/param/" + param_id, "f", float(value))
            last = {"k": "param", "id": param_id, "v": float(value)}
        else:
            raise RealtimeError("unsupported command")

        ctl = self.legacy._CTL
        ctl["hits"] = int(ctl.get("hits", 0)) + 1
        ctl["last"] = last
        ctl["ts"] = self.now()
        operations = [
            {"op": "set", "path": ["control", "hits"], "value": ctl["hits"]},
            {"op": "set", "path": ["control", "last"], "value": last},
            {"op": "set", "path": ["control", "ts"], "value": ctl["ts"]},
        ]
        return operations, {"applied": last}


def _bounded_int(value, label, low, high):
    # type: (Any, str, int, int) -> int
    if isinstance(value, bool):
        raise RealtimeError("{} must be an integer".format(label))
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise RealtimeError("{} must be an integer".format(label))
    if parsed != value or parsed < low or parsed > high:
        raise RealtimeError("{} must be between {} and {}".format(label, low, high))
    return parsed


class RealtimeHub:
    def __init__(self, adapter):
        # type: (Any) -> None
        self.adapter = adapter
        self.revision = 0
        self.peers = set()  # type: Set[Peer]
        self.lock = threading.RLock()

    def register(self, peer):
        # type: (Peer) -> None
        with self.lock:
            self.peers.add(peer)

    def unregister(self, peer):
        # type: (Peer) -> None
        with self.lock:
            self.peers.discard(peer)

    def handle(self, peer, raw):
        # type: (Peer, Any) -> None
        try:
            message = validate_envelope(raw)
            kind = message["type"]
            if kind == "hello":
                peer.send({
                    "v": PROTOCOL_VERSION,
                    "type": "hello",
                    "server": "ingenue",
                    "capabilities": {
                        "channels": sorted(CHANNELS),
                        "commands": ["control.enc", "control.key", "param.set", "system.ping"],
                    },
                })
            elif kind == "subscribe":
                peer.channels = _channels(message.get("channels"))
                peer.send(self.snapshot(peer.channels))
            elif kind == "resync":
                peer.send(self.snapshot(peer.channels or set(CHANNELS)))
            elif kind == "heartbeat":
                peer.send({"v": PROTOCOL_VERSION, "type": "heartbeat", "ts": time.time()})
            elif kind == "command":
                self._command(peer, message)
        except RealtimeError as error:
            command_id = raw.get("id") if isinstance(raw, dict) else None
            peer.send({
                "v": PROTOCOL_VERSION,
                "type": "reject",
                "id": command_id or "invalid",
                "error": str(error),
            })

    def snapshot(self, channels):
        # type: (Iterable[str]) -> Dict[str, Any]
        requested = set(channels) or set(CHANNELS)
        with self.lock:
            state = self.adapter.snapshot()
            revision = self.revision
        filtered = {name: state[name] for name in requested if name in state}
        return {"v": PROTOCOL_VERSION, "type": "snapshot", "rev": revision, "state": filtered}

    def _command(self, peer, message):
        # type: (Peer, Dict[str, Any]) -> None
        command_id = message.get("id")
        if not isinstance(command_id, str) or not command_id:
            raise RealtimeError("command id is required")
        with self.lock:
            operations, result = self.adapter.execute(message.get("command"))
            if operations:
                self.revision += 1
            revision = self.revision
        if operations:
            delta = {"v": PROTOCOL_VERSION, "type": "delta", "rev": revision, "operations": operations}
            self.broadcast(delta, channel="control")
        peer.send({"v": PROTOCOL_VERSION, "type": "ack", "id": command_id, "rev": revision, "result": result})

    def broadcast(self, message, channel):
        # type: (Dict[str, Any], str) -> None
        with self.lock:
            peers = list(self.peers)
        for peer in peers:
            if peer.alive and channel in peer.channels:
                try:
                    peer.send(message)
                except OSError:
                    self.unregister(peer)


def _channels(raw):
    # type: (Any) -> Set[str]
    if raw is None:
        return set(CHANNELS)
    if not isinstance(raw, list):
        raise RealtimeError("channels must be an array")
    requested = {str(item) for item in raw}
    unknown = requested - CHANNELS
    if unknown:
        raise RealtimeError("unsupported channels: " + ", ".join(sorted(unknown)))
    return requested or set(CHANNELS)


class RealtimeRequestHandler(socketserver.BaseRequestHandler):
    def handle(self):
        # type: () -> None
        peer = None  # type: Optional[Peer]
        try:
            request = self._read_request()
            if request is None:
                return
            method, path, headers = request
            connection_tokens = {item.strip().lower() for item in headers.get("connection", "").split(",")}
            if method != "GET" or path != "/realtime":
                self._http(404, b"not found\n")
                return
            if headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in connection_tokens:
                self._http(426, b"websocket upgrade required\n", {"Upgrade": "websocket"})
                return
            key = headers.get("sec-websocket-key")
            if not key:
                self._http(400, b"missing websocket key\n")
                return
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                "Sec-WebSocket-Accept: {}\r\n\r\n".format(websocket_accept(key))
            ).encode("ascii")
            self.request.sendall(response)
            peer = Peer(self.request)
            self.server.hub.register(peer)  # type: ignore[attr-defined]
            last_heartbeat = 0.0
            while peer.alive:
                now = time.monotonic()
                if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                    peer.send({"v": PROTOCOL_VERSION, "type": "heartbeat", "ts": time.time()})
                    last_heartbeat = now
                readable, _, _ = select.select([self.request], [], [], 0.25)
                if not readable:
                    continue
                opcode, payload = read_frame(self.request)
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    with peer.lock:
                        self.request.sendall(encode_frame(payload, opcode=0xA))
                    continue
                if opcode != 0x1:
                    raise RealtimeError("only text frames are supported")
                try:
                    message = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    raise RealtimeError("invalid JSON frame")
                self.server.hub.handle(peer, message)  # type: ignore[attr-defined]
        except (EOFError, ConnectionError, OSError, RealtimeError):
            pass
        finally:
            if peer is not None:
                self.server.hub.unregister(peer)  # type: ignore[attr-defined]
                peer.close()

    def _read_request(self):
        # type: () -> Optional[Tuple[str, str, Dict[str, str]]]
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = self.request.recv(4096)
            if not chunk:
                return None
            data.extend(chunk)
            if len(data) > 16384:
                self._http(431, b"request headers too large\n")
                return None
        head = bytes(data).split(b"\r\n\r\n", 1)[0].decode("iso-8859-1")
        lines = head.split("\r\n")
        parts = lines[0].split()
        if len(parts) != 3:
            self._http(400, b"bad request\n")
            return None
        headers = {}  # type: Dict[str, str]
        for line in lines[1:]:
            name, sep, value = line.partition(":")
            if sep:
                headers[name.strip().lower()] = value.strip()
        return parts[0], parts[1], headers

    def _http(self, status, body, extra=None):
        # type: (int, bytes, Optional[Dict[str, str]]) -> None
        reason = {
            400: "Bad Request",
            404: "Not Found",
            426: "Upgrade Required",
            431: "Request Header Fields Too Large",
        }.get(status, "Error")
        headers = {
            "Content-Type": "text/plain; charset=utf-8",
            "Content-Length": str(len(body)),
            "Connection": "close",
        }
        headers.update(extra or {})
        raw = ["HTTP/1.1 {} {}".format(status, reason)] + ["{}: {}".format(k, v) for k, v in headers.items()] + ["", ""]
        self.request.sendall("\r\n".join(raw).encode("ascii") + body)


class ThreadingRealtimeServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, hub):
        # type: (Tuple[str, int], RealtimeHub) -> None
        self.hub = hub
        socketserver.TCPServer.__init__(self, address, RealtimeRequestHandler)


def serve_realtime(host, port, legacy):
    # type: (str, int, Any) -> None
    hub = RealtimeHub(LegacyAdapter(legacy, realtime_port=port))
    with ThreadingRealtimeServer((host, port), hub) as server:
        print("ingenue realtime on {}:{}/realtime".format(host, port), flush=True)
        server.serve_forever()
