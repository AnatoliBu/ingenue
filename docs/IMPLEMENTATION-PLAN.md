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

Delivered:

- balanced K/E lifecycle and keyboard encoder parity;
- norns-authoritative parameter descriptors and applied-value lanes;
- four Grid/Arc vports, native shapes, rotation/intensity, LED feedback, multitouch and reconnect cleanup;
- connected-only Browser MIDI hotplug, learn, feedback and held-key release;
- standard browser gamepad buttons, d-pad, sticks and triggers with dead zones and full neutralization;
- pinned `tehn/mlr` 2.2.5 reference, read-only observer, strict state channel, responsive MLR surface and deterministic CI scenarios.

Audio timing, USB hardware, native file/text modals and pset behavior remain in the documented Shield acceptance matrix and must not be claimed from fixtures alone.

## Milestone 4 — Builder and script-specific surfaces

Status: implemented in Builder schema v2; CI acceptance in progress.

Delivered:

- deterministic migration from schema v1;
- Grid, Arc, Browser MIDI and gamepad widgets alongside K/E/parameter/layout widgets;
- authoritative Grid/Arc feedback and balanced multitouch/gesture cleanup;
- typed MIDI and gamepad mappings through the shared runtime only;
- reusable templates, exact-script named presets and optional script-provided metadata;
- local overrides without modifying community script repositories;
- desktop, touch and reload E2E scenarios.

Exit gate: migration, import/export, templates, presets, script switching, lifecycle cleanup and all advanced widget command paths pass unit, Chromium and security CI.

## Milestone 5 — visual parity and performance

Status: next.

- consolidate component tokens and state styling across every public surface;
- desktop/tablet/phone visual-regression coverage;
- touch-target, contrast, focus and reduced-motion checks;
- frame-time and command-latency budgets;
- reconnect soak, bounded logs/queues and long-session memory checks;
- final real-Shield acceptance matrix.

## Working rule

Each vertical slice is assembled and validated before publication, then delivered as one large feature commit and one squash-merged PR. No UI feature bypasses the shared runtime, and every real-hardware regression receives a deterministic browser fixture before merge.
