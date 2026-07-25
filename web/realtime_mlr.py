#!/usr/bin/env python3
"""Read-only MLR state extension for the Ingenue realtime runtime."""
from __future__ import annotations

import copy
import math

try:
    from .realtime_runtime import RUNTIME_CHANNELS, RuntimeAppliedAdapter, RuntimeContractError
    from .realtime_runtime_schema import SchemaRuntimeAppliedHub
except ImportError:
    from realtime_runtime import RUNTIME_CHANNELS, RuntimeAppliedAdapter, RuntimeContractError
    from realtime_runtime_schema import SchemaRuntimeAppliedHub

MLR_CHANNELS = frozenset(set(RUNTIME_CHANNELS) | {"mlr"})
VIEW_NAMES = {1: "rec", 2: "cut", 3: "clip", 15: "time"}


def _default_state():
    return {
        "active": False,
        "version": "2.2.5",
        "view": 1,
        "view_name": "rec",
        "focus": 1,
        "alt": False,
        "quantize": False,
        "tracks": {},
        "clips": {},
        "patterns": {},
        "recalls": {},
    }


def _integer(value, label, minimum, maximum):
    if isinstance(value, bool):
        raise RuntimeContractError("{} must be an integer".format(label), "validation")
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        raise RuntimeContractError("{} must be an integer".format(label), "validation")
    if parsed != value or parsed < minimum or parsed > maximum:
        raise RuntimeContractError(
            "{} must be between {} and {}".format(label, minimum, maximum), "validation"
        )
    return parsed


def _finite(value, label, minimum=None, maximum=None):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise RuntimeContractError("{} must be finite".format(label), "validation")
    parsed = float(value)
    if minimum is not None and parsed < minimum:
        raise RuntimeContractError("{} is below its minimum".format(label), "validation")
    if maximum is not None and parsed > maximum:
        raise RuntimeContractError("{} is above its maximum".format(label), "validation")
    return parsed


def _flag(value, label):
    return bool(_integer(value, label, 0, 1))


def _text(value, label, maximum=256):
    parsed = str(value or "")
    if len(parsed) > maximum:
        raise RuntimeContractError("{} is too long".format(label), "validation")
    return parsed


