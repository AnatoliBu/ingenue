import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "web"))

from web.realtime_grid import GridAppliedAdapter, GridAppliedHub, RealtimeError


class MemoryPeer:
    def __init__(self, channels=()):
        self.messages = []
        self.alive = True
        self.channels = set(channels)

    def send(self, message):
        self.messages.append(message)


class GridDeviceContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.calls = []
        self.legacy = SimpleNamespace(
            PORT=7777,
            DUST="/dust",
            HERE=self.temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            osc_send=lambda *args: self.calls.append(args),
        )
        self.adapter = GridAppliedAdapter(self.legacy, 7778, 7779, now=lambda: 12.5)

    def test_configure_prepares_persistent_native_profile(self):
        prepared = self.adapter.prepare("wire", {
            "target": "grid", "action": "configure",
            "args": {"port": 3, "cols": 16, "rows": 8, "rotation": 1},
        })
        self.assertEqual(prepared.osc_types, "sssiiii")
        self.assertEqual(prepared.osc_args, ("wire", "grid", "configure", 3, 16, 8, 1))
        self.adapter.send_prepared(prepared)
        self.assertEqual(self.calls[0][0], "/ingenue/control-command")

    def test_integer_valued_command_numbers_normalize_to_ints(self):
        prepared = self.adapter.prepare("wire", {
            "target": "grid", "action": "configure",
            "args": {"port": 3.0, "cols": 16.0, "rows": 8.0, "rotation": 1.0},
        })
        self.assertEqual(prepared.osc_args, ("wire", "grid", "configure", 3, 16, 8, 1))

    def test_configure_rejects_non_native_shape(self):
        with self.assertRaises(RealtimeError):
            self.adapter.prepare("wire", {
                "target": "grid", "action": "configure",
                "args": {"port": 1, "cols": 12, "rows": 8, "rotation": 0},
            })

    def test_rotated_grid_frame_is_authoritative(self):
        frame = "0" * 127 + "f"
        channel, operations = self.adapter.apply_runtime(
            "/ingenue/grid/frame", [2, 8, 16, frame, 9, 12, 1, 1]
        )
        self.assertEqual(channel, "grid")
        value = operations[0]["value"]
        self.assertEqual(value["rotation"], 1)
        self.assertEqual(value["cols"], 8)
        self.assertEqual(self.adapter.grid_state["ports"]["2"]["frame"], frame)

    def test_lua_osc_integral_floats_are_accepted(self):
        frame = "f" * 128
        channel, operations = self.adapter.apply_runtime(
            "/ingenue/grid/frame", [2.0, 8.0, 16.0, frame, 9.0, 12.0, 1.0, 1.0]
        )
        self.assertEqual(channel, "grid")
        value = operations[0]["value"]
        self.assertEqual(value["port"], 2)
        self.assertEqual(value["rotation"], 1)
        self.assertIn("2", self.adapter.grid_state["ports"])

    def test_fractional_boolean_and_string_grid_ports_are_rejected(self):
        for value in (1.5, True, "1"):
            with self.subTest(value=value):
                with self.assertRaises(RealtimeError):
                    self.adapter.apply_runtime("/ingenue/grid/disconnect", [value])

    def test_legacy_seven_field_frame_preserves_known_rotation(self):
        self.adapter.apply_runtime(
            "/ingenue/grid/frame", [2, 8, 16, "0" * 128, 1, 15, 1, 1]
        )
        _channel, operations = self.adapter.apply_runtime(
            "/ingenue/grid/frame", [2, 8, 16, "f" * 128, 2, 15, 1]
        )
        self.assertEqual(operations[0]["value"]["rotation"], 1)

    def test_disconnect_removes_stale_port(self):
        self.adapter.apply_runtime("/ingenue/grid/frame", [1, 8, 8, "0" * 64, 1, 15, 1, 0])
        channel, operations = self.adapter.apply_runtime("/ingenue/grid/disconnect", [1])
        self.assertEqual(channel, "grid")
        self.assertEqual(operations, [{"op": "delete", "path": ["grid", "ports", "1"]}])
        self.assertNotIn("1", self.adapter.grid_state["ports"])

    def test_hello_advertises_profiles_and_configure(self):
        hub = GridAppliedHub(self.adapter)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "hello"})
        capabilities = peer.messages[-1]["capabilities"]
        self.assertIn("grid.configure", capabilities["commands"])
        self.assertEqual(capabilities["grid"]["shapes"], ["8x8", "16x8", "16x16"])
        self.assertEqual(capabilities["grid"]["rotations"], [0, 1, 2, 3])


class GridLuaStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = ROOT / "web" / "lib"
        cls.source = (root / "ingenue_grid_hardening.lua").read_text(encoding="utf-8")
        cls.loader = (root / "mod.lua").read_text(encoding="utf-8")

    def test_persistent_profiles_and_native_shapes(self):
        for needle in ("virtual-grid-config", "8x8, 16x8, or 16x16", "persist_config"):
            self.assertIn(needle, self.source)

    def test_rotation_and_port_move_are_authoritative(self):
        self.assertIn("device.rotation = function", self.source)
        self.assertIn("/ingenue/grid/disconnect", self.source)
        self.assertIn("M.config.rotation or 0", self.source)

    def test_physical_grid_is_never_replaced(self):
        self.assertIn("target.device and not target.device._ingenue_virtual", self.source)
        self.assertNotRegex(self.source, r"\bgrid\.add\s*\(")

    def test_loader_registers_hardening_after_dispatcher(self):
        self.assertIn("require 'ingenue_grid_hardening'", self.loader)
        self.assertLess(self.loader.index("require 'ingenue_midi'"), self.loader.index("require 'ingenue_grid_hardening'"))

    def test_no_dynamic_code_or_shell(self):
        self.assertNotRegex(self.source, r"\bloadstring\s*\(")
        self.assertNotRegex(self.source, r"\bos\.execute\s*\(")
        self.assertNotRegex(self.source, r"\bio\.popen\s*\(")


if __name__ == "__main__":
    unittest.main()
