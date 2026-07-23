# Device realtime endpoint

Tracking: #3

Ingenue launches two stdlib-only services from the existing `server.py` entrypoint:

- HTTP editor/API on `INGENUE_PORT` (default `7777`);
- protocol-v1 WebSocket on `INGENUE_REALTIME_PORT` (default HTTP port + 1, normally `7778`).

The established HTTP implementation remains in `server_legacy.py`. The small launcher starts the realtime endpoint in a daemon thread, then starts the existing HTTP backend. All new Python modules remain compatible with Python 3.7 grammar.

## Endpoint

`ws://<norns-host>:7778/realtime`

Supported behavior:

- `hello` capability negotiation;
- subscriptions to `device`, `control`, and `grid`;
- authoritative snapshot and monotonic delta revisions;
- no-op deltas for filtered subscriptions, preserving the global revision sequence;
- explicit resync snapshots;
- correlated `ack` / `reject` command settlement;
- 2-second browser heartbeats;
- masked and bounded WebSocket frames;
- Origin validation against the Ingenue HTTP host/port.

Reverse proxies or custom frontends can add exact origins with:

```sh
INGENUE_REALTIME_ORIGINS=https://music.example,https://studio.example
```

## Applied acknowledgements

Commands affecting norns use this path:

```text
browser
→ protocol WebSocket
→ bounded Python pending map
→ localhost UDP OSC
→ Ingenue Lua mod inside matron
→ script handler / params / Grid vport
→ localhost OSC ack or reject
→ protocol revision + delta + browser ack
```

Python no longer treats UDP `sendto()` as success. The command receives `ack` only after the Lua adapter returns from the actual matron-side handler. A Lua exception becomes `reject`, and a missing adapter or lost reply becomes a bounded timeout without advancing state revision.

The Python reply listener binds only to `127.0.0.1`. Its default port is `10112`; override it with `INGENUE_OSC_REPLY_PORT` when necessary.

## Commands

```json
{"v":1,"type":"command","id":"cmd-1","command":{"target":"control","action":"enc","args":{"n":2,"d":1}}}
{"v":1,"type":"command","id":"cmd-2","command":{"target":"control","action":"key","args":{"n":3,"z":1}}}
{"v":1,"type":"command","id":"cmd-3","command":{"target":"param","action":"set","args":{"id":"cutoff","value":0.5}}}
{"v":1,"type":"command","id":"cmd-4","command":{"target":"grid","action":"key","args":{"port":1,"x":4,"y":3,"z":1}}}
```

`system.ping` remains local to Python and responds immediately. Every other command is settled by matron.

## Lua mod

The installer already copies `web/lib/mod.lua` into `dust/code/ingenue/lib/mod.lua`. In accordance with norns mod behavior, the user explicitly enables **ingenue** under `SYSTEM > MODS` and restarts norns. The WebSocket snapshot reports whether the file is installed, whether the mod is enabled, and whether its heartbeat is currently online.

## Interfaces

- `/realtime-inspector.html` — engineering state and command inspector;
- `/performance.html` — first performance-oriented K/E/Grid surface.
