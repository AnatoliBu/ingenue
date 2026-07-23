import ast
import json
import struct
import unittest
from pathlib import Path
from types import SimpleNamespace

from web.realtime_secure import OriginCheckedServer, origin_allowed
from web.realtime_server import (
    LegacyAdapter,
    MatronBridge,
    Peer,
    RealtimeError,
    RealtimeHub,
    decode_osc,
    encode_frame,
    read_frame,
    websocket_accept,
)


class MemorySocket:
    def __init__(self, incoming=b""):
        self.incoming = bytearray(incoming)
        self.sent = bytearray()
        self.closed = False

    def recv(self, n):
        if not self.incoming:
            return b""
        out = bytes(self.incoming[:n])
        del self.incoming[:n]
        return out

    def sendall(self, data):
        self.sent.extend(data)

    def shutdown(self, *_):
        pass

    def close(self):
        self.closed = True


class FakeBridge:
    def __init__(self):
        self.calls = []

    def dispatch(self, wire_id, prepared):
        self.calls.append((wire_id, prepared))


def masked_frame(payload, opcode=1, mask=b"abcd"):
    payload = payload if isinstance(payload, bytes) else payload.encode()
    n = len(payload)
    assert n < 126
    encoded = bytes(value ^ mask[i % 4] for i, value in enumerate(payload))
    return bytes([0x80 | opcode, 0x80 | n]) + mask + encoded


def sent_messages(sock):
    data = bytes(sock.sent)
    out = []
    while data:
        n = data[1] & 0x7F
        start = 2
        if n == 126:
            n = struct.unpack(">H", data[2:4])[0]
            start = 4
        elif n == 127:
            n = struct.unpack(">Q", data[2:10])[0]
            start = 10
        out.append(json.loads(data[start:start + n]))
        data = data[start + n:]
    return out


def osc_string(value):
    data = value.encode() + b"\0"
    return data + b"\0" * ((4 - len(data) % 4) % 4)


def osc_packet(address, tags, *args):
    packet = osc_string(address) + osc_string("," + tags)
    for tag, value in zip(tags, args):
        if tag == "i":
            packet += struct.pack(">i", int(value))
        elif tag == "f":
            packet += struct.pack(">f", float(value))
        elif tag == "s":
            packet += osc_string(str(value))
    return packet


