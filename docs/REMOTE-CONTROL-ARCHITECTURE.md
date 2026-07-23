# Remote control architecture

## Goal

Extend Ingenue from a responsive Norns management UI into a low-latency browser control surface for existing Norns scripts.

The browser is **not** an audio engine or the musical clock source. Norns remains responsible for audio, sequencing, transport, automation, project state, and recovery when the browser disconnects.

Initial targets:

- generic live control of registered Norns `params`;
- browser MIDI learn;
- virtual Grid with LED feedback;
- reusable script adapter API;
- later: MPC-style pads, piano roll, tracks, and Elektron-style parameter locks.

## Current baseline

Ingenue already provides:

- an always-on HTTP service on the Norns device;
- a responsive browser UI;
- a live Matron REPL WebSocket;
- bidirectional parameter editing;
- OSC control messages to Matron for keys, encoders, and params.

The existing control path in `web/server.py` sends OSC over UDP to Matron on `127.0.0.1:10111`. It is intentionally fire-and-forget. The REPL WebSocket is a separate channel.

Before extending the system, verify the exact current parameter update path and measure its behaviour on real Norns hardware.

## Core design rule

Use an **event-driven protocol with scheduled streams**, not one global tick rate.

### Events

Send immediately and once:

- button/key press and release;
- transport start/stop;
- track selection;
- preset load;
- sample selection;
- parameter commit.

### Coalesced continuous controls

Faders, encoders, XY pads, and envelope dragging may generate hundreds of browser events per second. The client should update locally at display speed while network sends are coalesced to a configurable ceiling, initially 30–60 updates per second. The final value of every gesture must always be delivered.

### Scheduled state streams

Only transient display state needs a periodic rate:

- playhead and step cursor: initially 30 Hz;
- Grid LED animation: dirty-region/event batches, with a 30 Hz flush ceiling;
- meters and visual modulation: optional 30–60 Hz;
- static params and project state: event-driven only.

Rates are subscription hints, not musical timing. Musical clock and sequencing never depend on the browser or Wi-Fi.

## Proposed topology

```text
Browser UI
  |  WebSocket: commands, subscriptions, snapshots, deltas
  v
Ingenue realtime service
  |  validated adapter messages
  +--> Matron / Lua script adapter
  +--> existing OSC control path during migration

Norns / Lua / SuperCollider
  - owns audio and clock
  - owns canonical project state
  - continues running after browser disconnect
```

## Protocol model

### Connection lifecycle

1. Client opens a WebSocket.
2. Server sends capabilities and protocol version.
3. Client requests a state snapshot and declares subscriptions.
4. Server sends snapshot with a monotonically increasing revision.
5. Server sends ordered deltas.
6. Client detects a revision gap and requests resync.
7. Heartbeats detect half-open connections.
8. Reconnect never restarts transport or audio.

Example subscription request:

```json
{
  "type": "subscribe",
  "streams": {
    "params": "event",
    "transport": "event",
    "playhead": 30,
    "grid": 30,
    "meters": 30
  }
}
```

Example delta:

```json
{
  "type": "state.delta",
  "revision": 1843,
  "changes": [
    {"path": "sequencer.playhead", "value": 7},
    {"path": "tracks.1.steps.7.active", "value": true}
  ]
}
```

## Delivery classes

Every message should declare or imply one of these behaviours:

- **reliable ordered:** transport, preset changes, edits, final gesture values;
- **coalescible:** intermediate fader/XY/envelope values; newest value wins;
- **ephemeral:** playhead, meters, animation frames; stale frames may be dropped;
- **snapshot:** complete recoverable state.

This distinction is more important than choosing a single tick rate.

## Generic compatibility levels

### Level 0 — remote Norns controls

Expose K1–K3, E1–E3, screen state where available, and existing params. Minimal or no script changes.

### Level 1 — generic params

Generate controls from the active script's parameter tree. Support normalized values, formatted values, options, triggers, and safe commit behaviour for large integer ranges.

### Level 2 — virtual Grid

Expose Grid key events and LED state for 8×8, 16×8, and 16×16 layouts. Scripts should use a small adapter rather than assuming direct hardware ownership.

### Level 3 — script adapter

A script explicitly exports actions and structured state:

```lua
remote.register_action("transport.play", play)
remote.register_action("sequencer.set_step", set_step)
remote.register_state("sequencer", get_sequencer_state)
```

This enables tracks, piano roll, sample slicing, parameter locks, and other native editors without moving musical logic into JavaScript.

## Virtual Grid requirements

- key down/up events;
- multi-touch support;
- LED brightness levels;
- batched dirty LED updates;
- reconnect snapshot;
- dimension and rotation metadata;
- no browser scrolling, zooming, or text selection during performance gestures;
- hardware Grid and browser Grid may coexist when the script supports multiple clients.

## Browser MIDI requirements

- enumerate Web MIDI inputs;
- explicit device permission and connection status;
- MIDI learn for note, CC, pitch bend, and relative encoders;
- saved mappings scoped by script and device identity;
- value normalization at the Norns boundary;
- soft takeover to prevent parameter jumps;
- feedback output when supported;
- browser MIDI must be optional: Norns-local USB MIDI remains supported.

## Concurrency

Multiple input sources may edit the same parameter: browser, physical MIDI, Grid, Norns encoders, and another browser client.

Initial policy:

- canonical value lives on Norns;
- last accepted edit wins;
- continuous gestures temporarily claim a control;
- physical MIDI supports soft takeover;
- all clients receive the resulting canonical value;
- project-structure edits may later require an explicit edit lease.

## Performance and safety budgets

Initial targets to validate on real hardware:

- button-to-accepted-command median under 20 ms on local wired/Wi-Fi networks;
- no audio glitches during worst-case UI traffic;
- bounded queues with coalescing of continuous values;
- stale ephemeral frames dropped rather than queued;
- reconnect produces a consistent snapshot;
- no arbitrary Lua evaluation in the normal control protocol;
- local-network access by default, with token/session authentication before any remote exposure.

These are hypotheses until measured.

## First vertical slice

Use one real Grid-oriented Norns script.

1. Instrument the existing paths and record latency, message rate, CPU, and queue behaviour.
2. Add a versioned realtime WebSocket endpoint.
3. Implement snapshot, revision, delta, heartbeat, and resync.
4. Add a virtual 8×8/16×8 Grid with bidirectional LED state.
5. Add one minimal Lua adapter to the chosen script.
6. Confirm that Norns continues playing correctly through browser refresh, network loss, and reconnect.
7. Only then add browser MIDI learn and richer sequencer views.

## Non-goals for the first release

- browser audio streaming;
- browser-owned musical clock;
- universal extraction of arbitrary Lua local variables;
- full Ableton/MPC/Elektron clone;
- hardware PCB design before the interaction model is validated.
