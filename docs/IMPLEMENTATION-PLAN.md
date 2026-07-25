# Ingenue implementation plan

Ingenue is a browser-hosted virtual-controller platform for norns. The browser provides Grid, Arc, MIDI, gamepad, K/E, parameter and script-specific surfaces; norns remains the authoritative musical runtime.

The implementation order follows matron lifecycle, Maiden embedded-web behavior, the current `:7777` UI and pinned script-level references such as MLR.

## Milestone 0 — browser ↔ norns contract gate

Status: complete in `main`.

Delivered Chromium E2E, real HTTP/proxy/WebSocket fixtures, route preservation, K/E/Grid/Arc/params/MIDI/gamepad/Builder commands, ACK/reject/reconnect/ownership and failure artifacts.

## Milestone 1 — unified matron runtime boundary

Status: complete in `main`.

Delivered one command registry, exact browser schemas, runtime/script generations, stale-command rejection, normalized errors, centralized settlement and a bounded structured event log.

## Milestone 2 — Maiden-style application shell

Status: complete in `main`.

Delivered one connection/status model, diagnostics drawer, bridge-safe navigation, explicit transient states, focus/touch behavior and shared `:7777` visual tokens.

## Milestone 3 — virtual-device and reference-script parity

Status: software and CI coverage complete; real-Shield acceptance remains.

### K/E and parameters

Status: complete in `main`.

- balanced pointer/keyboard release across blur, pagehide, visibility loss and reconnect;
- encoder drag, wheel and keyboard deltas;
- norns-authoritative parameter descriptors and ACK-applied value lanes.

### Grid and Arc

Status: complete in the automated contract.

- four vports, supported native shapes, rotation/intensity and lifecycle;
- authoritative LED snapshots;
- multitouch slide and reconnect-safe held ledgers;
- native Arc delta/key gestures and feedback.

### MIDI and gamepad

Status: complete in the browser-device lifecycle slice.

- connected-only Web MIDI inventory and automatic hotplug;
- release of held mapped norns keys on input/profile/script/session loss;
- descriptor and pickup rebuild after reconnect;
- physical W3C standard browser gamepad mapping;
- buttons, d-pad, sticks and triggers with dead zones and change thresholds;
- complete neutral-state cleanup on disconnect, focus loss and page lifecycle loss.

### MLR vertical slice

Status: complete in `main`; real audio/timing/modal/pset acceptance remains.

- pinned upstream reference pack for `tehn/mlr` 2.2.5;
- exact Grid/K/E/LED/state map;
- read-only Lua observer with 20 Hz playhead/state publication;
- `mlr` realtime channel and capabilities;
- specialized responsive `/mlr.html` surface;
- 16×8 raw Grid parity, multitouch and desktop two-point loop chord;
- six track cards, seven clips, four patterns and four recalls;
- Node, Python, static Lua and Chromium scenarios.

Exit gate: standard norns scripts cannot distinguish Ingenue virtual devices from public norns APIs for covered operations, and pinned reference scenarios pass their CI matrices. Audio, USB hardware and native modal behavior are finalized by the documented Shield matrix.

## Milestone 4 — Builder and script-specific surfaces

Status: next.

- versioned per-script schema;
- Grid/Arc/MIDI/gamepad widgets;
- migrations, templates and presets;
- optional script-provided metadata;
- live preview through the shared runtime only.

## Milestone 5 — visual parity and performance

- consolidated components and tokens;
- desktop/tablet/phone visual regression;
- touch, contrast, focus and reduced-motion checks;
- frame-time and command-latency budgets;
- long-session reconnect and memory testing;
- final real-Shield acceptance.

## Working rule

Each vertical slice is assembled and validated before publication, then delivered as one large feature commit and one squash-merged PR. No UI feature bypasses the shared runtime, and every real-hardware regression receives a deterministic browser fixture before merge.
