#!/usr/bin/env python3
"""Unified browser ↔ matron runtime contract for Ingenue realtime.

This is the final production layer above the feature adapters. It adds runtime
and script generations, stale-command rejection, machine-readable errors, and
one authoritative capability/command registry without changing the public
controller APIs exposed by the lower adapters.
"""
from __future__ import annotations

import copy
import secrets
import time

try:
    from .realtime_bridge import PENDING_LIMIT, PendingCommand, RealtimeError
    from .realtime_ownership import (
        OWNERSHIP_CHANNELS,
        OWNERSHIP_COMMANDS,
        OwnershipAppliedAdapter,
        OwnershipAppliedHub,
        _command_resource,
        _held_transition,
        _resource,
    )
    from .realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope
except ImportError:
    from realtime_bridge import PENDING_LIMIT, PendingCommand, RealtimeError
    from realtime_ownership import (
        OWNERSHIP_CHANNELS,
        OWNERSHIP_COMMANDS,
        OwnershipAppliedAdapter,
        OwnershipAppliedHub,
        _command_resource,
        _held_transition,
        _resource,
    )
    from realtime_server import PROTOCOL_VERSION, RealtimeError as ProtocolRealtimeError, validate_envelope

ERROR_CODES = frozenset({
    "validation",
    "ownership",
    "unavailable",
    "matron-timeout",
    "runtime-error",
    "connection-lost",
    "stale-context",
})
RUNTIME_CHANNELS = frozenset(set(OWNERSHIP_CHANNELS) | {"runtime"})


class RuntimeContractError(RealtimeError):
    def __init__(self, message, code="runtime-error", retryable=False):
        RealtimeError.__init__(self, str(message))
        self.code = code if code in ERROR_CODES else "runtime-error"
        self.retryable = bool(retryable)


def _classified_error(error, default="runtime-error"):
    code = getattr(error, "code", None)
    if code not in ERROR_CODES:
        text = str(error).lower()
        if "another browser" in text or "controlled by" in text or "ownership" in text:
            code = "ownership"
        elif "acknowledgement timeout" in text:
            code = "matron-timeout"
        elif "dispatch failed" in text or "unavailable" in text:
            code = "unavailable"
        elif any(token in text for token in (
            "invalid", "unsupported", "must ", "required", "too many", "cannot change",
        )):
            code = "validation"
        else:
            code = default if default in ERROR_CODES else "runtime-error"
    retryable = bool(getattr(error, "retryable", code in {
        "unavailable", "matron-timeout", "connection-lost", "stale-context",
    }))
    return code, retryable


def _command_registry():
    entries = []
    for name in OWNERSHIP_COMMANDS:
        target, action = name.split(".", 1)
        entries.append({
            "name": name,
            "target": target,
            "action": action,
            "runtime_context": target not in {"session", "system"},
            "ownership": target in {"control", "param", "grid", "arc", "gamepad"},
        })
    return entries


