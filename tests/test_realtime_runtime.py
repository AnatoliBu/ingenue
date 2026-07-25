import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_runtime import RuntimeAppliedAdapter, RuntimeAppliedHub


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


class RuntimeContractTests(unittest.TestCase):
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
        self.adapter = RuntimeAppliedAdapter(
            legacy,
            realtime_port=7778,
            state_port=0,
            now=lambda: 12.5,
            session_generation="runtime-test-session",
        )
        self.hub = RuntimeAppliedHub(self.adapter, monotonic=self.clock, lease_grace=5.0)

    def peer(self, client_id="browser-runtime"):
        peer = MemoryPeer()
        self.hub.register(peer)
        self.hub.handle(peer, {"v": 1, "type": "hello", "client_id": client_id})
        return peer

    def context(self):
        return self.adapter.runtime_context()

    def command(self, peer, command_id, command, context=None):
        message = {"v": 1, "type": "command", "id": command_id, "command": command}
        if context is not None:
            message["context"] = context
        self.hub.handle(peer, message)

    def test_snapshot_and_hello_publish_one_runtime_contract(self):
        peer = self.peer()
        hello = peer.messages[-1]
        runtime = hello["capabilities"]["runtime"]
        self.assertTrue(runtime["context"])
        self.assertTrue(runtime["stale_command_rejection"])
        self.assertIn("stale-context", runtime["error_codes"])
        registry = {item["name"]: item for item in hello["capabilities"]["command_registry"]}
        self.assertTrue(registry["control.key"]["runtime_context"])
        self.assertFalse(registry["session.release_all"]["runtime_context"])

        self.hub.handle(peer, {"v": 1, "type": "subscribe", "channels": ["script"]})
        state = peer.messages[-1]["state"]
        self.assertEqual(state["runtime"], self.context())
        self.assertEqual(state["script"]["generation"], 0)

    def test_applied_ack_carries_the_context_used_by_the_runtime(self):
        peer = self.peer()
        peer.messages.clear()
        self.command(peer, "key", {
            "target": "control", "action": "key", "args": {"n": 1, "z": 1},
        }, self.context())
        self.assertEqual(self.calls[-1][0], "/ingenue/command")
        self.hub.ingest("/ingenue/ack", ["wire-1"])
        ack = peer.messages[-1]
        self.assertEqual(ack["type"], "ack")
        self.assertEqual(ack["context"], self.context())
        self.assertEqual(ack["result"]["applied"]["action"], "key")

    def test_script_switch_invalidates_old_browser_commands_before_osc(self):
        peer = self.peer()
        old_context = self.context()
        self.hub.ingest("/ingenue/script/state", [1, "new-script", "new-script"])
        self.assertEqual(self.adapter.script_generation, 1)
        before = len(self.calls)
        self.command(peer, "stale", {
            "target": "control", "action": "enc", "args": {"n": 2, "d": 1},
        }, old_context)
        reject = peer.messages[-1]
        self.assertEqual(reject["type"], "reject")
        self.assertEqual(reject["code"], "stale-context")
        self.assertTrue(reject["retryable"])
        self.assertEqual(reject["context"], self.context())
        self.assertEqual(len(self.calls), before)
        self.assertNotIn("control", self.hub.leases)

    def test_timeout_and_ownership_rejections_are_machine_readable(self):
        first = self.peer("browser-first")
        second = self.peer("browser-second")
        self.command(first, "turn", {
            "target": "arc", "action": "delta", "args": {"port": 2, "n": 1, "d": 1},
        }, self.context())
        self.command(second, "blocked", {
            "target": "arc", "action": "delta", "args": {"port": 2, "n": 2, "d": 1},
        }, self.context())
        self.assertEqual(second.messages[-1]["code"], "ownership")
        self.assertFalse(second.messages[-1]["retryable"])

        self.clock.value += 3.1
        self.hub.expire_pending()
        timeout = first.messages[-1]
        self.assertEqual(timeout["code"], "matron-timeout")
        self.assertTrue(timeout["retryable"])

    def test_lua_rejection_is_a_runtime_error(self):
        peer = self.peer()
        self.command(peer, "bad-runtime", {
            "target": "param", "action": "set", "args": {"id": "cutoff", "value": 0.25},
        }, self.context())
        self.hub.ingest("/ingenue/reject", ["wire-1", "script callback failed"])
        reject = peer.messages[-1]
        self.assertEqual(reject["code"], "runtime-error")
        self.assertFalse(reject["retryable"])

    def test_runtime_module_keeps_python_37_grammar(self):
        source = (ROOT / "web" / "realtime_runtime.py").read_text(encoding="utf-8")
        ast.parse(source, filename="web/realtime_runtime.py", feature_version=(3, 7))


if __name__ == "__main__":
    unittest.main()
