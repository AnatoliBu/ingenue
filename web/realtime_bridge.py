#!/usr/bin/env python3
"""Applied-command and Lua state bridge for Ingenue realtime.

Browser command ids are scoped to their browser session. The server assigns a
unique wire id, registers it before OSC dispatch, and settles the browser id
only after Lua returns /ingenue/ack or /ingenue/reject. The localhost UDP
bridge also carries script state and Grid LED frames.
"""
from __future__ import annotations

import math
import os
import re
import socket
import struct
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set, Tuple

from realtime_server import (
    PROTOCOL_VERSION,
    LegacyAdapter,
    Peer,
    RealtimeError,
    RealtimeHub,
    validate_envelope,
)

BRIDGE_HOST = "127.0.0.1"
MAX_DATAGRAM_BYTES = 65507
APPLIED_TIMEOUT = 3.0
PENDING_LIMIT = 256
APPLIED_CHANNELS = frozenset({"device", "control", "script", "grid"})
PARAM_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,128}$")


def _read_osc_string(data, offset):
    if offset >= len(data):
        raise RealtimeError("truncated OSC string")
    end = data.find(b"\0", offset)
    if end < 0:
        raise RealtimeError("unterminated OSC string")
    try:
        value = data[offset:end].decode("utf-8")
    except UnicodeDecodeError:
        raise RealtimeError("invalid OSC UTF-8")
    return value, (end + 4) & ~3


def decode_osc(data):
    if not data or len(data) > MAX_DATAGRAM_BYTES or data.startswith(b"#bundle"):
        raise RealtimeError("unsupported OSC datagram")
    path, offset = _read_osc_string(data, 0)
    tags, offset = _read_osc_string(data, offset)
    if not tags.startswith(","):
        raise RealtimeError("missing OSC type tags")
    args = []
    for tag in tags[1:]:
        if tag == "i":
            if offset + 4 > len(data): raise RealtimeError("truncated OSC int")
            args.append(struct.unpack(">i", data[offset:offset + 4])[0]); offset += 4
        elif tag == "f":
            if offset + 4 > len(data): raise RealtimeError("truncated OSC float")
            args.append(struct.unpack(">f", data[offset:offset + 4])[0]); offset += 4
        elif tag == "s":
            value, offset = _read_osc_string(data, offset); args.append(value)
        else:
            raise RealtimeError("unsupported OSC type {}".format(tag))
    return path, args


def _int(value, label, low, high):
    if isinstance(value, bool):
        raise RealtimeError("{} must be an integer".format(label))
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        raise RealtimeError("{} must be an integer".format(label))
    if parsed != value or parsed < low or parsed > high:
        raise RealtimeError("{} must be between {} and {}".format(label, low, high))
    return parsed


def _float(value, label):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise RealtimeError("{} must be finite".format(label))
    return float(value)


@dataclass
class PreparedCommand:
    command: Dict[str, Any]
    osc_types: str
    osc_args: Tuple[Any, ...]
    immediate_result: Optional[Dict[str, Any]] = None


