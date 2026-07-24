import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_params import ParamAppliedAdapter, ParamAppliedHub, RealtimeError


class MemoryPeer:
    def __init__(self):
        self.messages = []
        self.alive = True
        self.channels = set()

    def send(self, message):
        self.messages.append(message)


class ParamsBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        legacy = SimpleNamespace(
            PORT=7777, DUST="/dust", HERE=self.temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            osc_send=lambda *args: self.calls.append(args),
        )
        self.adapter = ParamAppliedAdapter(legacy, 7778, 7779, now=lambda: 12.5)

    def test_catalog_and_trigger_route_to_shared_dispatcher(self):
        catalog = self.adapter.prepare("wire-1", {"target": "param", "action": "catalog", "args": {}})
        trigger = self.adapter.prepare("wire-2", {"target": "param", "action": "trigger", "args": {"id": "fire"}})
        self.assertEqual(catalog.osc_args, ("wire-1", "params", "catalog"))
        self.assertEqual(trigger.osc_args, ("wire-2", "params", "trigger", "fire"))
        self.adapter.send_prepared(catalog)
        self.assertEqual(self.calls[0][0], "/ingenue/control-command")

    def test_catalog_generation_commits_atomically(self):
        self.adapter.apply_runtime("/ingenue/params/start", ["7", 1, "awake"])
        self.adapter.apply_runtime("/ingenue/params/item", [
            "7", 1, 2, "mode", "Mode", "option", 0.5,
            "2", "1", "3", "B", "", 1, 3,
        ])
        for index, label in enumerate(("A", "B", "C"), 1):
            self.adapter.apply_runtime("/ingenue/params/option", ["7", 1, index, label])
        channel, operations = self.adapter.apply_runtime("/ingenue/params/end", ["7", 1])
        self.assertEqual(channel, "params")
        self.assertEqual(operations[0]["value"]["items"][0]["options"], ["A", "B", "C"])
        self.assertEqual(self.adapter.params_state["script"], "awake")

    def test_incomplete_catalog_is_rejected_without_replacing_state(self):
        before = self.adapter.snapshot()["params"]
        self.adapter.apply_runtime("/ingenue/params/start", ["8", 1, "awake"])
        with self.assertRaises(RealtimeError):
            self.adapter.apply_runtime("/ingenue/params/end", ["8", 1])
        self.assertEqual(self.adapter.snapshot()["params"], before)

    def test_hello_advertises_params_channel(self):
        hub = ParamAppliedHub(self.adapter)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "hello"})
        capabilities = peer.messages[-1]["capabilities"]
        self.assertIn("params", capabilities["channels"])
        self.assertIn("param.catalog", capabilities["commands"])
        self.assertTrue(capabilities["params"]["automatic_panel"])

    def test_sources_keep_python_37_grammar(self):
        for relative in ("web/realtime_params.py", "web/realtime_secure.py"):
            ast.parse((ROOT / relative).read_text(encoding="utf-8"), filename=relative, feature_version=(3, 7))


class ParamsLuaStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = ROOT / "web" / "lib"
        cls.source = (root / "ingenue_params.lua").read_text(encoding="utf-8")
        cls.loader = (root / "mod.lua").read_text(encoding="utf-8")

    def test_catalog_is_atomic_and_refreshable(self):
        for needle in ("/ingenue/params/start", "/ingenue/params/item", "/ingenue/params/option", "/ingenue/params/end"):
            self.assertIn(needle, self.source)
        self.assertIn("dispatcher.register_handler('params', handler)", self.source)
        self.assertIn("script_post_init", self.source)
        self.assertIn("require 'ingenue_params'", self.loader)

    def test_trigger_is_explicit_and_strict(self):
        self.assertIn("parameter is not a trigger", self.source)
        self.assertIn("params:set(id, 1)", self.source)

    def test_no_dynamic_code_or_shell(self):
        self.assertNotRegex(self.source, r"\bloadstring\s*\(")
        self.assertNotRegex(self.source, r"\bos\.execute\s*\(")
        self.assertNotRegex(self.source, r"\bio\.popen\s*\(")


if __name__ == "__main__":
    unittest.main()
