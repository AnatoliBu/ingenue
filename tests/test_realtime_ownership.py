import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_ownership import OwnershipAppliedAdapter, OwnershipAppliedHub


class Clock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value


class MemoryPeer:
    def __init__(self, channels=()):
        self.messages = []
        self.alive = True
        self.channels = set(channels)

    def send(self, message):
        self.messages.append(message)


class OwnershipTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.clock = Clock()
        legacy = SimpleNamespace(
            PORT=7777,
            DUST="/dust",
            HERE=self.temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            osc_send=lambda *args: self.calls.append(args),
        )
        adapter = OwnershipAppliedAdapter(
            legacy, realtime_port=7778, state_port=0, now=lambda: 12.5
        )
        self.hub = OwnershipAppliedHub(adapter, monotonic=self.clock, lease_grace=5.0)

    def peer(self, client_id, channels=()):
        peer = MemoryPeer(channels)
        self.hub.register(peer)
        self.hub.handle(peer, {"v": 1, "type": "hello", "client_id": client_id})
        peer.messages.clear()
        return peer

    def command(self, peer, command_id, command):
        self.hub.handle(peer, {
            "v": 1, "type": "command", "id": command_id, "command": command,
        })

    def test_first_browser_claims_resource_and_other_browser_is_rejected(self):
        first = self.peer("browser-one")
        second = self.peer("browser-two")
        self.command(first, "first-key", {
            "target": "control", "action": "key", "args": {"n": 1, "z": 1},
        })
        self.assertEqual(self.calls[-1][0], "/ingenue/command")
        self.command(second, "second-key", {
            "target": "control", "action": "key", "args": {"n": 2, "z": 1},
        })
        self.assertEqual(second.messages[-1]["type"], "reject")
        self.assertIn("another browser", second.messages[-1]["error"])
        self.assertEqual(self.hub.leases["control"].client_id, "browser-one")

    def test_disconnect_releases_applied_holds_and_keeps_short_reconnect_lease(self):
        peer = self.peer("browser-hold")
        self.command(peer, "hold", {
            "target": "grid", "action": "key",
            "args": {"port": 2, "x": 3, "y": 4, "z": 1},
        })
        self.hub.ingest("/ingenue/ack", ["wire-1"])
        self.assertIn("browser-hold", self.hub.held)
        self.hub.unregister(peer)
        release = self.calls[-1]
        self.assertEqual(release[0], "/ingenue/command")
        self.assertEqual(release[-1], 0)
        self.assertNotIn("browser-hold", self.hub.held)
        self.assertIsNotNone(self.hub.leases["grid:2"].deadline)

        replacement = self.peer("browser-hold")
        self.assertIsNone(self.hub.leases["grid:2"].deadline)
        self.command(replacement, "again", {
            "target": "grid", "action": "key",
            "args": {"port": 2, "x": 3, "y": 4, "z": 1},
        })
        self.assertNotEqual(replacement.messages[-1]["type"] if replacement.messages else None, "reject")

    def test_lease_expires_after_reconnect_grace(self):
        peer = self.peer("browser-expire")
        self.command(peer, "turn", {
            "target": "arc", "action": "delta", "args": {"port": 4, "n": 1, "d": 1},
        })
        self.hub.unregister(peer)
        self.clock.value += 5.1
        self.hub.expire_pending()
        self.assertNotIn("arc:4", self.hub.leases)
        other = self.peer("browser-other")
        self.command(other, "turn-2", {
            "target": "arc", "action": "delta", "args": {"port": 4, "n": 1, "d": 1},
        })
        self.assertEqual(self.hub.leases["arc:4"].client_id, "browser-other")

    def test_last_tab_only_triggers_release(self):
        first = self.peer("browser-shared")
        second = self.peer("browser-shared")
        self.command(first, "pad", {
            "target": "gamepad", "action": "button", "args": {"name": "A", "z": 1},
        })
        self.hub.ingest("/ingenue/ack", ["wire-1"])
        before = len(self.calls)
        self.hub.unregister(first)
        self.assertEqual(len(self.calls), before)
        self.hub.unregister(second)
        self.assertEqual(len(self.calls), before + 1)
        self.assertEqual(self.calls[-1][-1], 0)

    def test_snapshot_and_hello_expose_ownership_contract(self):
        peer = self.peer("browser-state")
        self.command(peer, "param", {
            "target": "param", "action": "set_normalized",
            "args": {"id": "cutoff", "value": 0.5},
        })
        observer = self.peer("browser-observer")
        self.hub.handle(observer, {
            "v": 1, "type": "subscribe", "channels": ["ownership"],
        })
        ownership = observer.messages[-1]["state"]["ownership"]
        self.assertEqual(ownership["resources"]["params"]["client_id"], "browser-state")
        self.assertEqual(ownership["lease_grace_ms"], 5000)

        hello = MemoryPeer()
        self.hub.register(hello)
        self.hub.handle(hello, {"v": 1, "type": "hello", "client_id": "browser-hello"})
        self.assertIn("session.release_all", hello.messages[-1]["capabilities"]["commands"])
        self.assertTrue(hello.messages[-1]["capabilities"]["ownership"]["release_on_disconnect"])

    def test_ownership_module_keeps_python_37_grammar(self):
        source = (ROOT / "web" / "realtime_ownership.py").read_text(encoding="utf-8")
        ast.parse(source, filename="web/realtime_ownership.py", feature_version=(3, 7))


if __name__ == "__main__":
    unittest.main()
