import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_gamepad import GamepadAppliedAdapter, GamepadAppliedHub, RealtimeError


class MemoryPeer:
    def __init__(self):
        self.messages = []
        self.alive = True
        self.channels = set()

    def send(self, message):
        self.messages.append(message)


class GamepadBridgeTests(unittest.TestCase):
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
        self.adapter = GamepadAppliedAdapter(legacy, 7778, 7779, now=lambda: 12.5)

    def test_button_is_strict_and_routes_to_shared_dispatcher(self):
        prepared = self.adapter.prepare("wire", {
            "target": "gamepad", "action": "button", "args": {"name": "a", "z": 1},
        })
        self.assertEqual(prepared.osc_types, "ssssi")
        self.assertEqual(prepared.osc_args, ("wire", "gamepad", "button", "A", 1))
        self.adapter.send_prepared(prepared)
        self.assertEqual(self.calls[0][0], "/ingenue/control-command")

    def test_dpad_accepts_only_native_axes_and_signs(self):
        prepared = self.adapter.prepare("wire", {
            "target": "gamepad", "action": "dpad", "args": {"axis": "Y", "sign": -1},
        })
        self.assertEqual(prepared.osc_args[-2:], ("Y", -1))
        with self.assertRaises(RealtimeError):
            self.adapter.prepare("wire", {
                "target": "gamepad", "action": "dpad", "args": {"axis": "Z", "sign": 1},
            })

    def test_sticks_are_signed_and_triggers_are_unsigned(self):
        stick = self.adapter.prepare("wire", {
            "target": "gamepad", "action": "analog", "args": {"axis": "leftx", "value": -0.75},
        })
        self.assertEqual(stick.osc_types, "ssssf")
        self.assertEqual(stick.osc_args[-2:], ("leftx", -0.75))
        with self.assertRaises(RealtimeError):
            self.adapter.prepare("wire", {
                "target": "gamepad", "action": "analog", "args": {"axis": "triggerleft", "value": -0.1},
            })

    def test_hello_advertises_gamepad_contract(self):
        hub = GamepadAppliedHub(self.adapter)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "hello"})
        capabilities = peer.messages[-1]["capabilities"]
        self.assertIn("gamepad.button", capabilities["commands"])
        self.assertEqual(capabilities["gamepad"]["dpad_axes"], ["X", "Y"])
        self.assertIn("leftx", capabilities["gamepad"]["analog_axes"])

    def test_sources_keep_python_37_grammar(self):
        for relative in ("web/realtime_gamepad.py", "web/realtime_secure.py"):
            ast.parse((ROOT / relative).read_text(encoding="utf-8"), filename=relative, feature_version=(3, 7))


class GamepadLuaStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = ROOT / "web" / "lib"
        cls.source = (root / "ingenue_gamepad.lua").read_text(encoding="utf-8")
        cls.loader = (root / "mod.lua").read_text(encoding="utf-8")

    def test_shared_dispatcher_and_lifecycle_are_registered(self):
        self.assertIn("dispatcher.register_handler('gamepad', handler)", self.source)
        self.assertIn("script_pre_init", self.source)
        self.assertIn("script_post_cleanup", self.source)
        self.assertIn("require 'ingenue_gamepad'", self.loader)

    def test_native_callbacks_and_state_updates_are_used(self):
        for needle in (
            "gamepad.register_button_state", "gamepad.trigger_button",
            "gamepad.register_direction_state", "gamepad.trigger_axis",
            "gamepad.trigger_dpad", "gamepad.analog",
        ):
            self.assertIn(needle, self.source)

    def test_adapter_does_not_execute_dynamic_code_or_shell(self):
        self.assertNotRegex(self.source, r"\bloadstring\s*\(")
        self.assertNotRegex(self.source, r"\bos\.execute\s*\(")
        self.assertNotRegex(self.source, r"\bio\.popen\s*\(")


if __name__ == "__main__":
    unittest.main()
