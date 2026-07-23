import shutil
import subprocess
import unittest
from pathlib import Path


class LuaAdapterHarnessTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("lua") or shutil.which("texlua"), "Lua interpreter unavailable")
    def test_adapter_executes_commands_and_preserves_grid_output(self):
        root = Path(__file__).resolve().parents[1]
        executable = shutil.which("lua") or shutil.which("texlua")
        result = subprocess.run(
            [executable, str(root / "tests/lua_adapter_harness.lua"), str(root)],
            cwd=str(root), capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("lua adapter harness ok", result.stdout)


if __name__ == "__main__":
    unittest.main()
