import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from realtime_mlr import MlrAppliedAdapter, MlrAppliedHub, RuntimeContractError


class MemoryPeer:
    def __init__(self, channels=()):
        self.messages = []
        self.alive = True
        self.channels = set(channels)
        self.client_id = None

    def send(self, message):
        self.messages.append(message)


class MlrRealtimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        legacy = SimpleNamespace(
            PORT=7777, DUST="/dust", HERE=self.temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "mlr-test", osc_send=lambda *args: None,
        )
        self.adapter = MlrAppliedAdapter(
            legacy, realtime_port=7778, state_port=0,
            session_generation="runtime-mlr-test",
        )
        self.hub = MlrAppliedHub(self.adapter)

    def test_complete_mlr_snapshot_is_built_from_observer_messages(self):
        self.hub.ingest("/ingenue/mlr/meta", [1, "2.2.5", 2, 3, 0, 1])
        self.hub.ingest("/ingenue/mlr/clip", [1, "loop.wav", 8.0, 120.0])
        self.hub.ingest("/ingenue/mlr/track", [
            1, 1, 0, 1, 4, 9, 1, 6, -1, 1, 0,
            0.8, 1.0, 0.25, "loop.wav", 8.0, 120.0,
        ])
        self.hub.ingest("/ingenue/mlr/pattern", [1, 0, 1, 12])
        self.hub.ingest("/ingenue/mlr/recall", [1, 0, 1, 1, 4])
        state = self.adapter.snapshot()["mlr"]
        self.assertTrue(state["active"])
        self.assertEqual(state["view_name"], "cut")
        self.assertEqual(state["focus"], 3)
        self.assertTrue(state["quantize"])
        self.assertEqual(state["tracks"]["1"]["loop_start"], 4)
        self.assertTrue(state["tracks"]["1"]["reverse"])
        self.assertEqual(state["clips"]["1"]["name"], "loop.wav")
        self.assertEqual(state["patterns"]["1"]["count"], 12)
        self.assertTrue(state["recalls"]["1"]["active"])

    def test_mlr_state_rejects_impossible_or_malformed_values(self):
        with self.assertRaises(RuntimeContractError):
            self.adapter.apply_runtime("/ingenue/mlr/meta", [1, "2.2.5", 9, 1, 0, 0])
        with self.assertRaises(RuntimeContractError):
            self.adapter.apply_runtime("/ingenue/mlr/track", [
                1, 1, 0, 1, 12, 4, 1, 0, 0, 0, 0,
                1.0, 1.0, 0.0, "bad.wav", 4.0, 120.0,
            ])
        with self.assertRaises(RuntimeContractError):
            self.adapter.apply_runtime("/ingenue/mlr/clip", [8, "x", float("inf"), 120.0])

    def test_reset_removes_previous_script_state(self):
        self.adapter.apply_runtime("/ingenue/mlr/meta", [1, "2.2.5", 1, 1, 0, 0])
        channel, operations = self.adapter.apply_runtime("/ingenue/mlr/reset", [])
        self.assertEqual(channel, "mlr")
        self.assertFalse(self.adapter.mlr_state["active"])
        self.assertEqual(self.adapter.mlr_state["tracks"], {})
        self.assertEqual(operations[0]["path"], ["mlr"])

    def test_hello_and_subscription_advertise_the_observer_contract(self):
        peer = MemoryPeer()
        self.hub.register(peer)
        self.hub.handle(peer, {"v": 1, "type": "hello", "client_id": "browser-mlr-test"})
        hello = peer.messages[-1]
        self.assertIn("mlr", hello["capabilities"]["channels"])
        self.assertTrue(hello["capabilities"]["mlr"]["observer"])
        self.assertEqual(hello["capabilities"]["mlr"]["grid"], {"cols": 16, "rows": 8})
        self.hub.handle(peer, {"v": 1, "type": "subscribe", "channels": ["mlr"]})
        snapshot = peer.messages[-1]
        self.assertIn("mlr", snapshot["state"])
        self.assertIn("runtime", snapshot["state"])

    def test_mlr_module_keeps_python_37_grammar(self):
        source = (ROOT / "web" / "realtime_mlr.py").read_text(encoding="utf-8")
        ast.parse(source, filename="web/realtime_mlr.py", feature_version=(3, 7))


if __name__ == "__main__":
    unittest.main()
