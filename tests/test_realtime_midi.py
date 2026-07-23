import ast
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from web.realtime_midi import MidiAppliedAdapter, MidiAppliedHub, RealtimeError, parse_param_result


class MemoryPeer:
    def __init__(self):
        self.messages = []
        self.alive = True
        self.channels = {"control"}

    def send(self, message):
        self.messages.append(message)


class MidiRealtimeTests(unittest.TestCase):
    def make_hub(self):
        temp = tempfile.TemporaryDirectory()
        calls = []
        legacy = SimpleNamespace(
            PORT=7777,
            DUST="/dust",
            HERE=temp.name,
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            osc_send=lambda *args: calls.append(args),
        )
        adapter = MidiAppliedAdapter(legacy, realtime_port=7778, state_port=0, now=lambda: 12.5)
        return temp, MidiAppliedHub(adapter), calls

    def test_sources_parse_with_python_37_grammar(self):
        root = Path(__file__).resolve().parents[1]
        for relative in ("web/realtime_midi.py", "web/realtime_secure.py"):
            ast.parse((root / relative).read_text(encoding="utf-8"), filename=relative, feature_version=(3, 7))

    def test_prepare_routes_normalized_commands_to_midi_path(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "command", "id": "q", "command": {"target": "param", "action": "describe", "args": {"id": "cutoff"}}})
        self.assertEqual(calls[0][0], "/ingenue/midi-command")
        self.assertEqual(calls[0][2:6], ("wire-1", "param", "describe", "cutoff"))

    def test_describe_ack_returns_descriptor_without_revision(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "command", "id": "q", "command": {"target": "param", "action": "describe", "args": {"id": "cutoff"}}})
        hub.ingest("/ingenue/ack", ["wire-1", "param", "cutoff", 3, "control", 0.5, 440.0, 20.0, 20000.0, "Cutoff", "440 Hz", "", 1])
        ack = peer.messages[-1]
        self.assertEqual(ack["type"], "ack")
        self.assertEqual(ack["rev"], 0)
        self.assertEqual(ack["result"]["param"]["normalized"], 0.5)
        self.assertNotIn("applied", ack["result"])

    def test_set_normalized_is_mutating_and_returns_descriptor(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "command", "id": "set", "command": {"target": "param", "action": "set_normalized", "args": {"id": "cutoff", "value": 0.75}}})
        hub.ingest("/ingenue/ack", ["wire-1", "param", "cutoff", 3, "control", 0.75, 1200.0, 20.0, 20000.0, "Cutoff", "1.2 kHz", "", 1])
        ack = peer.messages[-1]
        self.assertEqual(ack["rev"], 1)
        self.assertEqual(ack["result"]["applied"]["action"], "set_normalized")
        self.assertEqual(ack["result"]["param"]["value"], 1200.0)

    def test_invalid_normalized_value_rejects_before_dispatch(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "command", "id": "bad", "command": {"target": "param", "action": "set_normalized", "args": {"id": "cutoff", "value": 2}}})
        self.assertEqual(calls, [])
        self.assertEqual(peer.messages[-1]["type"], "reject")

    def test_malformed_lua_descriptor_becomes_browser_reject(self):
        temp, hub, calls = self.make_hub()
        self.addCleanup(temp.cleanup)
        peer = MemoryPeer()
        hub.handle(peer, {"v": 1, "type": "command", "id": "q", "command": {"target": "param", "action": "describe", "args": {"id": "cutoff"}}})
        hub.ingest("/ingenue/ack", ["wire-1", "param", "cutoff"])
        self.assertEqual(peer.messages[-1]["type"], "reject")
        self.assertIn("acknowledgement", peer.messages[-1]["error"])

    def test_param_result_rejects_invalid_kind(self):
        with self.assertRaises(RealtimeError):
            parse_param_result(["param", "x", 3, "file", 0.5, 1, 0, 2, "X", "1", "", 1])

    def test_db_descriptor_preserves_infinite_metadata_as_text(self):
        result = parse_param_result(["param", "level", 3, "control", 0.0, "-inf", "-inf", "0", "Level", "-inf dB", "", 1])
        self.assertIsNone(result["value"])
        self.assertEqual(result["value_text"], "-inf")
        self.assertIsNone(result["min"])
        self.assertEqual(result["max"], 0.0)


if __name__ == "__main__":
    unittest.main()
