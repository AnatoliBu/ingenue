#!/usr/bin/env python3
"""Ingenue protocol-v1 WebSocket service and applied-command matron bridge.

Kept stdlib-only and Python-3.7-compatible for stock norns and ports.
"""
from __future__ import annotations

import base64
import hashlib
import json
import math
import os
import re
import select
import socket
import socketserver
import struct
import threading
import time
from dataclasses import dataclass, field

PROTOCOL_VERSION = 1
MAX_FRAME_BYTES = 1_048_576
HEARTBEAT_INTERVAL = 2.0
COMMAND_TIMEOUT = 2.0
ADAPTER_STALE_AFTER = 5.0
PENDING_LIMIT = 256
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
PARAM_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")
CHANNELS = frozenset({"device", "control", "grid"})


class RealtimeError(Exception):
    pass


def websocket_accept(key):
    raw = (key.strip() + WS_GUID).encode("ascii")
    return base64.b64encode(hashlib.sha1(raw).digest()).decode("ascii")


def encode_frame(payload, opcode=0x1):
    if isinstance(payload, str):
        payload = payload.encode("utf-8")
    size = len(payload)
    if size > MAX_FRAME_BYTES:
        raise RealtimeError("frame too large")
    head = bytes([0x80 | (opcode & 0x0F)])
    if size < 126:
        head += bytes([size])
    elif size <= 0xFFFF:
        head += bytes([126]) + struct.pack(">H", size)
    else:
        head += bytes([127]) + struct.pack(">Q", size)
    return head + payload


def _read_exact(sock, size):
    chunks = []
    while size:
        chunk = sock.recv(size)
        if not chunk:
            raise EOFError("socket closed")
        chunks.append(chunk)
        size -= len(chunk)
    return b"".join(chunks)


def read_frame(sock):
    first, second = _read_exact(sock, 2)
    if not first & 0x80:
        raise RealtimeError("fragmented frames are not supported")
    if not second & 0x80:
        raise RealtimeError("client frames must be masked")
    opcode = first & 0x0F
    size = second & 0x7F
    if size == 126:
        size = struct.unpack(">H", _read_exact(sock, 2))[0]
    elif size == 127:
        size = struct.unpack(">Q", _read_exact(sock, 8))[0]
    if size > MAX_FRAME_BYTES:
        raise RealtimeError("frame too large")
    mask = _read_exact(sock, 4)
    payload = _read_exact(sock, size)
    return opcode, bytes(value ^ mask[i % 4] for i, value in enumerate(payload))


def validate_envelope(message):
    if not isinstance(message, dict):
        raise RealtimeError("message must be an object")
    if message.get("v") != PROTOCOL_VERSION:
        raise RealtimeError("unsupported protocol version")
    if message.get("type") not in {"hello", "subscribe", "command", "resync", "heartbeat"}:
        raise RealtimeError("unsupported client message type")
    return message


@dataclass(eq=False)
class Peer:
    sock: socket.socket
    channels: set = field(default_factory=set)
    lock: threading.Lock = field(default_factory=threading.Lock)
    alive: bool = True

    def send(self, message):
        data = encode_frame(json.dumps(message, separators=(",", ":")))
        with self.lock:
            if self.alive:
                self.sock.sendall(data)

    def close(self):
        with self.lock:
            if not self.alive:
                return
            self.alive = False
            try:
                self.sock.sendall(encode_frame(b"", 0x8))
                self.sock.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            self.sock.close()


@dataclass
class PreparedCommand:
    target: str
    action: str
    args: dict
    last: object
    result: object
    channels: set
    requires_matron: bool = True


@dataclass
class PendingCommand:
    wire_id: str
    client_id: str
    peer: Peer
    prepared: PreparedCommand
    created_at: float


def _bounded_int(value, label, low, high):
    if isinstance(value, bool):
        raise RealtimeError("{} must be an integer".format(label))
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise RealtimeError("{} must be an integer".format(label))
    if parsed != value or not low <= parsed <= high:
        raise RealtimeError("{} must be between {} and {}".format(label, low, high))
    return parsed