class MlrAppliedAdapter(RuntimeAppliedAdapter):
    """Add authoritative read-only MLR state to snapshots and deltas."""

    def __init__(self, legacy, realtime_port, state_port, now=None, session_generation=None):
        kwargs = {}
        if now is not None:
            kwargs["now"] = now
        if session_generation is not None:
            kwargs["session_generation"] = session_generation
        RuntimeAppliedAdapter.__init__(
            self, legacy, realtime_port=realtime_port, state_port=state_port, **kwargs
        )
        self.mlr_state = _default_state()

    def snapshot(self):
        state = RuntimeAppliedAdapter.snapshot(self)
        state["mlr"] = copy.deepcopy(self.mlr_state)
        return state

    def _set(self, section, key, value):
        self.mlr_state[section][str(key)] = value
        return "mlr", [{
            "op": "set",
            "path": ["mlr", section, str(key)],
            "value": copy.deepcopy(value),
        }]

    def apply_runtime(self, path, args):
        if path == "/ingenue/mlr/reset":
            self.mlr_state = _default_state()
            return "mlr", [{"op": "set", "path": ["mlr"], "value": copy.deepcopy(self.mlr_state)}]

        if path == "/ingenue/mlr/meta":
            if len(args) != 6:
                raise RuntimeContractError("invalid MLR metadata", "validation")
            view = _integer(args[2], "MLR view", 1, 15)
            if view not in VIEW_NAMES:
                raise RuntimeContractError("unsupported MLR view", "validation")
            values = {
                "active": _flag(args[0], "MLR active"),
                "version": _text(args[1], "MLR version", 32),
                "view": view,
                "view_name": VIEW_NAMES[view],
                "focus": _integer(args[3], "MLR focus", 1, 6),
                "alt": _flag(args[4], "MLR alt"),
                "quantize": _flag(args[5], "MLR quantize"),
            }
            self.mlr_state.update(values)
            return "mlr", [
                {"op": "set", "path": ["mlr", key], "value": copy.deepcopy(value)}
                for key, value in values.items()
            ]

        if path == "/ingenue/mlr/track":
            if len(args) != 17:
                raise RuntimeContractError("invalid MLR track state", "validation")
            index = _integer(args[0], "MLR track", 1, 6)
            value = {
                "index": index,
                "play": _flag(args[1], "MLR track play"),
                "rec": _flag(args[2], "MLR track record"),
                "loop": _flag(args[3], "MLR track loop"),
                "loop_start": _integer(args[4], "MLR loop start", 0, 16),
                "loop_end": _integer(args[5], "MLR loop end", 0, 16),
                "clip": _integer(args[6], "MLR clip", 1, 16),
                "pos_grid": _integer(args[7], "MLR playhead", -1, 16),
                "speed": _integer(args[8], "MLR speed", -16, 16),
                "reverse": _flag(args[9], "MLR reverse"),
                "tempo_map": _flag(args[10], "MLR tempo map"),
                "volume": _finite(args[11], "MLR volume", -16, 16),
                "record_level": _finite(args[12], "MLR record level", -16, 16),
                "pre_level": _finite(args[13], "MLR pre level", -16, 16),
                "clip_name": _text(args[14], "MLR clip name"),
                "clip_length": _finite(args[15], "MLR clip length", 0, 3600),
                "clip_bpm": _finite(args[16], "MLR clip BPM", 0, 10000),
            }
            if value["loop"] and value["loop_start"] > value["loop_end"]:
                raise RuntimeContractError("MLR loop start exceeds loop end", "validation")
            return self._set("tracks", index, value)

        if path == "/ingenue/mlr/clip":
            if len(args) != 4:
                raise RuntimeContractError("invalid MLR clip state", "validation")
            index = _integer(args[0], "MLR clip", 1, 16)
            value = {
                "index": index,
                "name": _text(args[1], "MLR clip name"),
                "length": _finite(args[2], "MLR clip length", 0, 3600),
                "bpm": _finite(args[3], "MLR clip BPM", 0, 10000),
            }
            return self._set("clips", index, value)

        if path == "/ingenue/mlr/pattern":
            if len(args) != 4:
                raise RuntimeContractError("invalid MLR pattern state", "validation")
            index = _integer(args[0], "MLR pattern", 1, 4)
            value = {
                "index": index,
                "recording": _flag(args[1], "MLR pattern recording"),
                "playing": _flag(args[2], "MLR pattern playing"),
                "count": _integer(args[3], "MLR pattern event count", 0, 1000000),
            }
            return self._set("patterns", index, value)

        if path == "/ingenue/mlr/recall":
            if len(args) != 5:
                raise RuntimeContractError("invalid MLR recall state", "validation")
            index = _integer(args[0], "MLR recall", 1, 4)
            value = {
                "index": index,
                "recording": _flag(args[1], "MLR recall recording"),
                "has_data": _flag(args[2], "MLR recall data"),
                "active": _flag(args[3], "MLR recall active"),
                "event_count": _integer(args[4], "MLR recall event count", 0, 1000000),
            }
            return self._set("recalls", index, value)

        return RuntimeAppliedAdapter.apply_runtime(self, path, args)


class MlrAppliedHub(SchemaRuntimeAppliedHub):
    """Advertise and publish the MLR observer channel."""

    def _channels(self, raw):
        if raw is None:
            return set(MLR_CHANNELS)
        if not isinstance(raw, list):
            raise RuntimeContractError("channels must be an array", "validation")
        requested = {str(item) for item in raw}
        unknown = requested - MLR_CHANNELS
        if unknown:
            raise RuntimeContractError(
                "unsupported channels: " + ", ".join(sorted(unknown)), "validation"
            )
        requested.add("runtime")
        return requested

    def _capabilities(self):
        capabilities = SchemaRuntimeAppliedHub._capabilities(self)
        channels = set(capabilities.get("channels") or [])
        channels.add("mlr")
        capabilities["channels"] = sorted(channels)
        capabilities["mlr"] = {
            "observer": True,
            "upstream": "tehn/mlr",
            "version": "2.2.5",
            "tracks": 6,
            "clips": 7,
            "patterns": 4,
            "recalls": 4,
            "grid": {"cols": 16, "rows": 8},
        }
        return capabilities
