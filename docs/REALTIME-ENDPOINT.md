# Device realtime endpoint

Tracking: #3  
Lua authority boundary: `docs/LUA-ADAPTER.md`  
Browser ownership: `docs/CONTROLLER-OWNERSHIP.md`

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

- `hello` capability negotiation with a stable browser `client_id`;
- `device`, `control`, `script`, `grid`, `arc`, `params`, and `ownership` subscriptions;
- authoritative snapshot and monotonic delta revisions;
- explicit resync snapshots;
- Lua-applied correlated `ack` / `reject` command settlement;
- resource ownership and five-second reconnect leases;
- immediate balanced release of held browser input on disconnect;
- two-second heartbeats;
- bounded pending commands and WebSocket frames;
- reconnect without restarting script playback.

## Commands

```json
{"v":1,"type":"command","id":"cmd-1","command":{"target":"control","action":"enc","args":{"n":2,"d":1}}}
{"v":1,"type":"command","id":"cmd-2","command":{"target":"control","action":"key","args":{"n":3,"z":1}}}
{"v":1,"type":"command","id":"cmd-3","command":{"target":"param","action":"set","args":{"id":"cutoff","value":0.5}}}
{"v":1,"type":"command","id":"cmd-4","command":{"target":"grid","action":"key","args":{"port":1,"x":4,"y":2,"z":1}}}
{"v":1,"type":"command","id":"cmd-5","command":{"target":"arc","action":"configure","args":{"port":2,"rings":4}}}
{"v":1,"type":"command","id":"cmd-6","command":{"target":"session","action":"release_all","args":{}}}
```

`system.ping` and `session.*` commands are acknowledged immediately by Python because they intentionally test or modify the transport service itself. Controls, params, Grid, Arc and gamepad commands are acknowledged only after Lua completes execution in matron.

The first valid controller command implicitly claims its ownership resource. Commands from another browser identity are rejected until the owner releases it or the reconnect lease expires.

## Local state bridge

Lua state and applied acknowledgements return over localhost UDP. Configure with:

```text
INGENUE_STATE_PORT
```

Default: realtime port + 1 (`7779`). The socket binds to `127.0.0.1`; datagrams from non-loopback sources are discarded. The bridge also expires command deadlines and disconnected ownership leases.

## Browser-origin mode

The realtime endpoint is open by default because Ingenue targets a trusted local network. Any browser that can reach the norns WebSocket port can therefore attempt controller commands; ownership prevents accidental multi-browser contention but is not authentication. Do not expose port `7778` to an untrusted network or the public internet.

Set the following environment variable to restore strict browser-origin checking:

```sh
INGENUE_REALTIME_STRICT=1
```

Strict mode accepts only an `Origin` matching the current Ingenue HTTP host and port. Reverse proxies or custom frontends can add exact origins:

```sh
INGENUE_REALTIME_ORIGINS=https://music.example,https://studio.example
```

In strict mode, missing, `null`, credential-bearing, and unmatched origins are rejected before a peer is created.

## Inspector

Open `/realtime-inspector.html` on the normal Ingenue HTTP port. It subscribes to the full authoritative state, exposes K1–K3, E1–E3, generic parameter control, revision state, command settlement and ownership data.

`?rt=<port>` overrides the realtime port for nonstandard installations.
