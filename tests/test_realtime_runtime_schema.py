import ast
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "web"))

from realtime_ownership import OWNERSHIP_COMMANDS
from realtime_runtime import RuntimeAppliedAdapter
from realtime_runtime_schema import COMMAND_SCHEMAS, SchemaRuntimeAppliedHub, command_registry
from realtime_mlr import MlrAppliedAdapter, MlrAppliedHub
from realtime_secure import MidiAppliedAdapter, MidiAppliedHub


class RuntimeSchemaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        legacy = SimpleNamespace(
            PORT=7777,
            DUST="/dust",
            HERE=self.temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "schema-test",
            osc_send=lambda *args: None,
        )
        self.adapter = RuntimeAppliedAdapter(
            legacy,
            realtime_port=7778,
            state_port=0,
            session_generation="runtime-schema-test",
        )

    def test_registry_covers_every_runtime_command_exactly_once(self):
        self.assertEqual(set(COMMAND_SCHEMAS), set(OWNERSHIP_COMMANDS))
        entries = command_registry()
        self.assertEqual(len(entries), len(OWNERSHIP_COMMANDS))
        self.assertEqual([entry["name"] for entry in entries], list(OWNERSHIP_COMMANDS))
        self.assertEqual(len({entry["name"] for entry in entries}), len(entries))

    def test_registry_publishes_browser_supported_schema_vocabulary(self):
        by_name = {entry["name"]: entry for entry in command_registry()}
        key = by_name["control.key"]
        self.assertTrue(key["runtime_context"])
        self.assertTrue(key["ownership"])
        self.assertEqual(key["args_schema"]["required"], ["n", "z"])
        self.assertEqual(key["args_schema"]["properties"]["n"]["minimum"], 1)
        self.assertEqual(key["args_schema"]["properties"]["z"]["enum"], [0, 1])
        ping = by_name["system.ping"]
        self.assertFalse(ping["runtime_context"])
        self.assertFalse(ping["ownership"])
        self.assertEqual(ping["args_schema"], {
            "type": "object", "additional": False, "required": [], "properties": {},
        })
        param = by_name["param.set_normalized"]["args_schema"]
        self.assertEqual(param["properties"]["id"]["pattern"], r"^[A-Za-z0-9_.:-]{1,128}$")
        self.assertEqual(param["properties"]["value"]["minimum"], 0)
        self.assertEqual(param["properties"]["value"]["maximum"], 1)

    def test_production_hub_is_schema_and_mlr_aware(self):
        self.assertIs(MidiAppliedAdapter, MlrAppliedAdapter)
        self.assertIs(MidiAppliedHub, MlrAppliedHub)
        legacy = self.adapter.legacy
        mlr_adapter = MlrAppliedAdapter(
            legacy, realtime_port=7778, state_port=0,
            session_generation="runtime-schema-mlr-test",
        )
        hub = MlrAppliedHub(mlr_adapter)
        capabilities = hub._capabilities()
        self.assertTrue(capabilities["runtime"]["command_schemas"])
        self.assertTrue(capabilities["mlr"]["observer"])
        self.assertIn("mlr", capabilities["channels"])
        self.assertEqual(
            {entry["name"] for entry in capabilities["command_registry"]},
            set(OWNERSHIP_COMMANDS),
        )
        self.assertTrue(all("args_schema" in entry for entry in capabilities["command_registry"]))

    def test_schema_module_keeps_python_37_grammar(self):
        source = (ROOT / "web" / "realtime_runtime_schema.py").read_text(encoding="utf-8")
        ast.parse(source, filename="web/realtime_runtime_schema.py", feature_version=(3, 7))


if __name__ == "__main__":
    unittest.main()
