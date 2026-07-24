import ast
import importlib.util
import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "midi-local.py"
SPEC = importlib.util.spec_from_file_location("ingenue_midi_local", SOURCE)
MIDI_LOCAL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MIDI_LOCAL)


class UpstreamHandler(BaseHTTPRequestHandler):
    paths = []

    def log_message(self, _format, *_args):
        pass

    def do_GET(self):
        type(self).paths.append(self.path)
        body = ("UPSTREAM " + self.path).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_HEAD(self):
        type(self).paths.append(self.path)
        self.send_response(200)
        self.send_header("Content-Length", "0")
        self.end_headers()


class MidiLocalBridgeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        UpstreamHandler.paths = []
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), UpstreamHandler)
        cls.upstream_thread = threading.Thread(target=cls.upstream.serve_forever, daemon=True)
        cls.upstream_thread.start()
        config = MIDI_LOCAL.BridgeConfig(
            device="127.0.0.1",
            device_port=cls.upstream.server_port,
            realtime_port=45678,
            local_port=0,
            timeout=2.0,
        )
        cls.bridge = MIDI_LOCAL.MidiBridgeServer(config)
        cls.bridge_thread = threading.Thread(target=cls.bridge.serve_forever, daemon=True)
        cls.bridge_thread.start()
        cls.base = "http://127.0.0.1:{}".format(cls.bridge.server_port)

    @classmethod
    def tearDownClass(cls):
        cls.bridge.shutdown()
        cls.bridge.server_close()
        cls.upstream.shutdown()
        cls.upstream.server_close()

    def test_root_redirects_to_localhost_midi_page_and_proxies_static_content(self):
        with urllib.request.urlopen(self.base + "/", timeout=3) as response:
            body = response.read().decode("utf-8")
            self.assertEqual(response.status, 200)
            self.assertEqual(response.headers["X-Ingenue-MIDI-Bridge"], "localhost")
        self.assertEqual(body, "UPSTREAM /midi.html")
        self.assertIn("/midi.html", UpstreamHandler.paths)
        self.assertFalse(any("device=" in path or "bridge=" in path for path in UpstreamHandler.paths))

    def test_health_is_local_and_reports_target_ports(self):
        with urllib.request.urlopen(
            self.base + MIDI_LOCAL.BRIDGE_PREFIX + "/health", timeout=3
        ) as response:
            payload = json.loads(response.read().decode("utf-8"))
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["device"], "127.0.0.1")
        self.assertEqual(payload["realtime_port"], 45678)

    def test_proxy_is_read_only(self):
        request = urllib.request.Request(self.base + "/midi.html", data=b"x", method="POST")
        with self.assertRaises(urllib.error.HTTPError) as captured:
            urllib.request.urlopen(request, timeout=3)
        self.assertEqual(captured.exception.code, 405)

    def test_device_validation_rejects_urls_paths_credentials_and_embedded_ports(self):
        self.assertEqual(MIDI_LOCAL.normalize_device("norns.local"), "norns.local")
        for value in (
            "http://norns.local", "norns.local/path", "user@norns.local", "norns.local:7777", "",
        ):
            with self.subTest(value=value), self.assertRaises(ValueError):
                MIDI_LOCAL.normalize_device(value)

    def test_launch_url_carries_direct_realtime_target(self):
        config = MIDI_LOCAL.BridgeConfig(
            device="norns.local", device_port=7777, realtime_port=9000, local_port=7780
        )
        self.assertEqual(
            config.launch_url(),
            "http://localhost:7780/midi.html?device=norns.local&rt=9000&bridge=localhost",
        )

    def test_helper_keeps_python_37_grammar(self):
        ast.parse(SOURCE.read_text(encoding="utf-8"), filename=str(SOURCE), feature_version=(3, 7))


if __name__ == "__main__":
    unittest.main()