class RuntimeAppliedAdapter(OwnershipAppliedAdapter):
    """Add process/script generations to the complete applied adapter stack."""

    def __init__(self, legacy, realtime_port, state_port, now=None, session_generation=None):
        kwargs = {}
        if now is not None:
            kwargs["now"] = now
        OwnershipAppliedAdapter.__init__(
            self, legacy, realtime_port=realtime_port, state_port=state_port, **kwargs
        )
        self.session_generation = str(session_generation or ("runtime-" + secrets.token_hex(8)))
        self.script_generation = 0
        self.script_state["generation"] = self.script_generation

    def runtime_context(self):
        return {
            "session_generation": self.session_generation,
            "script_generation": self.script_generation,
        }

    def validate_context(self, context):
        # Context-less commands remain accepted for protocol-v1 compatibility.
        # Current Ingenue browsers always attach context after the first snapshot.
        if context is None:
            return
        if not isinstance(context, dict):
            raise RuntimeContractError("command context must be an object", "validation")
        session_generation = str(context.get("session_generation") or "")
        script_generation = context.get("script_generation")
        if session_generation != self.session_generation:
            raise RuntimeContractError(
                "runtime session changed before command application",
                "stale-context",
                retryable=True,
            )
        if isinstance(script_generation, bool) or not isinstance(script_generation, int):
            raise RuntimeContractError("script generation must be an integer", "validation")
        if script_generation != self.script_generation:
            raise RuntimeContractError(
                "active script changed before command application",
                "stale-context",
                retryable=True,
            )

    def snapshot(self):
        state = OwnershipAppliedAdapter.snapshot(self)
        state["script"] = dict(state.get("script") or {})
        state["script"]["generation"] = self.script_generation
        state["runtime"] = self.runtime_context()
        return state

    def apply_runtime(self, path, args):
        previous = (
            bool(self.script_state.get("active")),
            str(self.script_state.get("name")),
            str(self.script_state.get("shortname")),
        )
        channel, operations = OwnershipAppliedAdapter.apply_runtime(self, path, args)
        if path != "/ingenue/script/state":
            return channel, operations
        current = (
            bool(self.script_state.get("active")),
            str(self.script_state.get("name")),
            str(self.script_state.get("shortname")),
        )
        if current != previous:
            self.script_generation += 1
        self.script_state["generation"] = self.script_generation
        return "script", [
            {"op": "set", "path": ["script"], "value": copy.deepcopy(self.script_state)},
            {"op": "set", "path": ["runtime"], "value": self.runtime_context()},
        ]