class AppliedAdapter(LegacyAdapter):
    def __init__(self, legacy, realtime_port, state_port, now=time.time):
        LegacyAdapter.__init__(self, legacy, realtime_port=realtime_port, now=now)
        self.state_port = int(state_port)
        self.script_state = {"active": False, "name": "none", "shortname": "none"}
        self.grid_state = {"ports": {}}
        self._write_state_port()

    def _write_state_port(self):
        directory = os.path.join(getattr(self.legacy, "HERE", os.getcwd()), "data")
        try:
            os.makedirs(directory, exist_ok=True)
            path = os.path.join(directory, "realtime-state-port")
            temporary = path + ".tmp"
            with open(temporary, "w", encoding="ascii") as handle:
                handle.write(str(self.state_port) + "\n")
            os.replace(temporary, path)
        except OSError as error:
            print("ingenue state-port file unavailable: {}".format(error), flush=True)

    def snapshot(self):
        state = LegacyAdapter.snapshot(self)
        state["script"] = dict(self.script_state)
        state["grid"] = {"ports": {key: dict(value) for key, value in self.grid_state["ports"].items()}}
        return state

    def prepare(self, wire_id, command):
        if not isinstance(command, dict):
            raise RealtimeError("command payload must be an object")
        target = command.get("target")
        action = command.get("action")
        args = command.get("args") or {}
        if not isinstance(args, dict):
            raise RealtimeError("command args must be an object")

        if target == "system" and action == "ping":
            normalized = {"target": target, "action": action, "args": {}}
            return PreparedCommand(normalized, "", (), {"pong": self.now()})
        if target == "control" and action == "enc":
            normalized_args = {"n": _int(args.get("n"), "encoder", 1, 3),
                               "d": _int(args.get("d"), "delta", -127, 127)}
            osc_types = "sssii"; osc_args = (wire_id, target, action, normalized_args["n"], normalized_args["d"])
        elif target == "control" and action == "key":
            normalized_args = {"n": _int(args.get("n"), "key", 1, 3),
                               "z": _int(args.get("z"), "key state", 0, 1)}
            osc_types = "sssii"; osc_args = (wire_id, target, action, normalized_args["n"], normalized_args["z"])
        elif target == "param" and action == "set":
            param_id = str(args.get("id") or "")
            if not PARAM_ID_RE.fullmatch(param_id):
                raise RealtimeError("invalid param id")
            normalized_args = {"id": param_id, "value": _float(args.get("value"), "param value")}
            osc_types = "ssssf"; osc_args = (wire_id, target, action, normalized_args["id"], normalized_args["value"])
        elif target == "grid" and action == "key":
            normalized_args = {
                "port": _int(args.get("port", 1), "grid port", 1, 4),
                "x": _int(args.get("x"), "grid x", 1, 32),
                "y": _int(args.get("y"), "grid y", 1, 32),
                "z": _int(args.get("z"), "grid state", 0, 1),
            }
            osc_types = "sssiiii"; osc_args = (wire_id, target, action,
                normalized_args["port"], normalized_args["x"], normalized_args["y"], normalized_args["z"])
        else:
            raise RealtimeError("unsupported command")
        return PreparedCommand({"target": target, "action": action, "args": normalized_args}, osc_types, osc_args)

    def send_prepared(self, prepared):
        if prepared.immediate_result is not None:
            return
        try:
            self.legacy.osc_send("/ingenue/command", prepared.osc_types, *prepared.osc_args)
        except OSError as error:
            raise RealtimeError("matron OSC dispatch failed: {}".format(error))

    def record_applied(self, command):
        ctl = self.legacy._CTL
        ctl["hits"] = int(ctl.get("hits", 0)) + 1
        ctl["last"] = command
        ctl["ts"] = self.now()
        return [
            {"op": "set", "path": ["control", "hits"], "value": ctl["hits"]},
            {"op": "set", "path": ["control", "last"], "value": command},
            {"op": "set", "path": ["control", "ts"], "value": ctl["ts"]},
        ]

    def apply_runtime(self, path, args):
        if path == "/ingenue/script/state":
            if len(args) < 3: raise RealtimeError("invalid script state")
            self.script_state = {
                "active": bool(_int(args[0], "script active", 0, 1)),
                "name": str(args[1]), "shortname": str(args[2]),
            }
            return "script", [{"op": "set", "path": ["script"], "value": dict(self.script_state)}]
        if path == "/ingenue/grid/frame":
            if len(args) < 7: raise RealtimeError("invalid grid frame")
            port = _int(args[0], "grid port", 1, 4)
            cols = _int(args[1], "grid cols", 1, 32)
            rows = _int(args[2], "grid rows", 1, 32)
            frame = str(args[3]).lower()
            if len(frame) != cols * rows or any(ch not in "0123456789abcdef" for ch in frame):
                raise RealtimeError("invalid grid frame payload")
            value = {
                "port": port, "cols": cols, "rows": rows, "frame": frame,
                "sequence": _int(args[4], "grid sequence", 0, 2147483647),
                "intensity": _int(args[5], "grid intensity", 0, 15),
                "virtual": bool(_int(args[6], "grid virtual", 0, 1)),
            }
            key = str(port); self.grid_state["ports"][key] = value
            return "grid", [{"op": "set", "path": ["grid", "ports", key], "value": dict(value)}]
        return None, []


@dataclass
class PendingCommand:
    peer: Peer
    browser_id: str
    command: Dict[str, Any]
    deadline: float


