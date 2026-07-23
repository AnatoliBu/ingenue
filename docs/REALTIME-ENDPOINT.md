# Device realtime endpoint

Tracking: #3  
Lua authority boundary: `docs/LUA-ADAPTER.md`

Ingenue launches two stdlib-only services from the existing `server.py` entrypoint:

- HTTP editor/API on `INGENUE_PORT` (default `7777`);
- protocol-v1 WebSocket on `INGENUE_REALTIME_PORT` (default HTTP port + 1, normally `7778`).

The established HTTP implementation remains byte-for-byte in `server_legacy.py`. Existing launchers and systemd units still execute `python3 server.py 7777`.

New Python modules remain compatible with Python 3.7 grammar because norns hardware and ports do not all ship the same Python minor version.

## Endpoint

```text
ws://<norns-host>:7778/realtime
```

Supported protocol features:

- `hello` capability negotiation;
- `device`, `control`, `script`, and `grid` subscriptions;
- authoritative snapshot and monotonic delta revisions;
- explicit resync snapshots;
- Lua-applied correlated `ack` / `reject` command settlement;
- two-second heartbeats;
- bounded pending commands and WebSocket frames;
- reconnect without restarting script playback.

## Commands

```json
{"v":1,"type":"command","id":"cmd-1","command":{"target":"control","action":"enc","args":{"n":2,"d":1}}}
{"v":1,"type":"command","id":"cmd-2","command":{"target":"control","action":"key","args":{"n":3,"z":1}}}
{"v":1,"type":"command","id":"cmd-3","command":{"target":"param","action":"set","args":{"id":"cutoff","value":0.5}}}
{"v":1,"type":"command","id":"cmd-4","command":{"target":"grid","action":"key","args":{"port":1,"x":4,"y":2,"z":1}}}
```

`system.ping` is acknowledged immediately by Python because it intentionally tests the transport service itself. Controls, params, and Grid keys are acknowledged only after Lua completes execution in matron.

## Local state bridge

Lua state and applied acknowledgements return over localhost UDP. Configure with:

```text
INGENUE_STATE_PORT
```

Default: realtime port + 1 (`7779`). The socket binds to `127.0.0.1`; datagrams from non-loopback sources are discarded.

## Browser-origin protection

The WebSocket handshake requires an `Origin` matching the current Ingenue HTTP host and port. This prevents an unrelated website opened by the user from controlling a norns reachable on the same LAN.

Reverse proxies or custom frontends can add exact origins:

```sh
INGENUE_REALTIME_ORIGINS=https://music.example,https://studio.example
```

Missing, `null`, credential-bearing, and unmatched origins are rejected before a peer is created.

## Inspector

Open `/realtime-inspector.html` on the normal Ingenue HTTP port. It subscribes to all four channels and exposes K1–K3, E1–E3, generic parameter control, revision state, and command settlement logs.

`?rt=<port>` overrides the realtime port for nonstandard installations.

The inspector remains an engineering view. The next layer is the user-facing performance surface with an authoritative virtual Grid renderer.
