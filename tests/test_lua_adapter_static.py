import re
import unittest
from pathlib import Path


class LuaAdapterStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1] / "web" / "lib"
        cls.source = (root / "ingenue_grid_mod.lua").read_text(encoding="utf-8")
        cls.hardening = (root / "ingenue_grid_hardening.lua").read_text(encoding="utf-8")
        cls.loader = (root / "mod.lua").read_text(encoding="utf-8")
        cls.midi = (root / "ingenue_midi.lua").read_text(encoding="utf-8")

    def test_loader_preserves_grid_and_adds_midi(self):
        self.assertIn("require 'ingenue_grid_mod'", self.loader)
        self.assertIn("require 'ingenue_midi'", self.loader)

    def test_all_script_lifecycle_hooks_are_registered(self):
        for hook in ("script_pre_init", "script_post_init", "script_post_cleanup"):
            self.assertIn("mods.hook.register('" + hook + "'", self.source)
            self.assertIn("mods.hook.register('" + hook + "'", self.midi)

    def test_only_shared_dispatcher_owns_osc_event(self):
        self.assertNotIn("osc.event", self.source)
        self.assertIn("osc.event = M.osc_wrapper", self.midi)
        self.assertIn("local function post_init() install_wrapper() end", self.midi)
        for path in ("/ingenue/command", "/ingenue/midi-command", "/ingenue/control-command"):
            self.assertIn(path, self.midi)

    def test_applied_ack_uses_wire_id(self):
        self.assertIn("local result = {wire_id}", self.midi)
        self.assertIn("send('/ingenue/ack', result)", self.midi)
        self.assertIn("send('/ingenue/reject', {wire_id", self.midi)

    def test_state_paths_remain_in_grid_mirror(self):
        for path in ("/ingenue/script/state", "/ingenue/grid/frame"):
            self.assertIn(path, self.source)
        self.assertNotIn("/ingenue/command", self.source)

    def test_state_port_supports_flat_and_legacy_nested_install_layouts(self):
        for path in ("ingenue/data/realtime-state-port", "ingenue/web/data/realtime-state-port"):
            self.assertIn(path, self.source)
            self.assertIn(path, self.midi)

    def test_dispatcher_uses_strict_command_validation(self):
        self.assertIn("strict_integer", self.midi)
        self.assertIn("strict_number", self.midi)
        self.assertIn("trigger parameters are not writable", self.midi)
        self.assertIn("dispatch_grid_key", self.hardening)
        self.assertIn("strict_integer", self.hardening)

    def test_adapter_does_not_execute_dynamic_code_or_shell(self):
        combined = self.source + self.hardening + self.midi + self.loader
        self.assertNotRegex(combined, r"\bloadstring\s*\(")
        self.assertNotRegex(combined, r"\bos\.execute\s*\(")
        self.assertNotRegex(combined, r"\bio\.popen\s*\(")

    def test_virtual_grid_does_not_emit_fake_physical_hotplug(self):
        self.assertNotRegex(self.source, r"\bgrid\.add\s*\(\s*M\.virtual_device")
        self.assertIn("_ingenue_virtual = true", self.source)


if __name__ == "__main__":
    unittest.main()
