#!/usr/bin/env python3
"""Virtual gamepad extensions for Ingenue realtime."""
import math
import re

try:
    from .realtime_bridge import PreparedCommand, RealtimeError
    from .realtime_controller_lifecycle import CONTROLLER_COMMANDS, ControllerLifecycleAdapter, ControllerLifecycleHub
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import PreparedCommand, RealtimeError
    from realtime_controller_lifecycle import CONTROLLER_COMMANDS, ControllerLifecycleAdapter, ControllerLifecycleHub
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

GAMEPAD_BUTTONS = frozenset({
    "A", "B", "X", "Y", "L1", "R1", "L2", "R2", "L3", "R3", "SELECT", "START",
})
GAMEPAD_ANALOG_AXES = frozenset({
    "leftx", "lefty", "rightx", "righty", "triggerleft", "triggerright",
})
GAMEPAD_COMMANDS = tuple(CONTROLLER_COMMANDS) + tuple(
    item for item in ("gamepad.button", "gamepad.dpad", "gamepad.analog") if item not in CONTROLLER_COMMANDS
)
AXIS_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,31}$")


def _integer(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise RealtimeError("{} must be an integer between {} and {}".format(label, low, high))
    return value


def _finite(value, label, low, high):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise RealtimeError("{} must be finite".format(label))
    numeric = float(value)
    if numeric < low or numeric > high:
        raise RealtimeError("{} must be between {} and {}".format(label, low, high))
    return numeric


class GamepadAppliedAdapter(ControllerLifecycleAdapter):
    """Validate and dispatch virtual gamepad callbacks through matron."""
    def prepare(self, wire_id, command):
        if not isinstance(command, dict) or command.get("target") != "gamepad":
            return ControllerLifecycleAdapter.prepare(self, wire_id, command)
        action = command.get("action")
        args = command.get("args") or {}
        if not isinstance(args, dict):
            raise RealtimeError("command args must be an object")

        if action == "button":
            name = str(args.get("name") or "").upper()
            if name not in GAMEPAD_BUTTONS:
                raise RealtimeError("unsupported gamepad button")
            state = _integer(args.get("z"), "gamepad button state", 0, 1)
            normalized = {"name": name, "z": state}
            return PreparedCommand(
                {"target": "gamepad", "action": action, "args": normalized},
                "ssssi", (wire_id, "gamepad", action, name, state),
            )

        if action == "dpad":
            axis = str(args.get("axis") or "").upper()
            if axis not in ("X", "Y"):
                raise RealtimeError("gamepad dpad axis must be X or Y")
            sign = _integer(args.get("sign"), "gamepad dpad sign", -1, 1)
            normalized = {"axis": axis, "sign": sign}
            return PreparedCommand(
                {"target": "gamepad", "action": action, "args": normalized},
                "ssssi", (wire_id, "gamepad", action, axis, sign),
            )

        if action == "analog":
            axis = str(args.get("axis") or "").lower()
            if not AXIS_RE.fullmatch(axis) or axis not in GAMEPAD_ANALOG_AXES:
                raise RealtimeError("unsupported gamepad analog axis")
            low = 0.0 if axis.startswith("trigger") else -1.0
            value = _finite(args.get("value"), "gamepad analog value", low, 1.0)
            normalized = {"axis": axis, "value": value}
            return PreparedCommand(
                {"target": "gamepad", "action": action, "args": normalized},
                "ssssf", (wire_id, "gamepad", action, axis, value),
            )
        raise RealtimeError("unsupported gamepad command")

    def send_prepared(self, prepared):
        if prepared.command.get("target") == "gamepad":
            try:
                self.legacy.osc_send("/ingenue/control-command", prepared.osc_types, *prepared.osc_args)
            except OSError as error:
                raise RealtimeError("matron gamepad OSC dispatch failed: {}".format(error))
            return
        return ControllerLifecycleAdapter.send_prepared(self, prepared)


class GamepadAppliedHub(ControllerLifecycleHub):
    """Advertise the virtual gamepad callback contract."""
    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
        except (RealtimeError, ProtocolRealtimeError):
            return ControllerLifecycleHub.handle(self, peer, raw)
        if message["type"] == "hello":
            peer.send({
                "v": PROTOCOL_VERSION,
                "type": "hello",
                "server": "ingenue",
                "capabilities": {
                    "channels": sorted(self._channels(None)),
                    "commands": list(GAMEPAD_COMMANDS),
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
                    "gamepad": {
                        "buttons": sorted(GAMEPAD_BUTTONS),
                        "analog_axes": sorted(GAMEPAD_ANALOG_AXES),
                        "dpad_axes": ["X", "Y"],
                        "normalized": True,
                    },
                },
            })
            return
        return ControllerLifecycleHub.handle(self, peer, raw)
