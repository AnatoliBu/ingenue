# Realtime protocol v1

Tracking: #3  
Architecture decision: `docs/adr/ADR-001-python-first-replaceable-transport.md`

## Authority model

The browser is a remote control and renderer. Norns remains authoritative for audio, sequencing and script state. A browser reconnect must request the current snapshot; it must not restart playback or reconstruct device state from stale local values.

## Envelope

Every message is a JSON object with:

- `v`: protocol version, currently `1`;
- `type`: `hello`, `subscribe`, `snapshot`, `delta`, `command`, `ack`, `reject`, `heartbeat` or `resync`;
- `id`: command identifier when correlation is required;
- `rev`: authoritative state revision on snapshots, deltas and acknowledgements.

Unknown versions and message types are rejected.

## State synchronization

A subscription begins with a complete `snapshot`. Later `delta` messages must arrive at exactly `current revision + 1`.

When a gap or out-of-order delta is detected, the client:

1. preserves the last known-good state;
2. enters `resyncing` state;
3. emits an explicit `resync` request;
4. waits for a replacement snapshot.

It never applies a divergent delta speculatively.

Delta operations are path-based:

```json
{"v":1,"type":"delta","rev":12,"operations":[
  {"op":"set","path":["transport","playing"],"value":true},
  {"op":"delete","path":["tracks",3,"preview"]}
]}
```

## Commands

Reliable commands carry an `id`. The device responds with `ack` or `reject` using the same `id`. An acknowledgement may include the authoritative revision produced by the command.

```json
{"v":1,"type":"command","id":"cmd-42","command":{"target":"transport","action":"start"}}
{"v":1,"type":"ack","id":"cmd-42","rev":83}
```

HTTP acceptance or socket send completion is not an acknowledgement.

## Delivery classes

### Reliable

Discrete edits and commands. Never silently dropped. Queue overflow is surfaced as an error.

### Coalescible

Continuous controls such as faders, knobs and XY pads. Only the newest pending value per control key is retained. A gesture's final value is marked and preserved.

### Ephemeral

Meters, playheads and transient LEDs. Only the newest pending frame per stream key matters; stale frames may be discarded.

All queues are bounded.

## Heartbeat and reconnect

Heartbeat updates connection-health timestamps but does not advance state revision. After reconnect the client subscribes again and receives a new authoritative snapshot before rendering itself as synchronized.

## Current implementation status

`web/realtime-protocol.js` implements and tests:

- envelope validation;
- snapshot and ordered-delta reduction;
- revision-gap detection and resync requests;
- heartbeat state;
- command id tracking with ack/reject settlement;
- bounded reliable, coalescible and ephemeral outbound queues;
- final-value preservation for continuous gestures.

The next increment connects this core to an actual device-side session and exercises reconnect/snapshot behavior on norns.