class LegacyAdapter:
    """Validates commands and stores the latest state confirmed by matron."""

    def __init__(self, legacy, realtime_port=None, reply_port=10112, now=time.time):
        self.legacy = legacy
        self.realtime_port = int(realtime_port if realtime_port is not None else getattr(legacy, "PORT", 7777) + 1)
        self.reply_port = int(reply_port)
        self.now = now
        self.adapter_online = False
        self.adapter_version = None
        self.adapter_last_seen = None
        self.grid = {"port": 1, "cols": 16, "rows": 8, "levels": "0" * 128,
                     "last_key": None, "updated_at": 0}

    def _adapter_status(self):
        dust = getattr(self.legacy, "DUST", None)
        mod_path = os.path.join(dust, "code", "ingenue", "lib", "mod.lua") if dust else None
        enabled = None
        reader = getattr(self.legacy, "read_enabled_mods", None)
        if callable(reader):
            try:
                enabled = "ingenue" in set(reader())
            except Exception:
                pass
        return {"installed": bool(mod_path and os.path.isfile(mod_path)), "enabled": enabled,
                "online": self.adapter_online, "version": self.adapter_version,
                "last_seen": self.adapter_last_seen, "reply_port": self.reply_port}

    def snapshot(self):
        return {
            "device": {"host": socket.gethostname(), "http_port": int(getattr(self.legacy, "PORT", 7777)),
                       "realtime_port": self.realtime_port, "installed_sha": self.legacy.installed_sha(),
                       "dust": getattr(self.legacy, "DUST", None), "adapter": self._adapter_status()},
            "control": dict(getattr(self.legacy, "_CTL", {})),
            "grid": dict(self.grid),
        }

    def prepare(self, command):
        if not isinstance(command, dict):
            raise RealtimeError("command payload must be an object")
        target, action = command.get("target"), command.get("action")
        args = command.get("args") or {}
        if not isinstance(args, dict):
            raise RealtimeError("command args must be an object")
        if target == "system" and action == "ping":
            return PreparedCommand(target, action, {}, None, {"pong": self.now()}, set(), False)
        if target == "control" and action == "enc":
            clean = {"n": _bounded_int(args.get("n"), "encoder", 1, 3),
                     "d": _bounded_int(args.get("d"), "delta", -127, 127)}
            last = {"k": "enc", "n": clean["n"], "d": clean["d"]}
            return PreparedCommand(target, action, clean, last, {"applied": last}, {"control"})
        if target == "control" and action == "key":
            clean = {"n": _bounded_int(args.get("n"), "key", 1, 3),
                     "z": _bounded_int(args.get("z"), "key state", 0, 1)}
            last = {"k": "key", "n": clean["n"], "z": clean["z"]}
            return PreparedCommand(target, action, clean, last, {"applied": last}, {"control"})
        if target == "param" and action == "set":
            param_id, value = str(args.get("id") or ""), args.get("value")
            if not PARAM_ID_RE.fullmatch(param_id):
                raise RealtimeError("invalid param id")
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise RealtimeError("param value must be finite")
            clean = {"id": param_id, "value": float(value)}
            last = {"k": "param", "id": param_id, "v": clean["value"]}
            return PreparedCommand(target, action, clean, last, {"applied": last}, {"control"})
        if target == "grid" and action == "key":
            clean = {"port": _bounded_int(args.get("port", 1), "grid port", 1, 4),
                     "x": _bounded_int(args.get("x"), "grid x", 1, 32),
                     "y": _bounded_int(args.get("y"), "grid y", 1, 16),
                     "z": _bounded_int(args.get("z"), "grid key state", 0, 1)}
            return PreparedCommand(target, action, clean, None,
                                   {"applied": {"grid_key": dict(clean)}}, {"grid"})
        raise RealtimeError("unsupported command")

    def apply(self, prepared):
        operations = []
        if prepared.last is not None:
            ctl = self.legacy._CTL
            ctl.update({"hits": int(ctl.get("hits", 0)) + 1,
                        "last": prepared.last, "ts": self.now()})
            for key in ("hits", "last", "ts"):
                operations.append({"op": "set", "path": ["control", key], "value": ctl[key]})
        if prepared.target == "grid" and prepared.action == "key":
            self.grid["last_key"] = dict(prepared.args)
            operations.append({"op": "set", "path": ["grid", "last_key"],
                               "value": dict(prepared.args)})
        return operations

    def mark_adapter(self, online, version=None):
        changed = self.adapter_online != bool(online)
        if version is not None and version != self.adapter_version:
            self.adapter_version, changed = version, True
        self.adapter_online = bool(online)
        if online:
            self.adapter_last_seen = self.now()
        return changed

    def record_grid(self, port, cols, rows, levels):
        if not 1 <= port <= 4 or not 1 <= cols <= 32 or not 1 <= rows <= 16:
            raise RealtimeError("invalid grid frame dimensions")
        levels = str(levels or "").lower()
        if len(levels) != cols * rows or any(ch not in "0123456789abcdef" for ch in levels):
            raise RealtimeError("invalid grid levels")
        if all(self.grid.get(key) == value for key, value in
               (("port", port), ("cols", cols), ("rows", rows), ("levels", levels))):
            return []
        self.grid.update({"port": port, "cols": cols, "rows": rows,
                          "levels": levels, "updated_at": self.now()})
        return [{"op": "set", "path": ["grid"], "value": dict(self.grid)}]


