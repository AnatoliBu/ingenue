# Device realtime endpoint

Tracking: #3

Ingenue now launches two stdlib-only services from the existing `server.py` entrypoint:

- HTTP editor/API on `INGENUE_PORT` (default `7777`);
- protocol-v1 WebSocket on `INGENUE_REALTIME_PORT` (default HTTP port + 1, normally `7778`).

The established HTTP implementation is preserved byte-for-byte as `server_legacy.py`. The small launcher starts the realtime endpoint in a daemon thread, then calls the legacy main function. Existing device launchers and systemd units still execute `python3 server.py 7777` unchanged.

Both new Python modules are kept compatible with Python 3.7 grammar because norns hardware and ports do not all ship the same Python minor version. The test suite parses them explicitly with the Python 3.7 grammar in addition to normal import and unit tests.

## Endpoint

`ws://<norns-host>:7778/realtime`

The server supports:

- `hello` capability negotiation;
- `subscribe` with `device` and `control` channels;
- authoritative `snapshot` plus monotonic `delta` revisions;
- explicit `resync` snapshots;
- correlated `ack` / `reject` command settlement;
- 2-second heartbeats;
- bounded 1 MiB WebSocket frames;
- masked client frames, validated Upgrade headers, ping/pong and clean close handling.

## Browser-origin protection

The WebSocket handshake requires an `Origin` matching the current Ingenue HTTP host and HTTP port. This prevents an unrelated website opened by the user from controlling a norns reachable on the same LAN.

Reverse proxies or custom frontends can add exact origins with a comma-separated environment variable:

```sh
INGENUE_REALTIME_ORIGINS=https://music.example,https://studio.example
```

Missing, `null`, credential-bearing and unmatched origins are rejected before the WebSocket peer is created.

## Commands

```json
{"v":1,"type":"command","id":"cmd-1","command":{"target":"control","action":"enc","args":{"n":2,"d":1}}}
{"v":1,"type":"command","id":"cmd-2","command":{"target":"control","action":"key","args":{"n":3,"z":1}}}
{"v":1,"type":"command","id":"cmd-3","command":{"target":"param","action":"set","args":{"id":"cutoff","value":0.5}}}
```

Commands use the same existing Python → UDP OSC → matron paths as `/api/ctl`. This first endpoint increment correlates browser commands and rejects invalid inputs; the Lua adapter increment moves final applied-command acknowledgement behind matron execution.

## Inspector

Open `/realtime-inspector.html` on the normal Ingenue HTTP port. It shows connection state, current revision and authoritative state, and provides direct K1–K3, E1–E3 and parameter controls. `?rt=<port>` overrides the realtime port for nonstandard installations; the device snapshot also reports the actual configured port.

This remains an engineering inspector, not the final performance UI.
