#!/usr/bin/env python3
"""Web MIDI extensions for Ingenue's Lua-applied realtime transport."""
import math

try:
    from .realtime_bridge import AppliedAdapter, AppliedHub, PARAM_ID_RE, PreparedCommand, RealtimeError
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import AppliedAdapter, AppliedHub, PARAM_ID_RE, PreparedCommand, RealtimeError
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

MIDI_COMMANDS = (
    "control.enc", "control.key", "grid.key", "param.set",
    "param.describe", "param.set_normalized", "param.delta", "system.ping",
)


def _finite(value, label):
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
        raise RealtimeError("{} must be finite".format(label))
    return float(value)


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
    """Add normalized/query parameter commands without changing legacy commands."""
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
        return AppliedAdapter.prepare(self, wire_id, command)

    def send_prepared(self, prepared):
        if prepared.command.get("target") == "param" and prepared.command.get("action") in {
            "describe", "set_normalized", "delta"
        }:
            try:
                self.legacy.osc_send("/ingenue/midi-command", prepared.osc_types, *prepared.osc_args)
            except OSError as error:
                raise RealtimeError("matron MIDI OSC dispatch failed: {}".format(error))
            return
        return AppliedAdapter.send_prepared(self, prepared)


class MidiAppliedHub(AppliedHub):
    """Expose MIDI capabilities and return Lua parameter descriptors in ACKs."""
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
                    "channels": sorted(self.adapter.snapshot().keys()),
                    "commands": list(MIDI_COMMANDS),
                    "ack": "lua-applied",
                    "midi": {"normalized_params": True, "profiles": "browser"},
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
                pending.peer.send({"v": PROTOCOL_VERSION, "type": "reject", "id": pending.browser_id, "error": str(error)})
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
