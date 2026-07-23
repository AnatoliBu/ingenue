#!/usr/bin/env python3
"""Web MIDI and native-controller extensions for Ingenue realtime."""
import math

try:
    from .realtime_bridge import AppliedAdapter, AppliedHub, PARAM_ID_RE, PreparedCommand, RealtimeError
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import AppliedAdapter, AppliedHub, PARAM_ID_RE, PreparedCommand, RealtimeError
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

CONTROL_CHANNELS = frozenset({"device", "control", "script", "grid", "arc"})
CONTROL_COMMANDS = (
    "control.enc", "control.key", "grid.key", "arc.delta", "arc.key", "param.set",
    "param.describe", "param.set_normalized", "param.delta", "system.ping",
)


def _finite(value, label):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise RealtimeError("{} must be finite".format(label))
    return float(value)


def _integer(value, label, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or value < low or value > high:
        raise RealtimeError("{} must be an integer between {} and {}".format(label, low, high))
    return value


def _metadata_number(value, label):
    text = str(value)
    normalized = text.strip().lower()
    if normalized in ("inf", "+inf", "infinity", "+infinity", "-inf", "-infinity"):
        return None, text
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise RealtimeError("{} must be numeric".format(label))
    if not math.isfinite(parsed):
        return None, text
    return parsed, text


def _param_id(value):
    param_id = str(value or "")
    if not PARAM_ID_RE.fullmatch(param_id):
        raise RealtimeError("invalid param id")
    return param_id


def parse_param_result(args):
    """Decode the flat OSC parameter descriptor returned by the Lua adapter."""
    if not args or args[0] != "param":
        return None
    if len(args) < 12:
        raise RealtimeError("invalid parameter acknowledgement")
    try:
        type_code = int(args[2])
        writable_code = int(args[11])
    except (TypeError, ValueError):
        raise RealtimeError("invalid parameter acknowledgement types")
    if type_code not in (1, 2, 3, 5, 9) or writable_code not in (0, 1):
        raise RealtimeError("invalid parameter acknowledgement types")
    kind = str(args[3])
    if kind not in ("number", "option", "control", "taper", "binary", "trigger"):
        raise RealtimeError("invalid parameter kind")
    normalized = _finite(args[4], "normalized parameter value")
    if normalized < 0 or normalized > 1:
        raise RealtimeError("normalized parameter value must be between 0 and 1")
    value, value_text = _metadata_number(args[5], "parameter value")
    minimum, minimum_text = _metadata_number(args[6], "parameter minimum")
    maximum, maximum_text = _metadata_number(args[7], "parameter maximum")
    return {
        "id": _param_id(args[1]),
        "type": type_code,
        "kind": kind,
        "normalized": normalized,
        "value": value,
        "value_text": value_text,
        "min": minimum,
        "min_text": minimum_text,
        "max": maximum,
        "max_text": maximum_text,
        "name": str(args[8]),
        "formatted": str(args[9]),
        "behavior": str(args[10]),
        "writable": bool(writable_code),
    }


class MidiAppliedAdapter(AppliedAdapter):
    """Add normalized params and native virtual-controller state."""
    def __init__(self, legacy, realtime_port, state_port, now=None):
        kwargs = {}
        if now is not None:
            kwargs["now"] = now
        AppliedAdapter.__init__(
            self,
            legacy,
            realtime_port=realtime_port,
            state_port=state_port,
            **kwargs
        )
        self.arc_state = {"ports": {}}

    def snapshot(self):
        state = AppliedAdapter.snapshot(self)
        state["arc"] = {
            "ports": {
                key: dict(value)
                for key, value in self.arc_state["ports"].items()
            }
        }
        return state

    def prepare(self, wire_id, command):
        if isinstance(command, dict) and command.get("target") == "param":
            action = command.get("action")
            args = command.get("args") or {}
            if not isinstance(args, dict):
                raise RealtimeError("command args must be an object")
            if action == "describe":
                normalized = {"id": _param_id(args.get("id"))}
                return PreparedCommand(
                    {"target": "param", "action": action, "args": normalized},
                    "ssss", (wire_id, "param", action, normalized["id"]),
                )
            if action == "set_normalized":
                value = _finite(args.get("value"), "normalized parameter value")
                if value < 0 or value > 1:
                    raise RealtimeError("normalized parameter value must be between 0 and 1")
                normalized = {"id": _param_id(args.get("id")), "value": value}
                return PreparedCommand(
                    {"target": "param", "action": action, "args": normalized},
                    "ssssf", (wire_id, "param", action, normalized["id"], value),
                )
            if action == "delta":
                value = args.get("d")
                if isinstance(value, bool) or not isinstance(value, int) or value < -127 or value > 127:
                    raise RealtimeError("parameter delta must be an integer between -127 and 127")
                normalized = {"id": _param_id(args.get("id")), "d": value}
                return PreparedCommand(
                    {"target": "param", "action": action, "args": normalized},
                    "ssssi", (wire_id, "param", action, normalized["id"], value),
                )
        if isinstance(command, dict) and command.get("target") == "arc":
            action = command.get("action")
            args = command.get("args") or {}
            if not isinstance(args, dict):
                raise RealtimeError("command args must be an object")
            port = _integer(args.get("port", 1), "arc port", 1, 4)
            ring = _integer(args.get("n"), "arc ring", 1, 4)
            if action == "delta":
                value = _integer(args.get("d"), "arc delta", -127, 127)
                normalized = {"port": port, "n": ring, "d": value}
            elif action == "key":
                value = _integer(args.get("z"), "arc key state", 0, 1)
                normalized = {"port": port, "n": ring, "z": value}
            else:
                raise RealtimeError("unsupported arc command")
            return PreparedCommand(
                {"target": "arc", "action": action, "args": normalized},
                "sssiii", (wire_id, "arc", action, port, ring, value),
            )
        return AppliedAdapter.prepare(self, wire_id, command)

    def send_prepared(self, prepared):
        target = prepared.command.get("target")
        action = prepared.command.get("action")
        if target == "param" and action in {"describe", "set_normalized", "delta"}:
            path = "/ingenue/midi-command"
            label = "MIDI"
        elif target == "arc" and action in {"delta", "key"}:
            path = "/ingenue/control-command"
            label = "controller"
        else:
            return AppliedAdapter.send_prepared(self, prepared)
        try:
            self.legacy.osc_send(path, prepared.osc_types, *prepared.osc_args)
        except OSError as error:
            raise RealtimeError("matron {} OSC dispatch failed: {}".format(label, error))

    def apply_runtime(self, path, args):
        if path == "/ingenue/arc/frame":
            if len(args) < 6:
                raise RealtimeError("invalid arc frame")
            port = _integer(args[0], "arc port", 1, 4)
            rings = _integer(args[1], "arc rings", 2, 4)
            if rings not in (2, 4):
                raise RealtimeError("arc rings must be 2 or 4")
            frame = str(args[2]).lower()
            if len(frame) != rings * 64 or any(ch not in "0123456789abcdef" for ch in frame):
                raise RealtimeError("invalid arc frame payload")
            value = {
                "port": port,
                "rings": rings,
                "frame": frame,
                "sequence": _integer(args[3], "arc sequence", 0, 2147483647),
                "intensity": _integer(args[4], "arc intensity", 0, 15),
                "virtual": bool(_integer(args[5], "arc virtual", 0, 1)),
            }
            key = str(port)
            self.arc_state["ports"][key] = value
            return "arc", [
                {"op": "set", "path": ["arc", "ports", key], "value": dict(value)}
            ]
        return AppliedAdapter.apply_runtime(self, path, args)


class MidiAppliedHub(AppliedHub):
    """Expose native controller capabilities and parameter descriptors."""
    def _channels(self, raw):
        if raw is None:
            return set(CONTROL_CHANNELS)
        if not isinstance(raw, list):
            raise RealtimeError("channels must be an array")
        requested = {str(item) for item in raw}
        unknown = requested - CONTROL_CHANNELS
        if unknown:
            raise RealtimeError("unsupported channels: " + ", ".join(sorted(unknown)))
        return requested or set(CONTROL_CHANNELS)

    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
        except (RealtimeError, ProtocolRealtimeError):
            return AppliedHub.handle(self, peer, raw)
        if message["type"] == "hello":
            peer.send({
                "v": PROTOCOL_VERSION,
                "type": "hello",
                "server": "ingenue",
                "capabilities": {
                    "channels": sorted(CONTROL_CHANNELS),
                    "commands": list(CONTROL_COMMANDS),
                    "ack": "lua-applied",
                    "midi": {"normalized_params": True, "profiles": "browser"},
                    "arc": {"rings": [2, 4], "leds_per_ring": 64, "varibright": 16},
                },
            })
            return
        return AppliedHub.handle(self, peer, raw)

    def ingest(self, path, args):
        if path != "/ingenue/ack":
            return AppliedHub.ingest(self, path, args)
        wire_id = str(args[0]) if args else ""
        with self.lock:
            pending = self.pending.pop(wire_id, None)
        if pending is None:
            return
        command = pending.command
        mutating = not (command.get("target") == "param" and command.get("action") == "describe")
        revision = self.revision
        if mutating:
            revision = self.publish("control", self.adapter.record_applied(command))
        result = {}
        if mutating:
            result["applied"] = command
        try:
            descriptor = parse_param_result(args[1:])
        except RealtimeError as error:
            if pending.peer.alive:
                pending.peer.send({
                    "v": PROTOCOL_VERSION,
                    "type": "reject",
                    "id": pending.browser_id,
                    "error": str(error),
                })
            return
        if descriptor is not None:
            result["param"] = descriptor
        if pending.peer.alive:
            pending.peer.send({
                "v": PROTOCOL_VERSION,
                "type": "ack",
                "id": pending.browser_id,
                "rev": revision,
                "result": result,
            })
