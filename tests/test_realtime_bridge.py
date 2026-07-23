import struct
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_bridge import (  # noqa: E402
    AppliedAdapter,
    AppliedHub,
    RealtimeError,
    StateBridge,
    decode_osc,
)


class RecordingPeer:
    def __init__(self, channels=()):
        self.channels = set(channels)
        self.messages = []
        self.alive = True

    def send(self, message):
        self.messages.append(message)


def osc_string(value):
    raw = value.encode("utf-8") + b"\0"
    return raw + b"\0" * ((-len(raw)) % 4)


def osc_message(path, types, *args):
    out = osc_string(path) + osc_string("," + types)
    for tag, value in zip(types, args, strict=True):
        if tag == "i":
            out += struct.pack(">i", value)
        elif tag == "f":
            out += struct.pack(">f", value)
        elif tag == "s":
            out += osc_string(value)
    return out


class RealtimeBridgeTests(unittest.TestCase):
    def make_hub(self, monotonic=lambda: 10.0):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        calls = []
        legacy = SimpleNamespace(
            HERE=temporary.name,
            PORT=7777,
            DUST="/dust",
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            osc_send=lambda *args: calls.append(args),
        )
        adapter = AppliedAdapter(
            legacy,
            realtime_port=7778,
            state_port=7779,
            now=lambda: 12.5,
        )
        return AppliedHub(adapter, monotonic=monotonic), calls, legacy

    def test_osc_decoder_supports_int_float_and_string(self):
        path, args = decode_osc(osc_message("/ingenue/test", "ifs", 7, 0.5, "ok"))
        self.assertEqual(path, "/ingenue/test")
        self.assertEqual(args[0], 7)
        self.assertAlmostEqual(args[1], 0.5)
        self.assertEqual(args[2], "ok")
        with self.assertRaises(RealtimeError):
            decode_osc(b"#bundle\0")

    def test_command_is_not_acknowledged_until_lua_ack(self):
        hub, calls, _legacy = self.make_hub()
        peer = RecordingPeer({"control"})
        hub.register(peer)
        hub.handle(
            peer,
            {
                "v": 1,
                "type": "command",
                "id": "cmd-1",
                "command": {
                    "target": "control",
                    "action": "enc",
                    "args": {"n": 2, "d": -3},
                },
            },
        )
        self.assertEqual(peer.messages, [])
        self.assertEqual(calls[0][:3], ("/ingenue/command", "sssii", "wire-1"))
        hub.ingest("/ingenue/ack", ["wire-1"])
        self.assertEqual([message["type"] for message in peer.messages], ["delta", "ack"])
        self.assertEqual(peer.messages[-1]["id"], "cmd-1")
        self.assertEqual(peer.messages[-1]["result"]["applied"]["args"], {"n": 2, "d": -3})

    def test_pending_is_registered_before_fast_lua_ack(self):
        hub, _calls, legacy = self.make_hub()
        peer = RecordingPeer({"control"})
        hub.register(peer)

        def instant_ack(_path, _types, wire_id, *_args):
            hub.ingest("/ingenue/ack", [wire_id])

        legacy.osc_send = instant_ack
        hub.handle(
            peer,
            {
                "v": 1,
                "type": "command",
                "id": "fast",
                "command": {
                    "target": "control",
                    "action": "key",
                    "args": {"n": 1, "z": 1},
                },
            },
        )
        self.assertEqual(peer.messages[-1]["type"], "ack")
        self.assertEqual(peer.messages[-1]["id"], "fast")
        self.assertEqual(hub.pending, {})

    def test_same_browser_id_from_two_peers_uses_unique_wire_ids(self):
        hub, calls, _legacy = self.make_hub()
        left = RecordingPeer({"control"})
        right = RecordingPeer({"control"})
        hub.register(left)
        hub.register(right)
        command = {
            "v": 1,
            "type": "command",
            "id": "cmd-1",
            "command": {
                "target": "control",
                "action": "key",
                "args": {"n": 2, "z": 1},
            },
        }
        hub.handle(left, command)
        hub.handle(right, command)
        self.assertEqual([call[2] for call in calls], ["wire-1", "wire-2"])
        hub.ingest("/ingenue/ack", ["wire-2"])
        right_ack = next(message for message in right.messages if message["type"] == "ack")
        self.assertEqual(right_ack["id"], "cmd-1")
        self.assertFalse(any(message["type"] == "ack" for message in left.messages))
        hub.ingest("/ingenue/ack", ["wire-1"])
        left_ack = next(message for message in left.messages if message["type"] == "ack")
        self.assertEqual(left_ack["id"], "cmd-1")

    def test_lua_reject_and_timeout_settle_browser_id(self):
        hub, _calls, _legacy = self.make_hub()
        peer = RecordingPeer({"control"})
        hub.register(peer)
        hub.handle(
            peer,
            {
                "v": 1,
                "type": "command",
                "id": "bad",
                "command": {
                    "target": "control",
                    "action": "key",
                    "args": {"n": 1, "z": 1},
                },
            },
        )
        hub.ingest("/ingenue/reject", ["wire-1", "script refused"])
        self.assertEqual(
            peer.messages[-1],
            {"v": 1, "type": "reject", "id": "bad", "error": "script refused"},
        )
        hub.handle(
            peer,
            {
                "v": 1,
                "type": "command",
                "id": "lost",
                "command": {
                    "target": "control",
                    "action": "key",
                    "args": {"n": 1, "z": 0},
                },
            },
        )
        self.assertEqual(hub.expire_pending(14.0), 1)
        self.assertEqual(peer.messages[-1]["id"], "lost")
        self.assertIn("timeout", peer.messages[-1]["error"])

    def test_dispatch_failure_rejects_and_removes_pending(self):
        hub, _calls, legacy = self.make_hub()
        peer = RecordingPeer({"control"})
        hub.register(peer)

        def fail_dispatch(*_args):
            raise OSError("down")

        legacy.osc_send = fail_dispatch
        hub.handle(
            peer,
            {
                "v": 1,
                "type": "command",
                "id": "x",
                "command": {
                    "target": "control",
                    "action": "enc",
                    "args": {"n": 1, "d": 1},
                },
            },
        )
        self.assertEqual(peer.messages[-1]["type"], "reject")
        self.assertEqual(peer.messages[-1]["id"], "x")
        self.assertEqual(hub.pending, {})

    def test_hidden_channel_receives_empty_delta_to_keep_revision_order(self):
        hub, _calls, _legacy = self.make_hub()
        control = RecordingPeer({"control"})
        grid = RecordingPeer({"grid"})
        hub.register(control)
        hub.register(grid)
        hub.ingest("/ingenue/grid/frame", [1, 2, 2, "0f80", 1, 15, 1])
        self.assertEqual(control.messages[0]["rev"], 1)
        self.assertEqual(control.messages[0]["operations"], [])
        self.assertEqual(grid.messages[0]["operations"][0]["path"], ["grid", "ports", "1"])

    def test_script_and_grid_state_are_authoritative_snapshots(self):
        hub, _calls, _legacy = self.make_hub()
        hub.ingest("/ingenue/script/state", [1, "awake", "awake"])
        hub.ingest("/ingenue/grid/frame", [1, 2, 2, "012f", 3, 12, 1])
        peer = RecordingPeer()
        hub.handle(
            peer,
            {"v": 1, "type": "subscribe", "channels": ["script", "grid"]},
        )
        snapshot = peer.messages[0]
        self.assertEqual(snapshot["rev"], 2)
        self.assertTrue(snapshot["state"]["script"]["active"])
        self.assertEqual(snapshot["state"]["grid"]["ports"]["1"]["frame"], "012f")

    def test_grid_frame_validation_is_strict(self):
        hub, _calls, _legacy = self.make_hub()
        with self.assertRaises(RealtimeError):
            hub.adapter.apply_runtime(
                "/ingenue/grid/frame",
                [1, 2, 2, "xyz", 1, 15, 1],
            )
        with self.assertRaises(RealtimeError):
            hub.adapter.prepare(
                "wire",
                {
                    "target": "grid",
                    "action": "key",
                    "args": {"port": 1, "x": 1.5, "y": 1, "z": 1},
                },
            )

    def test_state_bridge_binds_before_thread_start(self):
        hub, _calls, _legacy = self.make_hub()
        bridge = StateBridge(hub, "127.0.0.1", 0)
        try:
            self.assertGreater(bridge.port, 0)
        finally:
            bridge.close()


if __name__ == "__main__":
    unittest.main()