class AppliedHub(RealtimeHub):
    def __init__(self, adapter, monotonic=time.monotonic):
        RealtimeHub.__init__(self, adapter)
        self.monotonic = monotonic
        self.pending = {}
        self.next_wire_id = 1

    def _channels(self, raw):
        if raw is None: return set(APPLIED_CHANNELS)
        if not isinstance(raw, list): raise RealtimeError("channels must be an array")
        requested = {str(item) for item in raw}
        unknown = requested - APPLIED_CHANNELS
        if unknown: raise RealtimeError("unsupported channels: " + ", ".join(sorted(unknown)))
        return requested or set(APPLIED_CHANNELS)

    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw); kind = message["type"]
            if kind == "hello":
                peer.send({"v": PROTOCOL_VERSION, "type": "hello", "server": "ingenue",
                           "capabilities": {"channels": sorted(APPLIED_CHANNELS),
                           "commands": ["control.enc", "control.key", "param.set", "grid.key", "system.ping"],
                           "ack": "lua-applied"}})
            elif kind == "subscribe":
                peer.channels = self._channels(message.get("channels")); peer.send(self.snapshot(peer.channels))
            elif kind == "resync": peer.send(self.snapshot(peer.channels or set(APPLIED_CHANNELS)))
            elif kind == "heartbeat": peer.send({"v": PROTOCOL_VERSION, "type": "heartbeat", "ts": time.time()})
            elif kind == "command": self._command(peer, message)
        except RealtimeError as error:
            command_id = raw.get("id") if isinstance(raw, dict) else None
            peer.send({"v": PROTOCOL_VERSION, "type": "reject", "id": command_id or "invalid", "error": str(error)})

    def _new_wire_id(self):
        with self.lock:
            wire_id = "wire-{}".format(self.next_wire_id); self.next_wire_id += 1
            return wire_id

    def _command(self, peer, message):
        browser_id = message.get("id")
        if not isinstance(browser_id, str) or not browser_id: raise RealtimeError("command id is required")
        with self.lock:
            if len(self.pending) >= PENDING_LIMIT: raise RealtimeError("too many pending commands")
        wire_id = self._new_wire_id()
        prepared = self.adapter.prepare(wire_id, message.get("command"))
        if prepared.immediate_result is not None:
            peer.send({"v": PROTOCOL_VERSION, "type": "ack", "id": browser_id,
                       "rev": self.revision, "result": prepared.immediate_result}); return
        with self.lock:
            self.pending[wire_id] = PendingCommand(peer, browser_id, prepared.command,
                                                   self.monotonic() + APPLIED_TIMEOUT)
        try:
            self.adapter.send_prepared(prepared)
        except RealtimeError:
            with self.lock: self.pending.pop(wire_id, None)
            raise

    def publish(self, channel, operations):
        if not operations: return self.revision
        with self.lock:
            self.revision += 1; revision = self.revision; peers = list(self.peers)
        for peer in peers:
            if not peer.alive or not peer.channels: continue
            visible = operations if channel in peer.channels else []
            try: peer.send({"v": PROTOCOL_VERSION, "type": "delta", "rev": revision, "operations": visible})
            except OSError: self.unregister(peer)
        return revision

    def ingest(self, path, args):
        if path == "/ingenue/ack":
            wire_id = str(args[0]) if args else ""
            with self.lock: pending = self.pending.pop(wire_id, None)
            if pending is None: return
            revision = self.publish("control", self.adapter.record_applied(pending.command))
            if pending.peer.alive:
                pending.peer.send({"v": PROTOCOL_VERSION, "type": "ack", "id": pending.browser_id,
                                   "rev": revision, "result": {"applied": pending.command}})
            return
        if path == "/ingenue/reject":
            wire_id = str(args[0]) if args else ""; error = str(args[1]) if len(args) > 1 else "Lua rejected command"
            with self.lock: pending = self.pending.pop(wire_id, None)
            if pending is not None and pending.peer.alive:
                pending.peer.send({"v": PROTOCOL_VERSION, "type": "reject", "id": pending.browser_id, "error": error})
            return
        channel, operations = self.adapter.apply_runtime(path, args)
        if channel: self.publish(channel, operations)

    def expire_pending(self, now=None):
        instant = self.monotonic() if now is None else now; expired = []
        with self.lock:
            for wire_id, pending in list(self.pending.items()):
                if pending.deadline <= instant:
                    expired.append(pending); del self.pending[wire_id]
        for pending in expired:
            if pending.peer.alive:
                try: pending.peer.send({"v": PROTOCOL_VERSION, "type": "reject", "id": pending.browser_id,
                                        "error": "matron acknowledgement timeout"})
                except OSError: pass
        return len(expired)

    def unregister(self, peer):
        RealtimeHub.unregister(self, peer)
        with self.lock:
            for wire_id, pending in list(self.pending.items()):
                if pending.peer is peer: del self.pending[wire_id]


class StateBridge(threading.Thread):
    def __init__(self, hub, host, port):
        threading.Thread.__init__(self, name="ingenue-state-bridge", daemon=True)
        self.hub = hub; self.host = host; self.port = int(port); self.stopped = threading.Event()
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.sock.settimeout(0.25)
        self.sock.bind((self.host, self.port))
        self.port = self.sock.getsockname()[1]

    def run(self):
        print("ingenue Lua state bridge on {}:{}".format(self.host, self.port), flush=True)
        while not self.stopped.is_set():
            try: data, source = self.sock.recvfrom(MAX_DATAGRAM_BYTES)
            except socket.timeout:
                self.hub.expire_pending(); continue
            except OSError: break
            if source[0] != "127.0.0.1": continue
            try:
                path, args = decode_osc(data); self.hub.ingest(path, args)
            except (RealtimeError, OSError) as error:
                print("ingenue bridge ignored datagram: {}".format(error), flush=True)
            self.hub.expire_pending()

    def close(self):
        self.stopped.set()
        try: self.sock.close()
        except OSError: pass
