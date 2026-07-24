import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_params import ParamAppliedAdapter, ParamAppliedHub, RealtimeError


class MemoryPeer:
    def __init__(self, channels=()):
        self.messages = []
        self.alive = True
        self.channels = set(channels)

    def send(self, message):
        self.messages.append(message)


class ControllerLifecycleTests(unittest.TestCase):
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
        adapter = ParamAppliedAdapter(
            legacy,
            realtime_port=7778,
            state_port=0,
            now=lambda: 12.5,
        )
        return temp, ParamAppliedHub(adapter), calls

    def test_arc_configuration_is_lua_applied_through_production_hub(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer({"arc"})
        hub.register(peer)
        hub.handle(peer, {
            "v": 1,
            "type": "command",
            "id": "arc-profile",
            "command": {
                "target": "arc",
                "action": "configure",
                "args": {"port": 3, "rings": 2},
            },
        })
        self.assertEqual(peer.messages, [])
        self.assertEqual(calls[0], (
            "/ingenue/control-command", "sssii",
            "wire-1", "arc", "configure", 3, 2,
        ))
        hub.ingest("/ingenue/ack", ["wire-1"])
        self.assertEqual(peer.messages[-1]["type"], "ack")
        self.assertEqual(peer.messages[-1]["result"]["applied"]["args"], {"port": 3, "rings": 2})

    def test_arc_configuration_rejects_invalid_ring_count_before_osc(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {
            "v": 1,
            "type": "command",
            "id": "bad-rings",
            "command": {
                "target": "arc",
                "action": "configure",
                "args": {"port": 1, "rings": 3},
            },
        })
        self.assertEqual(calls, [])
        self.assertEqual(peer.messages[-1]["type"], "reject")

    def test_arc_disconnect_removes_stale_port_from_snapshot(self):
        temp, hub, _calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        hub.ingest("/ingenue/arc/frame", [2, 2, "f" * 128, 1, 15, 1])
        self.assertIn("2", hub.adapter.arc_state["ports"])
        hub.ingest("/ingenue/arc/disconnect", [2])
        self.assertNotIn("2", hub.adapter.arc_state["ports"])
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "subscribe", "channels": ["arc"]})
        self.assertNotIn("2", peer.messages[-1]["state"]["arc"]["ports"])

    def test_production_hello_advertises_persistent_arc_configuration(self):
        temp, hub, _calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "hello"})
        capabilities = peer.messages[-1]["capabilities"]
        self.assertIn("arc.configure", capabilities["commands"])
        self.assertEqual(capabilities["arc"]["ports"], [1, 2, 3, 4])
        self.assertTrue(capabilities["arc"]["persistent"])

    def test_lifecycle_extension_parses_with_python_37(self):
        source = (ROOT / "web" / "realtime_controller_lifecycle.py").read_text(encoding="utf-8")
        ast.parse(source, filename="web/realtime_controller_lifecycle.py", feature_version=(3, 7))


if __name__ == "__main__":
    unittest.main()
