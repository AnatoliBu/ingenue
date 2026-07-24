#!/usr/bin/env python3
"""Browser controller ownership, reconnect leases, and stuck-input cleanup."""
from __future__ import annotations

import copy
import re
import time
from dataclasses import dataclass

try:
    from .realtime_bridge import RealtimeError
    from .realtime_gamepad import GAMEPAD_ANALOG_AXES, GAMEPAD_BUTTONS
    from .realtime_params import CATALOG_LIMIT, PARAM_CHANNELS, PARAM_COMMANDS, ParamAppliedAdapter, ParamAppliedHub
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import RealtimeError
    from realtime_gamepad import GAMEPAD_ANALOG_AXES, GAMEPAD_BUTTONS
    from realtime_params import CATALOG_LIMIT, PARAM_CHANNELS, PARAM_COMMANDS, ParamAppliedAdapter, ParamAppliedHub
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

CLIENT_ID_RE = re.compile(r"^[A-Za-z0-9_.:-]{8,128}$")
OWNERSHIP_CHANNELS = frozenset(set(PARAM_CHANNELS) | {"ownership"})
OWNERSHIP_COMMANDS = tuple(PARAM_COMMANDS) + (
    "session.claim", "session.release", "session.release_all",
)
LEASE_GRACE_SECONDS = 5.0


def _resource(value):
    resource = str(value or "")
    allowed = {"control", "params", "gamepad"}
    allowed.update("grid:{}".format(port) for port in range(1, 5))
    allowed.update("arc:{}".format(port) for port in range(1, 5))
    if resource not in allowed:
        raise RealtimeError("unsupported ownership resource")
    return resource


def _command_resource(command):
    if not isinstance(command, dict):
        return None
    target = command.get("target")
    args = command.get("args") or {}
    if target == "control":
        return "control"
    if target == "param":
        return "params"
    if target == "gamepad":
        return "gamepad"
    if target in ("grid", "arc") and isinstance(args, dict):
        port = args.get("port", 1)
        if isinstance(port, bool) or not isinstance(port, int) or port < 1 or port > 4:
            return None
        return "{}:{}".format(target, port)
    return None


def _held_transition(command):
    """Return (identity, release command, active) for stateful controller input."""
    if not isinstance(command, dict):
        return None
    target = command.get("target")
    action = command.get("action")
    args = command.get("args") or {}
    if not isinstance(args, dict):
        return None

    if target == "control" and action == "key":
        key = (target, action, args.get("n"))
        release = {"target": target, "action": action, "args": {"n": args.get("n"), "z": 0}}
        return key, release, args.get("z") == 1
    if target == "grid" and action == "key":
        key = (target, action, args.get("port"), args.get("x"), args.get("y"))
        release = {"target": target, "action": action, "args": {
            "port": args.get("port"), "x": args.get("x"), "y": args.get("y"), "z": 0,
        }}
        return key, release, args.get("z") == 1
    if target == "arc" and action == "key":
        key = (target, action, args.get("port"), args.get("n"))
        release = {"target": target, "action": action, "args": {
            "port": args.get("port"), "n": args.get("n"), "z": 0,
        }}
        return key, release, args.get("z") == 1
    if target == "gamepad" and action == "button":
        key = (target, action, args.get("name"))
        release = {"target": target, "action": action, "args": {"name": args.get("name"), "z": 0}}
        return key, release, args.get("z") == 1
    if target == "gamepad" and action == "dpad":
        key = (target, action, args.get("axis"))
        release = {"target": target, "action": action, "args": {"axis": args.get("axis"), "sign": 0}}
        return key, release, args.get("sign") != 0
    if target == "gamepad" and action == "analog":
        key = (target, action, args.get("axis"))
        release = {"target": target, "action": action, "args": {"axis": args.get("axis"), "value": 0.0}}
        return key, release, float(args.get("value", 0)) != 0.0
    return None


@dataclass
class Lease:
    client_id: str
    deadline: object = None


class OwnershipAppliedAdapter(ParamAppliedAdapter):
    """Named production adapter seam for the ownership-aware hub."""


