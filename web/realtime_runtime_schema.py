#!/usr/bin/env python3
"""Authoritative command schemas published by the production realtime runtime.

The Python adapters remain the final validators. These compact schemas let the
browser reject obvious contract drift before a command reaches WebSocket/OSC.
Only the deliberately small schema vocabulary implemented by runtime-contract.js
is emitted here.
"""
from __future__ import annotations

import copy

try:
    from .realtime_gamepad import GAMEPAD_ANALOG_AXES, GAMEPAD_BUTTONS
    from .realtime_ownership import OWNERSHIP_COMMANDS
    from .realtime_runtime import RuntimeAppliedHub, RuntimeContractError
except ImportError:
    from realtime_gamepad import GAMEPAD_ANALOG_AXES, GAMEPAD_BUTTONS
    from realtime_ownership import OWNERSHIP_COMMANDS
    from realtime_runtime import RuntimeAppliedHub, RuntimeContractError

PARAM_ID_PATTERN = r"^[A-Za-z0-9_.:-]{1,128}$"
OWNERSHIP_RESOURCES = (
    "control", "params", "gamepad",
    "grid:1", "grid:2", "grid:3", "grid:4",
    "arc:1", "arc:2", "arc:3", "arc:4",
)


def _integer(minimum, maximum, enum=None):
    field = {"type": "integer", "minimum": minimum, "maximum": maximum}
    if enum is not None:
        field["enum"] = list(enum)
    return field


def _number(minimum=None, maximum=None):
    field = {"type": "number"}
    if minimum is not None:
        field["minimum"] = minimum
    if maximum is not None:
        field["maximum"] = maximum
    return field


def _string(pattern=None, enum=None):
    field = {"type": "string"}
    if pattern is not None:
        field["pattern"] = pattern
    if enum is not None:
        field["enum"] = list(enum)
    return field


def _object(required=(), properties=None):
    return {
        "type": "object",
        "additional": False,
        "required": list(required),
        "properties": dict(properties or {}),
    }


EMPTY = _object()
PARAM_ID = _string(pattern=PARAM_ID_PATTERN)
PORT = _integer(1, 4)
KEY_STATE = _integer(0, 1, enum=(0, 1))
DELTA = _integer(-127, 127)

COMMAND_SCHEMAS = {
    "system.ping": EMPTY,
    "control.enc": _object(("n", "d"), {"n": _integer(1, 3), "d": DELTA}),
    "control.key": _object(("n", "z"), {"n": _integer(1, 3), "z": KEY_STATE}),
    "grid.key": _object(("x", "y", "z"), {
        "port": PORT, "x": _integer(1, 32), "y": _integer(1, 32), "z": KEY_STATE,
    }),
    "grid.configure": _object(("port", "cols", "rows", "rotation"), {
        "port": PORT,
        "cols": _integer(8, 16, enum=(8, 16)),
        "rows": _integer(8, 16, enum=(8, 16)),
        "rotation": _integer(0, 3),
    }),
    "arc.delta": _object(("n", "d"), {"port": PORT, "n": _integer(1, 4), "d": DELTA}),
    "arc.key": _object(("n", "z"), {"port": PORT, "n": _integer(1, 4), "z": KEY_STATE}),
    "arc.configure": _object(("port", "rings"), {
        "port": PORT, "rings": _integer(2, 4, enum=(2, 4)),
    }),
    "param.set": _object(("id", "value"), {"id": PARAM_ID, "value": _number()}),
    "param.describe": _object(("id",), {"id": PARAM_ID}),
    "param.set_normalized": _object(("id", "value"), {
        "id": PARAM_ID, "value": _number(0, 1),
    }),
    "param.delta": _object(("id", "d"), {"id": PARAM_ID, "d": DELTA}),
    "param.catalog": EMPTY,
    "param.trigger": _object(("id",), {"id": PARAM_ID}),
    "gamepad.button": _object(("name", "z"), {
        "name": _string(enum=sorted(GAMEPAD_BUTTONS)), "z": KEY_STATE,
    }),
    "gamepad.dpad": _object(("axis", "sign"), {
        "axis": _string(enum=("X", "Y")), "sign": _integer(-1, 1),
    }),
    "gamepad.analog": _object(("axis", "value"), {
        "axis": _string(enum=sorted(GAMEPAD_ANALOG_AXES)), "value": _number(-1, 1),
    }),
    "session.claim": _object(("resource",), {
        "resource": _string(enum=OWNERSHIP_RESOURCES),
    }),
    "session.release": _object(("resource",), {
        "resource": _string(enum=OWNERSHIP_RESOURCES),
    }),
    "session.release_all": EMPTY,
}


def command_registry():
    missing = set(OWNERSHIP_COMMANDS) - set(COMMAND_SCHEMAS)
    unexpected = set(COMMAND_SCHEMAS) - set(OWNERSHIP_COMMANDS)
    if missing or unexpected:
        raise RuntimeContractError(
            "command schema registry mismatch (missing: {}; unexpected: {})".format(
                ", ".join(sorted(missing)) or "none",
                ", ".join(sorted(unexpected)) or "none",
            ),
            "unavailable",
        )
    entries = []
    for name in OWNERSHIP_COMMANDS:
        target, action = name.split(".", 1)
        entries.append({
            "name": name,
            "target": target,
            "action": action,
            "runtime_context": target not in {"session", "system"},
            "ownership": target in {"control", "param", "grid", "arc", "gamepad"},
            "args_schema": copy.deepcopy(COMMAND_SCHEMAS[name]),
        })
    return entries


class SchemaRuntimeAppliedHub(RuntimeAppliedHub):
    """Production RuntimeAppliedHub with authoritative browser schemas."""

    def _capabilities(self):
        capabilities = RuntimeAppliedHub._capabilities(self)
        capabilities["command_registry"] = command_registry()
        runtime = dict(capabilities.get("runtime") or {})
        runtime["command_schemas"] = True
        capabilities["runtime"] = runtime
        return capabilities