def _osc_read_string(packet, offset):
    end = packet.find(b"\0", offset)
    if end < 0:
        raise RealtimeError("unterminated OSC string")
    try:
        value = packet[offset:end].decode("utf-8")
    except UnicodeDecodeError:
        raise RealtimeError("invalid OSC string")
    offset = (end + 4) & ~3
    if offset > len(packet):
        raise RealtimeError("truncated OSC string")
    return value, offset


def decode_osc(packet):
    address, offset = _osc_read_string(packet, 0)
    tags, offset = _osc_read_string(packet, offset)
    if not tags.startswith(","):
        raise RealtimeError("invalid OSC typetags")
    args = []
    for tag in tags[1:]:
        if tag in "if":
            if offset + 4 > len(packet):
                raise RealtimeError("truncated OSC value")
            args.append(struct.unpack(">i" if tag == "i" else ">f", packet[offset:offset + 4])[0])
            offset += 4
        elif tag == "s":
            value, offset = _osc_read_string(packet, offset)
            args.append(value)
        else:
            raise RealtimeError("unsupported OSC typetag: " + tag)
    return address, args


class MatronBridge:
    """Localhost UDP bridge: Python dispatch → Lua execution → applied result."""

    def __init__(self, legacy, reply_port=10112, now=time.monotonic, socket_factory=socket.socket):
        self.legacy, self.reply_port, self.now = legacy, int(reply_port), now
        self.socket_factory = socket_factory
        self.sock = self.hub = self.thread = None
        self.running = False

    def start(self, hub):
        self.hub = hub
        self.sock = self.socket_factory(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.bind(("127.0.0.1", self.reply_port))
        self.sock.settimeout(0.25)
        self.running = True
        self.thread = threading.Thread(target=self._run, name="ingenue-matron-bridge", daemon=True)
        self.thread.start()

    def stop(self):
        self.running = False
        if self.sock is not None:
            try:
                self.sock.close()
            except OSError:
                pass
        if self.thread is not None:
            self.thread.join(timeout=1.0)
        self.sock = self.thread = None

    def dispatch(self, wire_id, prepared):
        payload = json.dumps(prepared.args, separators=(",", ":"), ensure_ascii=True)
        self.legacy.osc_send("/ingenue/command", "ssssi", wire_id, prepared.target,
                             prepared.action, payload, self.reply_port)

    def ping(self):
        self.legacy.osc_send("/ingenue/ping", "i", self.reply_port)

    def _run(self):
        next_ping = 0.0
        while self.running:
            now = self.now()
            if now >= next_ping:
                try:
                    self.ping()
                except OSError:
                    pass
                next_ping = now + HEARTBEAT_INTERVAL
            if self.hub is not None:
                self.hub.expire_pending(now)
                self.hub.check_adapter_stale(now)
            try:
                packet, source = self.sock.recvfrom(65535)
            except socket.timeout:
                continue
            except OSError:
                if self.running:
                    continue
                break
            if source[0] not in {"127.0.0.1", "::1"}:
                continue
            try:
                self._handle(*decode_osc(packet))
            except (RealtimeError, ValueError, TypeError):
                pass

    def _handle(self, address, args):
        if self.hub is None:
            return
        if address == "/ingenue/ack" and args:
            self.hub.matron_ack(str(args[0]))
        elif address == "/ingenue/reject" and args:
            self.hub.matron_reject(str(args[0]), str(args[1]) if len(args) > 1 else "matron rejected command")
        elif address == "/ingenue/hello":
            self.hub.adapter_seen(str(args[0]) if args else "unknown")
        elif address == "/ingenue/grid" and len(args) >= 4:
            self.hub.grid_frame(int(args[0]), int(args[1]), int(args[2]), str(args[3]))


class RealtimeHub:
    def __init__(self, adapter, bridge=None, now=time.monotonic, command_timeout=COMMAND_TIMEOUT):
        self.adapter, self.bridge, self.now = adapter, bridge, now
        self.command_timeout = float(command_timeout)
        self.revision, self.next_wire_id = 0, 1
        self.peers, self.pending = set(), {}
        self.adapter_seen_at = None
        self.lock = threading.RLock()

    def register(self, peer):
        with self.lock:
            self.peers.add(peer)

    def unregister(self, peer):
        with self.lock:
            self.peers.discard(peer)

    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
            kind = message["type"]
            if kind == "hello":
                peer.send({"v": 1, "type": "hello", "server": "ingenue",
                           "capabilities": {"channels": sorted(CHANNELS),
                                            "commands": ["control.enc", "control.key", "param.set", "grid.key", "system.ping"],
                                            "applied_ack": True, "virtual_grid": True}})
            elif kind == "subscribe":
                peer.channels = _channels(message.get("channels"))
                peer.send(self.snapshot(peer.channels))
            elif kind == "resync":
                peer.send(self.snapshot(peer.channels or set(CHANNELS)))
            elif kind == "heartbeat":
                peer.send({"v": 1, "type": "heartbeat", "ts": time.time()})
            else:
                self._command(peer, message)
        except RealtimeError as error:
            command_id = raw.get("id") if isinstance(raw, dict) else None
            peer.send({"v": 1, "type": "reject", "id": command_id or "invalid", "error": str(error)})

    def snapshot(self, channels):
        requested = set(channels) or set(CHANNELS)
        with self.lock:
            state, revision = self.adapter.snapshot(), self.revision
        return {"v": 1, "type": "snapshot", "rev": revision,
                "state": {name: state[name] for name in requested if name in state}}

    def _command(self, peer, message):
        client_id = message.get("id")
        if not isinstance(client_id, str) or not client_id:
            raise RealtimeError("command id is required")
        prepared = self.adapter.prepare(message.get("command"))
        if not prepared.requires_matron:
            peer.send({"v": 1, "type": "ack", "id": client_id,
                       "rev": self.revision, "result": prepared.result})
            return
        if self.bridge is None:
            raise RealtimeError("matron bridge unavailable")
        with self.lock:
            if len(self.pending) >= PENDING_LIMIT:
                raise RealtimeError("too many pending commands")
            wire_id = "rt-{}".format(self.next_wire_id)
            self.next_wire_id += 1
            self.pending[wire_id] = PendingCommand(wire_id, client_id, peer, prepared, self.now())
        try:
            self.bridge.dispatch(wire_id, prepared)
        except Exception as error:
            with self.lock:
                self.pending.pop(wire_id, None)
            raise RealtimeError("could not dispatch to matron: {}".format(error))

    def matron_ack(self, wire_id):
        with self.lock:
            pending = self.pending.pop(wire_id, None)
            if pending is None:
                return
            operations = self.adapter.apply(pending.prepared)
            if operations:
                self.revision += 1
            revision = self.revision
        if operations:
            self.broadcast_delta(operations, revision)
        self._settle(pending, {"v": 1, "type": "ack", "id": pending.client_id,
                               "rev": revision, "result": pending.prepared.result})

    def matron_reject(self, wire_id, error):
        with self.lock:
            pending = self.pending.pop(wire_id, None)
        if pending is not None:
            self._settle(pending, {"v": 1, "type": "reject", "id": pending.client_id,
                                   "error": str(error)[:500]})

    def _settle(self, pending, message):
        if not pending.peer.alive:
            return
        try:
            pending.peer.send(message)
        except OSError:
            self.unregister(pending.peer)

    def expire_pending(self, now=None):
        current, expired = self.now() if now is None else now, []
        with self.lock:
            for wire_id, pending in list(self.pending.items()):
                if current - pending.created_at >= self.command_timeout:
                    expired.append(self.pending.pop(wire_id))
        for pending in expired:
            self._settle(pending, {"v": 1, "type": "reject", "id": pending.client_id,
                                   "error": "matron acknowledgement timeout"})

    def adapter_seen(self, version):
        now = self.now()
        with self.lock:
            changed = not self.adapter.adapter_online or self.adapter.adapter_version != version
            self.adapter_seen_at = now
            self.adapter.mark_adapter(True, version)
        if changed:
            self._state_change([{"op": "set", "path": ["device", "adapter"],
                                 "value": self.adapter.snapshot()["device"]["adapter"]}])

    def check_adapter_stale(self, now=None):
        current = self.now() if now is None else now
        with self.lock:
            stale = (self.adapter.adapter_online and self.adapter_seen_at is not None and
                     current - self.adapter_seen_at >= ADAPTER_STALE_AFTER)
            if stale:
                self.adapter.mark_adapter(False)
        if stale:
            self._state_change([{"op": "set", "path": ["device", "adapter"],
                                 "value": self.adapter.snapshot()["device"]["adapter"]}])

    def grid_frame(self, port, cols, rows, levels):
        try:
            operations = self.adapter.record_grid(port, cols, rows, levels)
        except RealtimeError:
            return
        if operations:
            self._state_change(operations)

    def _state_change(self, operations):
        with self.lock:
            self.revision += 1
            revision = self.revision
        self.broadcast_delta(operations, revision)

    def broadcast_delta(self, operations, revision=None):
        rev = self.revision if revision is None else revision
        with self.lock:
            peers = list(self.peers)
        for peer in peers:
            if not peer.alive or not peer.channels:
                continue
            selected = [op for op in operations if op.get("path") and op["path"][0] in peer.channels]
            try:
                peer.send({"v": 1, "type": "delta", "rev": rev, "operations": selected})
            except OSError:
                self.unregister(peer)


def _channels(raw):
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
        peer = None
        try:
            request = self._read_request()
            if request is None:
                return
            method, path, headers = request
            tokens = {item.strip().lower() for item in headers.get("connection", "").split(",")}
            if method != "GET" or path != "/realtime":
                return self._http(404, b"not found\n")
            if headers.get("upgrade", "").lower() != "websocket" or "upgrade" not in tokens:
                return self._http(426, b"websocket upgrade required\n", {"Upgrade": "websocket"})
            key = headers.get("sec-websocket-key")
            if not key:
                return self._http(400, b"missing websocket key\n")
            response = ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n"
                        "Connection: Upgrade\r\nSec-WebSocket-Accept: {}\r\n\r\n".format(websocket_accept(key)))
            self.request.sendall(response.encode("ascii"))
            peer = Peer(self.request)
            self.server.hub.register(peer)
            last_heartbeat = 0.0
            while peer.alive:
                now = time.monotonic()
                if now - last_heartbeat >= HEARTBEAT_INTERVAL:
                    peer.send({"v": 1, "type": "heartbeat", "ts": time.time()})
                    last_heartbeat = now
                readable, _, _ = select.select([self.request], [], [], 0.25)
                if not readable:
                    continue
                opcode, payload = read_frame(self.request)
                if opcode == 0x8:
                    break
                if opcode == 0x9:
                    with peer.lock:
                        self.request.sendall(encode_frame(payload, 0xA))
                    continue
                if opcode != 0x1:
                    raise RealtimeError("only text frames are supported")
                try:
                    message = json.loads(payload.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    raise RealtimeError("invalid JSON frame")
                self.server.hub.handle(peer, message)
        except (EOFError, ConnectionError, OSError, RealtimeError):
            pass
        finally:
            if peer is not None:
                self.server.hub.unregister(peer)
                peer.close()

    def _read_request(self):
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
        lines, headers = head.split("\r\n"), {}
        parts = lines[0].split()
        if len(parts) != 3:
            self._http(400, b"bad request\n")
            return None
        for line in lines[1:]:
            name, sep, value = line.partition(":")
            if sep:
                headers[name.strip().lower()] = value.strip()
        return parts[0], parts[1], headers

    def _http(self, status, body, extra=None):
        reason = {400: "Bad Request", 403: "Forbidden", 404: "Not Found",
                  426: "Upgrade Required", 431: "Request Header Fields Too Large"}.get(status, "Error")
        headers = {"Content-Type": "text/plain; charset=utf-8", "Content-Length": str(len(body)),
                   "Connection": "close"}
        headers.update(extra or {})
        raw = ["HTTP/1.1 {} {}".format(status, reason)] + ["{}: {}".format(k, v) for k, v in headers.items()] + ["", ""]
        self.request.sendall("\r\n".join(raw).encode("ascii") + body)


class ThreadingRealtimeServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, address, hub, handler=RealtimeRequestHandler):
        self.hub = hub
        socketserver.TCPServer.__init__(self, address, handler)


def serve_realtime(host, port, legacy):
    adapter = LegacyAdapter(legacy, realtime_port=port)
    bridge = MatronBridge(legacy, reply_port=adapter.reply_port)
    hub = RealtimeHub(adapter, bridge)
    bridge.start(hub)
    try:
        with ThreadingRealtimeServer((host, port), hub) as server:
            print("ingenue realtime on {}:{}/realtime".format(host, port), flush=True)
            server.serve_forever()
    finally:
        bridge.stop()
