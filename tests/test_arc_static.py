import re
import unittest
from pathlib import Path


class ArcAdapterStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1] / "web" / "lib"
        cls.loader = (root / "mod.lua").read_text(encoding="utf-8")
        cls.dispatcher = (root / "ingenue_midi.lua").read_text(encoding="utf-8")
        cls.arc = (root / "ingenue_arc.lua").read_text(encoding="utf-8")

    def test_loader_registers_arc_after_shared_dispatcher(self):
        self.assertIn("require 'ingenue_midi'", self.loader)
        self.assertIn("require 'ingenue_arc'", self.loader)
        self.assertLess(
            self.loader.index("require 'ingenue_midi'"),
            self.loader.index("require 'ingenue_arc'"),
        )

    def test_arc_uses_native_vports_and_preserves_physical_output(self):
        self.assertIn("arc.vports", self.arc)
        self.assertIn("original.led(self, ring, led, value, relative)", self.arc)
        self.assertIn("original.segment(self, ring, from, to, level, relative)", self.arc)
        self.assertIn("not vp.device._ingenue_virtual", self.arc)
        self.assertNotRegex(self.arc, r"\barc\.add\s*\(\s*M\.virtual_device")

    def test_arc_contract_has_four_rings_and_sixty_four_leds(self):
        self.assertIn("virtual_rings = 4", self.arc)
        self.assertRegex(self.arc, r"for led=1,64 do")
        self.assertIn("/ingenue/arc/frame", self.arc)
        self.assertIn("dispatcher.register_handler('arc', execute)", self.arc)

    def test_arc_supports_delta_key_and_varibright_methods(self):
        for needle in (
            "action == 'delta'",
            "action == 'key'",
            "vp.led = function",
            "vp.all = function",
            "vp.segment = function",
            "vp.refresh = function",
            "vp.intensity = function",
        ):
            self.assertIn(needle, self.arc)

    def test_dispatcher_accepts_dedicated_control_path(self):
        self.assertIn("/ingenue/control-command", self.dispatcher)
        self.assertIn("function M.register_handler", self.dispatcher)

    def test_arc_adapter_has_no_dynamic_code_or_shell(self):
        combined = self.arc + self.dispatcher + self.loader
        self.assertNotRegex(combined, r"\bloadstring\s*\(")
        self.assertNotRegex(combined, r"\bos\.execute\s*\(")
        self.assertNotRegex(combined, r"\bio\.popen\s*\(")


if __name__ == "__main__":
    unittest.main()
