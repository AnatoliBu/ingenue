import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_ownership import OwnershipAppliedAdapter, OwnershipAppliedHub


class Peer:
    def __init__(self):
        self.messages = []
        self.alive = True
        self.channels = set()

    def send(self, message):
        self.messages.append(message)


class OwnershipEdgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        legacy = SimpleNamespace(
            PORT=7777,
            DUST="/dust",
            HERE=self.temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            osc_send=lambda *args: self.calls.append(args),
        )
        adapter = OwnershipAppliedAdapter(legacy, 7778, 0, now=lambda: 1.0)
        self.hub = OwnershipAppliedHub(adapter, monotonic=lambda: 10.0)
        self.peer = Peer()
        self.hub.register(self.peer)
        self.hub.handle(self.peer, {"v": 1, "type": "hello", "client_id": "browser-edge"})
        self.peer.messages.clear()

    def send(self, command_id, command):
        self.hub.handle(self.peer, {
            "v": 1, "type": "command", "id": command_id, "command": command,
        })

    def test_invalid_command_never_claims_a_resource(self):
        self.send("invalid", {
            "target": "gamepad", "action": "button",
            "args": {"name": "NOT_A_BUTTON", "z": 1},
        })
        self.assertEqual(self.peer.messages[-1]["type"], "reject")
        self.assertNotIn("gamepad", self.hub.leases)
        self.assertEqual(self.calls, [])

    def test_explicit_release_balances_held_input_before_unlocking(self):
        self.send("press", {
            "target": "control", "action": "key", "args": {"n": 2, "z": 1},
        })
        self.hub.ingest("/ingenue/ack", ["wire-1"])
        before = len(self.calls)
        self.send("release-resource", {
            "target": "session", "action": "release", "args": {"resource": "control"},
        })
        self.assertEqual(len(self.calls), before + 1)
        self.assertEqual(self.calls[-1][-1], 0)
        self.assertNotIn("control", self.hub.leases)
        self.assertNotIn("browser-edge", self.hub.held)
        self.assertEqual(self.peer.messages[-1]["type"], "ack")

    def test_client_identity_cannot_change_mid_connection(self):
        self.hub.handle(self.peer, {"v": 1, "type": "hello", "client_id": "browser-other"})
        self.assertEqual(self.peer.messages[-1]["type"], "reject")
        self.assertEqual(self.peer.client_id, "browser-edge")


if __name__ == "__main__":
    unittest.main()
