#!/usr/bin/env python3
"""Authoritative parameter catalog extensions for Ingenue realtime."""
import copy
import math
import re

try:
    from .realtime_bridge import PARAM_ID_RE, PreparedCommand, RealtimeError
    from .realtime_gamepad import GAMEPAD_ANALOG_AXES, GAMEPAD_BUTTONS, GAMEPAD_COMMANDS, GamepadAppliedAdapter, GamepadAppliedHub
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import PARAM_ID_RE, PreparedCommand, RealtimeError
    from realtime_gamepad import GAMEPAD_ANALOG_AXES, GAMEPAD_BUTTONS, GAMEPAD_COMMANDS, GamepadAppliedAdapter, GamepadAppliedHub
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

PARAM_CHANNELS = frozenset({"device", "control", "script", "grid", "arc", "params"})
PARAM_COMMANDS = tuple(GAMEPAD_COMMANDS) + tuple(
    item for item in ("param.catalog", "param.trigger") if item not in GAMEPAD_COMMANDS
)
GENERATION_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
CATALOG_LIMIT = 512
PARAM_TYPES = frozenset({0, 1, 2, 3, 5, 6, 7, 9})
PARAM_KINDS = frozenset({"separator", "group", "number", "option", "control", "taper", "trigger", "binary"})


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


def _text(value, label, limit):
    text = str(value)
    if not text or len(text) > limit:
        raise RealtimeError("{} must contain 1 to {} characters".format(label, limit))
    return text


def _generation(value):
    generation = str(value or "")
    if not GENERATION_RE.fullmatch(generation):
        raise RealtimeError("invalid parameter catalog generation")
    return generation


