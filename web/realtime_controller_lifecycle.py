#!/usr/bin/env python3
"""Persistent virtual-controller lifecycle extensions for Ingenue realtime."""
try:
    from .realtime_bridge import PreparedCommand, RealtimeError
    from .realtime_grid import GRID_COMMANDS, GridAppliedAdapter, GridAppliedHub
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import PreparedCommand, RealtimeError
    from realtime_grid import GRID_COMMANDS, GridAppliedAdapter, GridAppliedHub
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

CONTROLLER_COMMANDS = tuple(GRID_COMMANDS) + (() if "arc.configure" in GRID_COMMANDS else ("arc.configure",))


def _integer(value, label, low, high):
    if isinstance(value, bool):
        raise RealtimeError("{} must be an integer between {} and {}".format(label, low, high))
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        raise RealtimeError("{} must be an integer between {} and {}".format(label, low, high))
    if parsed != value or parsed < low or parsed > high:
        raise RealtimeError("{} must be an integer between {} and {}".format(label, low, high))
    return parsed


class ControllerLifecycleAdapter(GridAppliedAdapter):
    """Add persistent Arc profiles and explicit stale-port removal."""
    def prepare(self, wire_id, command):
        if isinstance(command, dict) and command.get("target") == "arc" and command.get("action") == "configure":
            args = command.get("args") or {}
            if not isinstance(args, dict):
                raise RealtimeError("command args must be an object")
            port = _integer(args.get("port"), "arc port", 1, 4)
            rings = _integer(args.get("rings"), "arc rings", 2, 4)
            if rings not in (2, 4):
                raise RealtimeError("arc rings must be 2 or 4")
            normalized = {"port": port, "rings": rings}
            return PreparedCommand(
                {"target": "arc", "action": "configure", "args": normalized},
                "sssii", (wire_id, "arc", "configure", port, rings),
            )
        return GridAppliedAdapter.prepare(self, wire_id, command)

    def send_prepared(self, prepared):
        command = prepared.command
        if command.get("target") == "arc" and command.get("action") == "configure":
            try:
                self.legacy.osc_send(
                    "/ingenue/control-command", prepared.osc_types, *prepared.osc_args
                )
            except OSError as error:
                raise RealtimeError("matron Arc configuration dispatch failed: {}".format(error))
            return
        return GridAppliedAdapter.send_prepared(self, prepared)

    def apply_runtime(self, path, args):
        if path == "/ingenue/arc/disconnect":
            if not args:
                raise RealtimeError("invalid arc disconnect")
            port = _integer(args[0], "arc port", 1, 4)
            key = str(port)
            self.arc_state["ports"].pop(key, None)
            return "arc", [{"op": "delete", "path": ["arc", "ports", key]}]
        return GridAppliedAdapter.apply_runtime(self, path, args)


class ControllerLifecycleHub(GridAppliedHub):
    """Advertise persistent Grid/Arc lifecycle capabilities."""
    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
        except (RealtimeError, ProtocolRealtimeError):
            return GridAppliedHub.handle(self, peer, raw)
        if message["type"] == "hello":
            peer.send({
                "v": PROTOCOL_VERSION,
                "type": "hello",
                "server": "ingenue",
                "capabilities": {
                    "channels": sorted(self._channels(None)),
                    "commands": list(CONTROLLER_COMMANDS),
                    "ack": "lua-applied",
                    "midi": {"normalized_params": True, "profiles": "browser"},
                    "grid": {
                        "shapes": ["8x8", "16x8", "16x16"],
                        "rotations": [0, 1, 2, 3],
                        "ports": [1, 2, 3, 4],
                        "persistent": True,
                    },
                    "arc": {
                        "rings": [2, 4],
                        "ports": [1, 2, 3, 4],
                        "leds_per_ring": 64,
                        "varibright": 16,
                        "persistent": True,
                    },
                },
            })
            return
        return GridAppliedHub.handle(self, peer, raw)
