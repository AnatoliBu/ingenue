# Ingenue implementation plan

Ingenue is a browser-hosted virtual-controller platform for norns. The browser provides Grid, Arc, MIDI, gamepad, K/E, parameter and script-specific surfaces; norns remains the authoritative musical runtime.

The implementation follows matron lifecycle, Maiden embedded-web behavior, the current `:7777` visual language and pinned script references such as MLR.

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

Delivered balanced K/E, authoritative parameter lanes, four Grid/Arc vports, Browser MIDI lifecycle, standard browser gamepad support and a pinned MLR 2.2.5 reference/runtime/UI/E2E slice.

## Milestone 4 — Builder and script-specific surfaces

Status: complete in `main`.

Delivered schema v2 migration, Grid/Arc/MIDI/gamepad widgets, authoritative feedback, templates, named exact-script presets, script-provided metadata and lifecycle-safe browser contracts.

## Milestone 5 — visual parity and performance

Status: software and CI contract complete; physical Shield acceptance pending.

Delivered:

- one shared quality contract installed on every public surface;
- MLR in the shared bridge-safe navigation;
- desktop and phone target-size budgets with narrow instrument-cell exemptions;
- programmatic-name, contrast, focus and reduced-motion checks;
- desktop/tablet/phone visual-regression baselines;
- animation-frame and realtime ACK latency budgets;
- eight-cycle reconnect soak with bounded session/log/queue invariants;
- explicit physical-hardware acceptance matrix for audio, USB, native modals, psets and long-session validation.

## Working rule

Each vertical slice is assembled and validated before publication, then delivered as one large feature commit and one squash-merged PR. No UI feature bypasses the shared runtime, and every real-hardware regression receives a deterministic browser fixture before merge.