class RealtimeServerTests(unittest.TestCase):
    def setUp(self):
        self.clock = [10.0]
        self.wall = [1000.0]
        self.calls = []
        self.legacy = SimpleNamespace(
            PORT=7777,
            DUST="/dust",
            _CTL={"hits": 0, "last": None, "ts": 0},
            installed_sha=lambda: "abc",
            read_enabled_mods=lambda: ["ingenue"],
            osc_send=lambda *args: self.calls.append(args),
        )
        self.adapter = LegacyAdapter(
            self.legacy,
            realtime_port=9000,
            reply_port=10112,
            now=lambda: self.wall[0],
        )
        self.bridge = FakeBridge()
        self.hub = RealtimeHub(
            self.adapter,
            bridge=self.bridge,
            now=lambda: self.clock[0],
            command_timeout=2.0,
        )

    def test_server_sources_parse_with_python_37_grammar(self):
        root = Path(__file__).resolve().parents[1]
        for relative in (
            "web/realtime_server.py",
            "web/realtime_secure.py",
            "web/server.py",
        ):
            source = (root / relative).read_text(encoding="utf-8")
            ast.parse(source, filename=relative, feature_version=(3, 7))

    def test_rfc_websocket_accept(self):
        self.assertEqual(
            websocket_accept("dGhlIHNhbXBsZSBub25jZQ=="),
            "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=",
        )

    def test_masked_client_frame_round_trips(self):
        opcode, payload = read_frame(MemorySocket(masked_frame("hello")))
        self.assertEqual(opcode, 1)
        self.assertEqual(payload, b"hello")
        self.assertTrue(encode_frame("hello").endswith(b"hello"))

    def test_unmasked_client_frame_is_rejected(self):
        with self.assertRaises(RealtimeError):
            read_frame(MemorySocket(encode_frame("bad")))

    def test_osc_decoder_supports_adapter_messages(self):
        address, args = decode_osc(
            osc_packet("/ingenue/grid", "iiis", 1, 16, 8, "0" * 128)
        )
        self.assertEqual(address, "/ingenue/grid")
        self.assertEqual(args[:3], [1, 16, 8])
        self.assertEqual(len(args[3]), 128)

    def test_origin_allows_only_current_ingenue_http_origin(self):
        self.assertTrue(origin_allowed(
            "http://norns.local:7777", "norns.local:7778", 7777
        ))
        self.assertFalse(origin_allowed(
            "http://evil.example", "norns.local:7778", 7777
        ))
        self.assertFalse(origin_allowed(None, "norns.local:7778", 7777))
        self.assertFalse(origin_allowed("null", "norns.local:7778", 7777))

    def test_origin_checked_server_retains_hub(self):
        server = OriginCheckedServer(("127.0.0.1", 0), self.hub, 7777, [])
        try:
            self.assertIs(server.hub, self.hub)
        finally:
            server.server_close()

    def test_snapshot_exposes_grid_and_adapter_status(self):
        peer = Peer(MemorySocket())
        self.hub.handle(peer, {
            "v": 1, "type": "subscribe",
            "channels": ["device", "grid"],
        })
        state = sent_messages(peer.sock)[0]["state"]
        self.assertEqual(state["grid"]["cols"], 16)
        self.assertFalse(state["device"]["adapter"]["online"])
        self.assertEqual(state["device"]["adapter"]["reply_port"], 10112)

    def test_command_waits_for_matron_ack_before_revision(self):
        sender = Peer(MemorySocket(), channels={"control"})
        observer = Peer(MemorySocket(), channels={"control"})
        self.hub.register(sender)
        self.hub.register(observer)
        self.hub.handle(sender, {
            "v": 1,
            "type": "command",
            "id": "cmd-1",
            "command": {
                "target": "control", "action": "enc",
                "args": {"n": 2, "d": -3},
            },
        })
        self.assertEqual(sent_messages(sender.sock), [])
        self.assertEqual(self.hub.revision, 0)
        wire_id, prepared = self.bridge.calls[0]
        self.assertEqual(prepared.args, {"n": 2, "d": -3})

        self.hub.matron_ack(wire_id)
        self.assertEqual(self.hub.revision, 1)
        self.assertEqual([m["type"] for m in sent_messages(sender.sock)], ["delta", "ack"])
        self.assertEqual(sent_messages(observer.sock)[0]["type"], "delta")
        self.assertEqual(self.legacy._CTL["hits"], 1)

    def test_matron_reject_preserves_revision_and_state(self):
        peer = Peer(MemorySocket(), channels={"control"})
        self.hub.handle(peer, {
            "v": 1,
            "type": "command",
            "id": "cmd-bad",
            "command": {
                "target": "param", "action": "set",
                "args": {"id": "missing", "value": 0.5},
            },
        })
        wire_id = self.bridge.calls[0][0]
        self.hub.matron_reject(wire_id, "unknown param: missing")
        message = sent_messages(peer.sock)[0]
        self.assertEqual(message["type"], "reject")
        self.assertIn("unknown param", message["error"])
        self.assertEqual(self.hub.revision, 0)
        self.assertEqual(self.legacy._CTL["hits"], 0)

    def test_pending_command_times_out_without_fake_ack(self):
        peer = Peer(MemorySocket())
        self.hub.handle(peer, {
            "v": 1,
            "type": "command",
            "id": "cmd-timeout",
            "command": {
                "target": "control", "action": "key",
                "args": {"n": 1, "z": 1},
            },
        })
        self.clock[0] = 12.1
        self.hub.expire_pending()
        message = sent_messages(peer.sock)[0]
        self.assertEqual(message["type"], "reject")
        self.assertIn("timeout", message["error"])
        self.assertEqual(self.hub.revision, 0)

    def test_system_ping_remains_local_and_immediate(self):
        peer = Peer(MemorySocket())
        self.hub.handle(peer, {
            "v": 1, "type": "command", "id": "ping",
            "command": {"target": "system", "action": "ping"},
        })
        message = sent_messages(peer.sock)[0]
        self.assertEqual(message["type"], "ack")
        self.assertEqual(message["result"], {"pong": 1000.0})
        self.assertEqual(self.bridge.calls, [])

    def test_adapter_online_transition_and_stale_transition_are_revisions(self):
        peer = Peer(MemorySocket(), channels={"device"})
        self.hub.register(peer)
        self.hub.adapter_seen("1")
        self.assertTrue(self.adapter.adapter_online)
        self.assertEqual(self.hub.revision, 1)
        self.hub.adapter_seen("1")
        self.assertEqual(self.hub.revision, 1)
        self.clock[0] = 15.1
        self.hub.check_adapter_stale()
        self.assertFalse(self.adapter.adapter_online)
        self.assertEqual(self.hub.revision, 2)
        self.assertEqual([m["type"] for m in sent_messages(peer.sock)], ["delta", "delta"])

    def test_filtered_subscriber_receives_noop_delta_to_preserve_global_revision(self):
        peer = Peer(MemorySocket(), channels={"control"})
        self.hub.register(peer)
        self.hub.grid_frame(1, 16, 8, "f" + "0" * 127)
        message = sent_messages(peer.sock)[0]
        self.assertEqual(message["rev"], 1)
        self.assertEqual(message["operations"], [])

    def test_grid_frame_is_authoritative_and_broadcast(self):
        peer = Peer(MemorySocket(), channels={"grid"})
        self.hub.register(peer)
        levels = "f" + "0" * 127
        self.hub.grid_frame(1, 16, 8, levels)
        message = sent_messages(peer.sock)[0]
        self.assertEqual(message["type"], "delta")
        self.assertEqual(message["operations"][0]["value"]["levels"], levels)
        self.assertEqual(self.hub.revision, 1)

    def test_identical_grid_frame_is_deduplicated(self):
        peer = Peer(MemorySocket(), channels={"grid"})
        self.hub.register(peer)
        initial = "0" * 128
        self.hub.grid_frame(1, 16, 8, initial)
        self.assertEqual(self.hub.revision, 0)
        self.assertEqual(sent_messages(peer.sock), [])

    def test_grid_key_applies_only_after_lua_ack(self):
        peer = Peer(MemorySocket(), channels={"grid"})
        self.hub.register(peer)
        self.hub.handle(peer, {
            "v": 1,
            "type": "command",
            "id": "g1",
            "command": {
                "target": "grid", "action": "key",
                "args": {"port": 1, "x": 4, "y": 3, "z": 1},
            },
        })
        wire_id = self.bridge.calls[0][0]
        self.assertIsNone(self.adapter.grid["last_key"])
        self.hub.matron_ack(wire_id)
        self.assertEqual(self.adapter.grid["last_key"]["x"], 4)
        self.assertEqual([m["type"] for m in sent_messages(peer.sock)], ["delta", "ack"])

    def test_matron_bridge_encodes_unique_wire_command(self):
        calls = []
        legacy = SimpleNamespace(osc_send=lambda *args: calls.append(args))
        bridge = MatronBridge(legacy, reply_port=10112)
        prepared = self.adapter.prepare({
            "target": "control", "action": "enc",
            "args": {"n": 3, "d": 7},
        })
        bridge.dispatch("rt-9", prepared)
        self.assertEqual(calls[0][0:2], ("/ingenue/command", "ssssi"))
        self.assertEqual(calls[0][2], "rt-9")
        self.assertEqual(json.loads(calls[0][5]), {"n": 3, "d": 7})
        self.assertEqual(calls[0][6], 10112)


if __name__ == "__main__":
    unittest.main()
