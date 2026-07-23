# Remote control roadmap

This roadmap tracks the evolution of Ingenue into a browser-based performance and editing surface for Norns while keeping audio, musical timing, and canonical state on the device.

## Phase 0 — audit and measurement

- Map the existing browser → server → Matron paths.
- Identify how live `params` updates reach the browser today.
- Measure command latency, update rate, CPU, memory, network traffic, and failure behaviour on real Norns hardware.
- Add diagnostics for sent, received, coalesced, dropped, stale, and resynced messages.
- Select one representative Grid-oriented script for the first vertical slice.

**Exit criteria:** documented baseline and a repeatable test procedure.

## Phase 1 — realtime protocol

- Add a versioned control WebSocket separate from unrestricted REPL usage.
- Define commands, events, snapshots, deltas, revisions, subscriptions, acknowledgements where required, and error responses.
- Add heartbeat, reconnect, revision-gap detection, and full resync.
- Add bounded queues and delivery classes: reliable, coalescible, ephemeral, snapshot.
- Add rate limits and final-value guarantees for continuous gestures.

**Exit criteria:** reconnect-safe parameter and transport demo without audio disruption.

## Phase 2 — virtual controls and browser MIDI

- Reusable buttons, switches, encoders, faders, XY pads, and envelope editors.
- Web MIDI device discovery and permission UX.
- MIDI learn for notes, CC, pitch bend, and relative encoders.
- Mapping persistence by script and device.
- Value normalization and formatted-value feedback.
- Soft takeover and optional MIDI feedback.

**Exit criteria:** a physical MIDI controller connected to the browser can safely control a running Norns script.

## Phase 3 — virtual Grid

- 8×8, 16×8, and 16×16 layouts.
- Key down/up and multi-touch.
- LED brightness feedback.
- Batched dirty-region updates and snapshot on reconnect.
- Layout metadata: dimensions, rotation, pages, and labels.
- One adapted real script with browser and physical Grid coexistence where possible.

**Exit criteria:** the selected script can be used end-to-end from a browser Grid without changing its musical logic.

## Phase 4 — script adapter API

- Lua registration API for actions and structured state providers.
- Script capability manifest.
- Subscriptions to script-specific state.
- Stable serialization rules and schema versioning.
- Generic fallback for scripts exposing only `params`.
- Adapter examples and author documentation.

**Exit criteria:** a second script can add a native browser view without modifying the Ingenue core.

## Phase 5 — sequencer and sampler editors

- Track selection and mixer surface.
- Step sequencer and piano roll.
- MPC-style pad banks.
- Sample/waveform and slice editing.
- Elektron-style parameter locks.
- Trig conditions, probability, microtiming, retrigs, and per-track length.
- Gesture-safe undo/redo and project-state validation.

**Exit criteria:** one complete instrument workflow demonstrates the adapter API and survives reconnects.

## Phase 6 — hardware portability

- Define a hardware-neutral control schema.
- Export browser layouts and mappings as device descriptions.
- Prototype on RP2040/RP2350 or another suitable controller platform.
- Validate displays, encoders, pads, LEDs, USB MIDI, and network transport.
- Keep Norns/browser/hardware implementations compatible at the semantic command level.

**Exit criteria:** the same control layout can be exercised in the browser and on a hardware prototype with minimal mapping changes.

## Principles

1. Norns owns audio, clock, sequencing, and canonical project state.
2. Static state is event-driven; only transient visualization uses scheduled streams.
3. No single global tick rate.
4. Intermediate continuous values may be coalesced; final values may not be lost.
5. Disconnecting the browser must never stop the music.
6. Measure on real hardware before optimizing or committing to PCB design.
