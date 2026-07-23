import re
import unittest
from pathlib import Path


class LuaAdapterStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1] / "web" / "lib"
        cls.source = (root / "ingenue_grid_mod.lua").read_text(encoding="utf-8")
        cls.loader = (root / "mod.lua").read_text(encoding="utf-8")
        cls.midi = (root / "ingenue_midi.lua").read_text(encoding="utf-8")

    def test_loader_preserves_grid_and_adds_midi(self):
        self.assertIn("require 'ingenue_grid_mod'", self.loader)
        self.assertIn("require 'ingenue_midi'", self.loader)

    def test_all_script_lifecycle_hooks_are_registered(self):
        for hook in ("script_pre_init", "script_post_init", "script_post_cleanup"):
            self.assertIn("mods.hook.register('" + hook + "'", self.source)
            self.assertIn("mods.hook.register('" + hook + "'", self.midi)

    def test_osc_wrapper_is_reinstalled_after_script_init(self):
        post_init = self.source.split("local function post_init()", 1)[1].split(
            "local function post_cleanup()", 1
        )[0]
        self.assertIn("install_osc_wrapper()", post_init)
        install = self.source.split("local function install_osc_wrapper()", 1)[1].split(
            "local function send_script_state", 1
        )[0]
        self.assertIn("if osc.event == M.osc_wrapper then return end", install)
        self.assertIn("local function post_init() install_wrapper() end", self.midi)

    def test_applied_ack_uses_wire_id(self):
        self.assertRegex(self.source, r"send\('/ingenue/ack',\s*\{\s*id\s*\}\)")
        self.assertIn("local result = {wire_id}", self.midi)
        self.assertIn("send('/ingenue/ack', result)", self.midi)

    def test_applied_ack_and_state_paths_are_present(self):
        for path in (
            "/ingenue/command", "/ingenue/ack", "/ingenue/reject",
            "/ingenue/script/state", "/ingenue/grid/frame",
        ):
            self.assertIn(path, self.source)
        self.assertIn("/ingenue/midi-command", self.midi)

    def test_state_port_supports_flat_and_legacy_nested_install_layouts(self):
        for path in ("ingenue/data/realtime-state-port", "ingenue/web/data/realtime-state-port"):
            self.assertIn(path, self.source)
            self.assertIn(path, self.midi)

    def test_adapter_uses_strict_command_validation(self):
        self.assertIn("strict_integer", self.source)
        self.assertIn("strict_number", self.source)
        self.assertNotRegex(self.source, r"_norns\.(?:enc|key)\(clamp\(")
        self.assertIn("trigger parameters are not writable", self.midi)

    def test_adapter_does_not_execute_dynamic_code_or_shell(self):
        combined = self.source + self.midi + self.loader
        self.assertNotRegex(combined, r"\bloadstring\s*\(")
        self.assertNotRegex(combined, r"\bos\.execute\s*\(")
        self.assertNotRegex(combined, r"\bio\.popen\s*\(")

    def test_virtual_grid_does_not_emit_fake_physical_hotplug(self):
        self.assertNotRegex(self.source, r"\bgrid\.add\s*\(\s*M\.virtual_device")
        self.assertIn("_ingenue_virtual = true", self.source)


if __name__ == "__main__":
    unittest.main()