class ParamAppliedAdapter(GamepadAppliedAdapter):
    """Add an atomic parameter catalog without changing existing commands."""
    def __init__(self, legacy, realtime_port, state_port, now=None):
        kwargs = {}
        if now is not None:
            kwargs["now"] = now
        GamepadAppliedAdapter.__init__(
            self, legacy, realtime_port=realtime_port, state_port=state_port, **kwargs
        )
        self.params_state = {"generation": "none", "script": "none", "items": []}
        self.catalog_staging = {}

    def snapshot(self):
        state = GamepadAppliedAdapter.snapshot(self)
        state["params"] = copy.deepcopy(self.params_state)
        return state

    def prepare(self, wire_id, command):
        if not isinstance(command, dict) or command.get("target") != "param":
            return GamepadAppliedAdapter.prepare(self, wire_id, command)
        action = command.get("action")
        args = command.get("args") or {}
        if not isinstance(args, dict):
            raise RealtimeError("command args must be an object")
        if action == "catalog":
            return PreparedCommand(
                {"target": "param", "action": action, "args": {}},
                "sss", (wire_id, "params", "catalog"),
            )
        if action == "trigger":
            param_id = str(args.get("id") or "")
            if not PARAM_ID_RE.fullmatch(param_id):
                raise RealtimeError("invalid param id")
            return PreparedCommand(
                {"target": "param", "action": action, "args": {"id": param_id}},
                "ssss", (wire_id, "params", "trigger", param_id),
            )
        return GamepadAppliedAdapter.prepare(self, wire_id, command)

    def send_prepared(self, prepared):
        command = prepared.command
        if command.get("target") == "param" and command.get("action") in {"catalog", "trigger"}:
            try:
                self.legacy.osc_send(
                    "/ingenue/control-command", prepared.osc_types, *prepared.osc_args
                )
            except OSError as error:
                raise RealtimeError("matron parameter OSC dispatch failed: {}".format(error))
            return
        return GamepadAppliedAdapter.send_prepared(self, prepared)

    def _stage(self, generation):
        stage = self.catalog_staging.get(generation)
        if stage is None:
            raise RealtimeError("parameter catalog generation was not started")
        return stage

    def apply_runtime(self, path, args):
        if path == "/ingenue/params/start":
            if len(args) < 3:
                raise RealtimeError("invalid parameter catalog start")
            generation = _generation(args[0])
            expected = _integer(args[1], "parameter count", 0, CATALOG_LIMIT)
            script = _text(args[2], "script name", 256)
            if len(self.catalog_staging) >= 4 and generation not in self.catalog_staging:
                self.catalog_staging.pop(next(iter(self.catalog_staging)))
            self.catalog_staging[generation] = {
                "expected": expected, "script": script, "items": {}, "options": {}
            }
            return None, []

        if path == "/ingenue/params/item":
            if len(args) < 14:
                raise RealtimeError("invalid parameter catalog item")
            generation = _generation(args[0])
            stage = self._stage(generation)
            index = _integer(args[1], "parameter index", 1, max(1, stage["expected"]))
            type_code = _integer(args[2], "parameter type", 0, 9)
            if type_code not in PARAM_TYPES:
                raise RealtimeError("unsupported parameter type")
            param_id = _text(args[3], "parameter id", 128)
            name = _text(args[4], "parameter name", 512)
            kind = _text(args[5], "parameter kind", 32)
            if kind not in PARAM_KINDS:
                raise RealtimeError("unsupported parameter kind")
            normalized = _finite(args[6], "normalized parameter value", 0, 1)
            writable = bool(_integer(args[12], "parameter writable flag", 0, 1))
            option_count = _integer(args[13], "parameter option count", 0, 256)
            if kind != "option" and option_count:
                raise RealtimeError("only option parameters may publish options")
            stage["items"][index] = {
                "index": index,
                "id": param_id,
                "type": type_code,
                "name": name,
                "kind": kind,
                "normalized": normalized,
                "value_text": str(args[7]),
                "min_text": str(args[8]),
                "max_text": str(args[9]),
                "formatted": str(args[10]),
                "behavior": str(args[11]),
                "writable": writable,
                "option_count": option_count,
                "options": [],
            }
            return None, []

        if path == "/ingenue/params/option":
            if len(args) < 4:
                raise RealtimeError("invalid parameter option")
            generation = _generation(args[0])
            stage = self._stage(generation)
            item_index = _integer(args[1], "parameter index", 1, max(1, stage["expected"]))
            option_index = _integer(args[2], "option index", 1, 256)
            label = _text(args[3], "option label", 512)
            stage["options"].setdefault(item_index, {})[option_index] = label
            return None, []

        if path == "/ingenue/params/end":
            if len(args) < 2:
                raise RealtimeError("invalid parameter catalog end")
            generation = _generation(args[0])
            stage = self._stage(generation)
            count = _integer(args[1], "parameter count", 0, CATALOG_LIMIT)
            if count != stage["expected"] or len(stage["items"]) != count:
                raise RealtimeError("incomplete parameter catalog")
            items = []
            for index in range(1, count + 1):
                item = stage["items"].get(index)
                if item is None:
                    raise RealtimeError("parameter catalog index gap")
                if item["kind"] == "option":
                    option_map = stage["options"].get(index, {})
                    if len(option_map) != item["option_count"]:
                        raise RealtimeError("incomplete parameter option catalog")
                    item["options"] = [option_map[position] for position in range(1, item["option_count"] + 1)]
                items.append(item)
            self.params_state = {
                "generation": generation,
                "script": stage["script"],
                "items": items,
            }
            self.catalog_staging.pop(generation, None)
            return "params", [
                {"op": "set", "path": ["params"], "value": copy.deepcopy(self.params_state)}
            ]

        return GamepadAppliedAdapter.apply_runtime(self, path, args)


class ParamAppliedHub(GamepadAppliedHub):
    """Expose the parameter catalog channel and automatic-panel commands."""
    def _channels(self, raw):
        if raw is None:
            return set(PARAM_CHANNELS)
        if not isinstance(raw, list):
            raise RealtimeError("channels must be an array")
        requested = {str(item) for item in raw}
        unknown = requested - PARAM_CHANNELS
        if unknown:
            raise RealtimeError("unsupported channels: " + ", ".join(sorted(unknown)))
        return requested or set(PARAM_CHANNELS)

    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
        except (RealtimeError, ProtocolRealtimeError):
            return GamepadAppliedHub.handle(self, peer, raw)
        if message["type"] == "hello":
            peer.send({
                "v": PROTOCOL_VERSION,
                "type": "hello",
                "server": "ingenue",
                "capabilities": {
                    "channels": sorted(PARAM_CHANNELS),
                    "commands": list(PARAM_COMMANDS),
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
                    "params": {"catalog": True, "automatic_panel": True, "limit": CATALOG_LIMIT},
                },
            })
            return
        return GamepadAppliedHub.handle(self, peer, raw)