class RuntimeAppliedHub(OwnershipAppliedHub):
    """Final production hub with one settlement and lifecycle contract."""

    def _channels(self, raw):
        if raw is None:
            return set(RUNTIME_CHANNELS)
        if not isinstance(raw, list):
            raise RuntimeContractError("channels must be an array", "validation")
        requested = {str(item) for item in raw}
        unknown = requested - RUNTIME_CHANNELS
        if unknown:
            raise RuntimeContractError(
                "unsupported channels: " + ", ".join(sorted(unknown)), "validation"
            )
        requested.add("runtime")
        return requested

    def _context(self):
        return self.adapter.runtime_context()

    def _send_ack(self, peer, browser_id, result, revision=None):
        peer.send({
            "v": PROTOCOL_VERSION,
            "type": "ack",
            "id": browser_id,
            "rev": self.revision if revision is None else revision,
            "result": result,
            "context": self._context(),
        })

    def _send_reject(self, peer, browser_id, error, default="runtime-error"):
        code, retryable = _classified_error(error, default)
        peer.send({
            "v": PROTOCOL_VERSION,
            "type": "reject",
            "id": browser_id or "invalid",
            "rev": self.revision,
            "error": str(error),
            "code": code,
            "retryable": retryable,
            "context": self._context(),
        })

    def _capabilities(self):
        capabilities = OwnershipAppliedHub._capabilities(self)
        capabilities["runtime"] = {
            "context": True,
            "stale_command_rejection": True,
            "error_codes": sorted(ERROR_CODES),
            "session_generation": self.adapter.session_generation,
        }
        capabilities["command_registry"] = _command_registry()
        return capabilities

    def snapshot(self, channels):
        requested = set(channels) or set(RUNTIME_CHANNELS)
        with self.lock:
            state = self.adapter.snapshot()
            if "ownership" in requested:
                state["ownership"] = self._ownership_state_locked()
            revision = self.revision
        filtered = {name: state[name] for name in requested if name in state}
        return {"v": PROTOCOL_VERSION, "type": "snapshot", "rev": revision, "state": filtered}

    def _session_command(self, peer, message):
        browser_id = message.get("id")
        if not isinstance(browser_id, str) or not browser_id:
            raise RuntimeContractError("command id is required", "validation")
        command = message.get("command") or {}
        action = command.get("action")
        args = command.get("args") or {}
        if not isinstance(args, dict):
            raise RuntimeContractError("command args must be an object", "validation")
        client_id = self._ensure_client(peer)
        if action == "claim":
            resource = _resource(args.get("resource"))
            self._claim(client_id, resource)
            result = {"claimed": resource}
        elif action == "release":
            resource = _resource(args.get("resource"))
            result = {"released": resource if self._release_resource(client_id, resource) else None}
        elif action == "release_all":
            released_inputs, resources = self._release_all(client_id)
            result = {"released_inputs": released_inputs, "released_resources": resources}
        else:
            raise RuntimeContractError("unsupported session command", "validation")
        self._send_ack(peer, browser_id, result)

    def _command(self, peer, message):
        browser_id = message.get("id")
        if not isinstance(browser_id, str) or not browser_id:
            raise RuntimeContractError("command id is required", "validation")
        with self.lock:
            if len(self.pending) >= PENDING_LIMIT:
                raise RuntimeContractError("too many pending commands", "unavailable", retryable=True)
        self.adapter.validate_context(message.get("context"))
        wire_id = self._new_wire_id()
        prepared = self.adapter.prepare(wire_id, message.get("command"))
        if prepared.immediate_result is not None:
            self._send_ack(peer, browser_id, prepared.immediate_result)
            return
        with self.lock:
            self.pending[wire_id] = PendingCommand(
                peer, browser_id, prepared.command, self.monotonic() + 3.0
            )
        try:
            self.adapter.send_prepared(prepared)
        except RealtimeError:
            with self.lock:
                self.pending.pop(wire_id, None)
            raise

    def handle(self, peer, raw):
        try:
            message = validate_envelope(raw)
            kind = message["type"]
            if kind == "hello":
                supplied = message.get("client_id")
                client_id = self._bind_client(peer, supplied) if supplied else self._ensure_client(peer)
                peer.send({
                    "v": PROTOCOL_VERSION,
                    "type": "hello",
                    "server": "ingenue",
                    "client_id": client_id,
                    "capabilities": self._capabilities(),
                })
                return
            if kind == "subscribe":
                self._ensure_client(peer)
                peer.channels = self._channels(message.get("channels"))
                peer.send(self.snapshot(peer.channels))
                return
            if kind == "resync":
                self._ensure_client(peer)
                peer.send(self.snapshot(peer.channels or set(RUNTIME_CHANNELS)))
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
                created = False
                if resource:
                    self.adapter.prepare("ownership-validation", command)
                    created = self._claim(client_id, resource)
                try:
                    self._command(peer, message)
                except RealtimeError:
                    if created:
                        self._release_resource(client_id, resource)
                    raise
                return
        except (RealtimeError, ProtocolRealtimeError) as error:
            command_id = raw.get("id") if isinstance(raw, dict) else None
            self._send_reject(peer, command_id, error, default="validation")

    def _track_held(self, pending):
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

    def ingest(self, path, args):
        if path == "/ingenue/ack":
            wire_id = str(args[0]) if args else ""
            with self.lock:
                pending = self.pending.pop(wire_id, None)
            if pending is None:
                return
            revision = self.publish("control", self.adapter.record_applied(pending.command))
            if pending.peer.alive:
                self._send_ack(pending.peer, pending.browser_id, {"applied": pending.command}, revision)
            self._track_held(pending)
            return
        if path == "/ingenue/reject":
            wire_id = str(args[0]) if args else ""
            error = str(args[1]) if len(args) > 1 else "Lua rejected command"
            with self.lock:
                pending = self.pending.pop(wire_id, None)
            if pending is not None and pending.peer.alive:
                self._send_reject(pending.peer, pending.browser_id, error, default="runtime-error")
            return
        channel, operations = self.adapter.apply_runtime(path, args)
        if channel:
            self.publish(channel, operations)

    def expire_pending(self, now=None):
        instant = self.monotonic() if now is None else now
        expired = []
        expired_resources = []
        with self.lock:
            for wire_id, pending in list(self.pending.items()):
                if pending.deadline <= instant:
                    expired.append(pending)
                    del self.pending[wire_id]
            for resource, lease in list(self.leases.items()):
                if lease.deadline is not None and lease.deadline <= instant:
                    self.leases.pop(resource, None)
                    expired_resources.append(resource)
        for pending in expired:
            if pending.peer.alive:
                try:
                    self._send_reject(
                        pending.peer,
                        pending.browser_id,
                        RuntimeContractError(
                            "matron acknowledgement timeout", "matron-timeout", retryable=True
                        ),
                    )
                except OSError:
                    pass
        for resource in expired_resources:
            self._publish_resource(resource)
        return len(expired) + len(expired_resources)
