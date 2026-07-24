#!/usr/bin/env python3
"""Configurable virtual-Grid extension for Ingenue realtime."""
try:
    from .realtime_bridge import PreparedCommand, RealtimeError
    from .realtime_midi import CONTROL_COMMANDS, MidiAppliedAdapter, MidiAppliedHub
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import PreparedCommand, RealtimeError
    from realtime_midi import CONTROL_COMMANDS, MidiAppliedAdapter, MidiAppliedHub
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

GRID_SHAPES = frozenset({(8, 8), (16, 8), (16, 16)})
GRID_COMMANDS = tuple(CONTROL_COMMANDS) + (() if "grid.configure" in CONTROL_COMMANDS else ("grid.configure",))


def _integer(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise RealtimeError("{} must be an integer between {} and {}".format(label, low, high))
    return value


class GridAppliedAdapter(MidiAppliedAdapter):
    """Add persistent native Grid profiles without changing MIDI/Arc behavior."""
    def prepare(self, wire_id, command):
        if isinstance(command, dict) and command.get("target") == "grid" and command.get("action") == "configure":
            args = command.get("args") or {}
            if not isinstance(args, dict):
                raise RealtimeError("command args must be an object")
            port = _integer(args.get("port"), "grid port", 1, 4)
            cols = _integer(args.get("cols"), "grid cols", 1, 32)
            rows = _integer(args.get("rows"), "grid rows", 1, 32)
            rotation = _integer(args.get("rotation"), "grid rotation", 0, 3)
            if (cols, rows) not in GRID_SHAPES:
                raise RealtimeError("grid shape must be 8x8, 16x8, or 16x16")
            normalized = {"port": port, "cols": cols, "rows": rows, "rotation": rotation}
            return PreparedCommand(
                {"target": "grid", "action": "configure", "args": normalized},
                "sssiiii", (wire_id, "grid", "configure", port, cols, rows, rotation),
            )
        return MidiAppliedAdapter.prepare(self, wire_id, command)

    def send_prepared(self, prepared):
        if prepared.command.get("target") == "grid" and prepared.command.get("action") == "configure":
            try:
                self.legacy.osc_send("/ingenue/control-command", prepared.osc_types, *prepared.osc_args)
            except OSError as error:
                raise RealtimeError("matron controller OSC dispatch failed: {}".format(error))
            return
        return MidiAppliedAdapter.send_prepared(self, prepared)

    def apply_runtime(self, path, args):
        if path == "/ingenue/grid/disconnect":
            if not args:
                raise RealtimeError("invalid grid disconnect")
            port = _integer(args[0], "grid port", 1, 4)
            key = str(port)
            self.grid_state["ports"].pop(key, None)
            return "grid", [{"op": "delete", "path": ["grid", "ports", key]}]
        if path != "/ingenue/grid/frame":
            return MidiAppliedAdapter.apply_runtime(self, path, args)

        if not args:
            raise RealtimeError("invalid grid frame")
        port = _integer(args[0], "grid port", 1, 4)
        key = str(port)
        previous_rotation = self.grid_state["ports"].get(key, {}).get("rotation", 0)
        channel, operations = MidiAppliedAdapter.apply_runtime(self, path, args)
        value = operations[0]["value"]
        rotation = (
            _integer(args[7], "grid rotation", 0, 3)
            if len(args) >= 8
            else _integer(previous_rotation, "grid rotation", 0, 3)
        )
        value["rotation"] = rotation
        self.grid_state["ports"][key] = value
        return channel, operations


class GridAppliedHub(MidiAppliedHub):
    """Advertise configurable Grid profiles while preserving MIDI/Arc protocol."""
    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
        except (RealtimeError, ProtocolRealtimeError):
            return MidiAppliedHub.handle(self, peer, raw)
        if message["type"] == "hello":
            peer.send({
                "v": PROTOCOL_VERSION,
                "type": "hello",
                "server": "ingenue",
                "capabilities": {
                    "channels": sorted(self._channels(None)),
                    "commands": list(GRID_COMMANDS),
                    "ack": "lua-applied",
                    "midi": {"normalized_params": True, "profiles": "browser"},
                    "grid": {"shapes": ["8x8", "16x8", "16x16"], "rotations": [0, 1, 2, 3]},
                    "arc": {"rings": [2, 4], "leds_per_ring": 64, "varibright": 16},
                },
            })
            return
        return MidiAppliedHub.handle(self, peer, raw)
