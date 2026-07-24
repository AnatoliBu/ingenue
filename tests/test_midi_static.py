import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class MidiStaticTests(unittest.TestCase):
    def test_python_extension_parses_with_python_37(self):
        source = (ROOT / "web/realtime_midi.py").read_text(encoding="utf-8")
        ast.parse(source, filename="web/realtime_midi.py", feature_version=(3, 7))

    def test_lua_uses_fixed_command_paths_and_native_param_apis(self):
        source = (ROOT / "web/lib/ingenue_midi.lua").read_text(encoding="utf-8")
        for text in (
            "/ingenue/command", "/ingenue/midi-command", "/ingenue/control-command",
            "param:get_raw()", "param:set_raw(normalized)", "params:delta", "script_post_init",
        ):
            self.assertIn(text, source)
        self.assertIn("tostring(min)", source)
        self.assertNotIn("loadstring", source)
        self.assertNotIn("os.execute", source)

    def test_mod_entry_loads_grid_mirror_and_shared_dispatcher(self):
        source = (ROOT / "web/lib/mod.lua").read_text(encoding="utf-8")
        self.assertIn("require 'ingenue_grid_mod'", source)
        self.assertIn("require 'ingenue_midi'", source)
        grid = (ROOT / "web/lib/ingenue_grid_mod.lua").read_text(encoding="utf-8")
        dispatcher = (ROOT / "web/lib/ingenue_midi.lua").read_text(encoding="utf-8")
        self.assertIn("Ingenue realtime Grid state adapter", grid)
        self.assertNotIn("/ingenue/command", grid)
        self.assertNotIn("osc.event", grid)
        self.assertIn("/ingenue/command", dispatcher)
        self.assertIn("osc.event = M.osc_wrapper", dispatcher)


if __name__ == "__main__":
    unittest.main()
