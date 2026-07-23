# Lua applied-command adapter

Tracking: #3, #6, #7

The Ingenue norns mod is the device-side authority boundary for realtime commands. Python validates and transports a command, but the browser receives a successful `ack` only after the Lua callback finishes inside matron.

## Lifecycle

`web/lib/mod.lua` registers:

- `script_pre_init`: attach the virtual Grid when needed and wrap `osc.event`;
- `script_post_init`: publish active script metadata and complete Grid frames;
- `script_post_cleanup`: publish inactive state and restore the script's prior OSC handler.

The launcher idempotently appends `ingenue` to `dust/data/system.mods` while preserving existing mod order. A newly enabled adapter requires one norns/matron restart before Lua-applied commands become available. Until then commands time out and are rejected honestly; the Python service never fabricates applied acknowledgements.

## Applied acknowledgement flow

```text
browser command id
  → Python validates
  → server creates unique wire id
  → pending wire id is registered
  → /ingenue/command over localhost OSC
  → Lua executes _norns.enc, _norns.key, params:set, or Grid key
  → /ingenue/ack or /ingenue/reject
  → Python maps wire id back to browser id
  → authoritative delta, then browser ack
```

Registering the pending command before `osc_send()` removes the fast-ack race. Server-generated wire ids prevent two browser sessions using their own local `cmd-1` from colliding. Pending commands are bounded and time out after three seconds.

## State bridge

Lua sends state to a UDP socket bound only to `127.0.0.1`. The default port is realtime WebSocket port + 1 (`7779`). Python writes the chosen port to:

```text
dust/code/ingenue/data/realtime-state-port
```

Messages:

- `/ingenue/ack <wire-id>`
- `/ingenue/reject <wire-id> <error>`
- `/ingenue/script/state <active> <name> <shortname>`
- `/ingenue/grid/frame <port> <cols> <rows> <hex-frame> <sequence> <intensity> <virtual>`

The browser protocol exposes `script` and `grid` channels as authoritative snapshot/delta state.

## Virtual Grid

When Grid vport 1 has no physical device, the adapter attaches a 16×8 no-op device so ordinary scripts using `grid.connect()` continue through the standard vport methods. It does not add the virtual device to `grid.devices` and does not fire a fake physical hotplug callback.

The adapter wraps `led`, `all`, `intensity`, and `refresh` on all four vports:

- physical Grid output still calls the original method;
- logical LED state is mirrored in parallel;
- a frame is emitted on `refresh()`;
- physical devices replace the virtual device normally when Norns updates its device mapping.

Frame encoding is row-major, one hexadecimal nibble per LED (`0`–`f`). Browser key events use 1-based coordinates and are executed through the active vport/device handlers.

## Delivery and reconnect

Every authoritative state change increments one global revision. A client not subscribed to the changed channel receives an empty delta for that revision, preventing false revision gaps. Reconnect always starts from a fresh snapshot.

Coalesced browser commands remove displaced command ids from the tracker. Commands already written to a socket but disconnected before acknowledgement settle as `uncertain`: Lua may have applied them even though the browser lost the reply, so they are not blindly replayed.

## Validation boundary

Automated tests cover the Python bridge, OSC decoding, wire-id correlation, timeout/reject behavior, revision continuity, mod registry, browser queue tracking, and static Lua wiring. Actual matron hook execution and Grid behaviour remain part of the final device test because the CI runner is not a Norns runtime.