class OwnershipAppliedHub(ParamAppliedHub):
    """Serialize browser control per resource and clean up abandoned input."""
    def __init__(self, adapter, monotonic=time.monotonic, lease_grace=LEASE_GRACE_SECONDS):
        ParamAppliedHub.__init__(self, adapter, monotonic=monotonic)
        self.lease_grace = float(lease_grace)
        self.client_peers = {}
        self.leases = {}
        self.held = {}
        self.next_legacy_client = 1
        self.next_release_id = 1

    def register(self, peer):
        ParamAppliedHub.register(self, peer)
        peer.client_id = None

    def _channels(self, raw):
        if raw is None:
            return set(OWNERSHIP_CHANNELS)
        if not isinstance(raw, list):
            raise RealtimeError("channels must be an array")
        requested = {str(item) for item in raw}
        unknown = requested - OWNERSHIP_CHANNELS
        if unknown:
            raise RealtimeError("unsupported channels: " + ", ".join(sorted(unknown)))
        return requested or set(OWNERSHIP_CHANNELS)

    def _ownership_state_locked(self):
        resources = {}
        for resource, lease in self.leases.items():
            connected = bool(self.client_peers.get(lease.client_id))
            resources[resource] = {
                "client_id": lease.client_id,
                "connected": connected,
                "status": "active" if connected else "reconnecting",
            }
        return {
            "lease_grace_ms": int(self.lease_grace * 1000),
            "resources": resources,
        }

    def snapshot(self, channels):
        requested = set(channels) or set(OWNERSHIP_CHANNELS)
        with self.lock:
            state = self.adapter.snapshot()
            if "ownership" in requested:
                state["ownership"] = self._ownership_state_locked()
            revision = self.revision
        filtered = {name: state[name] for name in requested if name in state}
        return {"v": PROTOCOL_VERSION, "type": "snapshot", "rev": revision, "state": filtered}

    def _publish_resource(self, resource):
        with self.lock:
            lease = self.leases.get(resource)
            if lease is None:
                operation = {"op": "delete", "path": ["ownership", "resources", resource]}
            else:
                connected = bool(self.client_peers.get(lease.client_id))
                operation = {"op": "set", "path": ["ownership", "resources", resource], "value": {
                    "client_id": lease.client_id,
                    "connected": connected,
                    "status": "active" if connected else "reconnecting",
                }}
        self.publish("ownership", [operation])

    def _bind_client(self, peer, client_id):
        client_id = str(client_id or "")
        if not CLIENT_ID_RE.fullmatch(client_id):
            raise RealtimeError("invalid browser client id")
        previous = getattr(peer, "client_id", None)
        changed_resources = []
        with self.lock:
            if previous and previous != client_id:
                peers = self.client_peers.get(previous)
                if peers:
                    peers.discard(peer)
                    if not peers:
                        self.client_peers.pop(previous, None)
            peer.client_id = client_id
            self.client_peers.setdefault(client_id, set()).add(peer)
            for resource, lease in self.leases.items():
                if lease.client_id == client_id and lease.deadline is not None:
                    lease.deadline = None
                    changed_resources.append(resource)
        for resource in changed_resources:
            self._publish_resource(resource)
        return client_id

    def _ensure_client(self, peer):
        client_id = getattr(peer, "client_id", None)
        if client_id:
            return client_id
        with self.lock:
            client_id = "legacy-{:08d}".format(self.next_legacy_client)
            self.next_legacy_client += 1
        return self._bind_client(peer, client_id)

    def _claim(self, client_id, resource):
        now = self.monotonic()
        changed = False
        with self.lock:
            lease = self.leases.get(resource)
            if lease is not None and lease.deadline is not None and lease.deadline <= now:
                self.leases.pop(resource, None)
                lease = None
            if lease is not None and lease.client_id != client_id:
                raise RealtimeError("{} is controlled by another browser".format(resource))
            if lease is None:
                self.leases[resource] = Lease(client_id, None)
                changed = True
            elif lease.deadline is not None:
                lease.deadline = None
                changed = True
        if changed:
            self._publish_resource(resource)
        return resource

    def _release_resource(self, client_id, resource):
        removed = False
        with self.lock:
            lease = self.leases.get(resource)
            if lease is not None and lease.client_id == client_id:
                self.leases.pop(resource, None)
                removed = True
        if removed:
            self._publish_resource(resource)
        return removed

    def _release_commands(self, client_id):
        with self.lock:
            releases = list(self.held.pop(client_id, {}).values())
        for command in releases:
            with self.lock:
                wire_id = "release-{}".format(self.next_release_id)
                self.next_release_id += 1
            try:
                prepared = self.adapter.prepare(wire_id, command)
                self.adapter.send_prepared(prepared)
            except (RealtimeError, OSError) as error:
                print("ingenue ownership release failed: {}".format(error), flush=True)
        return len(releases)

    def _release_all(self, client_id):
        released_inputs = self._release_commands(client_id)
        resources = []
        with self.lock:
            for resource, lease in list(self.leases.items()):
                if lease.client_id == client_id:
                    resources.append(resource)
                    self.leases.pop(resource, None)
        for resource in resources:
            self._publish_resource(resource)
        return released_inputs, resources

    def _session_command(self, peer, message):
        browser_id = message.get("id")
        if not isinstance(browser_id, str) or not browser_id:
            raise RealtimeError("command id is required")
        command = message.get("command") or {}
        action = command.get("action")
        args = command.get("args") or {}
        if not isinstance(args, dict):
            raise RealtimeError("command args must be an object")
        client_id = self._ensure_client(peer)
        if action == "claim":
            resource = self._claim(client_id, _resource(args.get("resource")))
            result = {"claimed": resource}
        elif action == "release":
            resource = _resource(args.get("resource"))
            result = {"released": resource if self._release_resource(client_id, resource) else None}
        elif action == "release_all":
            released_inputs, resources = self._release_all(client_id)
            result = {"released_inputs": released_inputs, "released_resources": resources}
        else:
            raise RealtimeError("unsupported session command")
        peer.send({"v": PROTOCOL_VERSION, "type": "ack", "id": browser_id, "rev": self.revision, "result": result})

    def _capabilities(self):
        return {
            "channels": sorted(OWNERSHIP_CHANNELS),
            "commands": list(OWNERSHIP_COMMANDS),
            "ack": "lua-applied",
            "midi": {"normalized_params": True, "profiles": "browser"},
            "grid": {
                "shapes": ["8x8", "16x8", "16x16"], "rotations": [0, 1, 2, 3],
                "ports": [1, 2, 3, 4], "persistent": True,
            },
            "arc": {
                "rings": [2, 4], "ports": [1, 2, 3, 4],
                "leds_per_ring": 64, "varibright": 16, "persistent": True,
            },
            "gamepad": {
                "buttons": sorted(GAMEPAD_BUTTONS),
                "analog_axes": sorted(GAMEPAD_ANALOG_AXES),
                "dpad_axes": ["X", "Y"], "normalized": True,
            },
            "params": {"catalog": True, "automatic_panel": True, "limit": CATALOG_LIMIT},
            "ownership": {
                "implicit_claims": True,
                "reconnect_grace_ms": int(self.lease_grace * 1000),
                "release_on_disconnect": True,
            },
        }

    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
            kind = message["type"]
            if kind == "hello":
                supplied = message.get("client_id")
                client_id = self._bind_client(peer, supplied) if supplied else self._ensure_client(peer)
                peer.send({
                    "v": PROTOCOL_VERSION, "type": "hello", "server": "ingenue",
                    "client_id": client_id, "capabilities": self._capabilities(),
                })
                return
            if kind == "subscribe":
                self._ensure_client(peer)
                peer.channels = self._channels(message.get("channels"))
                peer.send(self.snapshot(peer.channels))
                return
            if kind == "resync":
                self._ensure_client(peer)
                peer.send(self.snapshot(peer.channels or set(OWNERSHIP_CHANNELS)))
                return
            if kind == "heartbeat":
                peer.send({"v": PROTOCOL_VERSION, "type": "heartbeat", "ts": time.time()})
                return
            if kind == "command":
                command = message.get("command")
                if isinstance(command, dict) and command.get("target") == "session":
                    self._session_command(peer, message)
                    return
                client_id = self._ensure_client(peer)
                resource = _command_resource(command)
                if resource:
                    self._claim(client_id, resource)
                return ParamAppliedHub.handle(self, peer, raw)
            return ParamAppliedHub.handle(self, peer, raw)
        except (RealtimeError, ProtocolRealtimeError) as error:
            command_id = raw.get("id") if isinstance(raw, dict) else None
            peer.send({
                "v": PROTOCOL_VERSION, "type": "reject",
                "id": command_id or "invalid", "error": str(error),
            })

    def ingest(self, path, args):
        pending = None
        if path == "/ingenue/ack":
            wire_id = str(args[0]) if args else ""
            with self.lock:
                pending = self.pending.get(wire_id)
        ParamAppliedHub.ingest(self, path, args)
        if pending is None:
            return
        client_id = getattr(pending.peer, "client_id", None)
        transition = _held_transition(pending.command)
        if not client_id or transition is None:
            return
        identity, release, active = transition
        with self.lock:
            held = self.held.setdefault(client_id, {})
            if active:
                held[identity] = copy.deepcopy(release)
            else:
                held.pop(identity, None)
            if not held:
                self.held.pop(client_id, None)

    def expire_pending(self, now=None):
        instant = self.monotonic() if now is None else now
        expired_commands = ParamAppliedHub.expire_pending(self, instant)
        expired_resources = []
        with self.lock:
            for resource, lease in list(self.leases.items()):
                if lease.deadline is not None and lease.deadline <= instant:
                    self.leases.pop(resource, None)
                    expired_resources.append(resource)
        for resource in expired_resources:
            self._publish_resource(resource)
        return expired_commands + len(expired_resources)

    def unregister(self, peer):
        ParamAppliedHub.unregister(self, peer)
        client_id = getattr(peer, "client_id", None)
        if not client_id:
            return
        resources = []
        last_peer = False
        with self.lock:
            peers = self.client_peers.get(client_id)
            if peers:
                peers.discard(peer)
                if not peers:
                    self.client_peers.pop(client_id, None)
                    last_peer = True
            if last_peer:
                deadline = self.monotonic() + self.lease_grace
                for resource, lease in self.leases.items():
                    if lease.client_id == client_id:
                        lease.deadline = deadline
                        resources.append(resource)
        if not last_peer:
            return
        self._release_commands(client_id)
        for resource in resources:
            self._publish_resource(resource)
