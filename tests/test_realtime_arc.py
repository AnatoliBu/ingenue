import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_midi import MidiAppliedAdapter, MidiAppliedHub, RealtimeError


class MemoryPeer:
    def __init__(self, channels=()):
        self.messages = []
        self.alive = True
        self.channels = set(channels)

    def send(self, message):
        self.messages.append(message)


class ArcRealtimeTests(unittest.TestCase):
    def make_hub(self):
        temp = tempfile.TemporaryDirectory()
        calls = []
        legacy = SimpleNamespace(
            PORT=7777,
            DUST="/dust",
            HERE=temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            osc_send=lambda *args: calls.append(args),
        )
        adapter = MidiAppliedAdapter(
            legacy,
            realtime_port=7778,
            state_port=0,
            now=lambda: 12.5,
        )
        return temp, MidiAppliedHub(adapter), calls

    def test_arc_delta_routes_to_controller_path_and_waits_for_lua(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer({"control"})
        hub.register(peer)
        hub.handle(peer, {
            "v": 1,
            "type": "command",
            "id": "turn",
            "command": {
                "target": "arc",
                "action": "delta",
                "args": {"port": 1, "n": 3, "d": -8},
            },
        })
        self.assertEqual(peer.messages, [])
        self.assertEqual(calls[0], (
            "/ingenue/control-command",
            "sssiii",
            "wire-1",
            "arc",
            "delta",
            1,
            3,
            -8,
        ))
        hub.ingest("/ingenue/ack", ["wire-1"])
        self.assertEqual(peer.messages[-1]["type"], "ack")
        self.assertEqual(peer.messages[-1]["result"]["applied"]["target"], "arc")

    def test_arc_key_validation_rejects_before_dispatch(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {
            "v": 1,
            "type": "command",
            "id": "bad-key",
            "command": {
                "target": "arc",
                "action": "key",
                "args": {"port": 1, "n": 5, "z": 1},
            },
        })
        self.assertEqual(calls, [])
        self.assertEqual(peer.messages[-1]["type"], "reject")

    def test_arc_frame_is_authoritative_and_subscribable(self):
        temp, hub, _calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        frame = "0" * 255 + "f"
        hub.ingest("/ingenue/arc/frame", [1, 4, frame, 7, 12, 1])
        peer = MemoryPeer()
        hub.handle(peer, {
            "v": 1,
            "type": "subscribe",
            "channels": ["arc"],
        })
        snapshot = peer.messages[-1]
        self.assertEqual(snapshot["state"]["arc"]["ports"]["1"]["frame"], frame)
        self.assertEqual(snapshot["state"]["arc"]["ports"]["1"]["rings"], 4)
        self.assertEqual(snapshot["state"]["arc"]["ports"]["1"]["intensity"], 12)

    def test_arc_frame_validation_is_strict(self):
        temp, hub, _calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        with self.assertRaises(RealtimeError):
            hub.adapter.apply_runtime(
                "/ingenue/arc/frame",
                [1, 3, "0" * 192, 1, 15, 1],
            )
        with self.assertRaises(RealtimeError):
            hub.adapter.apply_runtime(
                "/ingenue/arc/frame",
                [1, 2, "x" * 128, 1, 15, 1],
            )

    def test_hello_advertises_native_arc_capability(self):
        temp, hub, _calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "hello"})
        capabilities = peer.messages[-1]["capabilities"]
        self.assertIn("arc", capabilities["channels"])
        self.assertIn("arc.delta", capabilities["commands"])
        self.assertEqual(capabilities["arc"]["leds_per_ring"], 64)


if __name__ == "__main__":
    unittest.main()
