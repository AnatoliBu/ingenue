# Ingenue implementation plan

Ingenue is a browser-hosted virtual controller platform for norns. The browser provides Grid, Arc, MIDI, gamepad, K/E, parameter and script-specific surfaces; norns remains the authoritative musical runtime.

The implementation order follows the norns/matron lifecycle, Maiden's embedded-web behavior, and the current Ingenue UI at `http://norns.local:7777/`.

## Milestone 0 — browser ↔ norns contract gate

Status: complete in `main`.

Goal: make the real browser boundary observable and mandatory in CI before adding more features.

Delivered:

- Chromium E2E job in GitHub Actions.
- Real HTTP, localhost proxy and RFC 6455 WebSocket fixture.
- Surface boot and navigation checks for public pages.
- Exact realtime-target preservation across the localhost bridge.
- Command coverage for K/E, Grid, Arc, parameters, MIDI, gamepad and Builder.
- ACK, reject, disconnect, reconnect and ownership coverage.
- Playwright trace, screenshots, video and console output on failure.

Exit gate: unit, Python, browser-contract and security jobs are green.

## Milestone 1 — unified matron runtime boundary

Status: active.

Goal: one browser-side and one server-side contract for all matron-facing commands.

Code changes:

- Introduce a shared command registry with target/action schemas and capabilities.
- Normalize errors into stable categories: validation, ownership, unavailable, matron-timeout, runtime-error and connection-lost.
- Carry script generation/session generation through snapshots and acknowledgements.
- Reject stale commands after script changes or reconnects.
- Centralize ACK/reject/timeout handling instead of duplicating it in each surface.
- Publish a bounded structured event log suitable for UI diagnostics and CI assertions.

Exit gate: every control surface uses the same runtime client and error model.

## Milestone 2 — Maiden-style application shell

Goal: remove per-page connection and navigation drift.

Code changes:

- Shared application shell for navigation, endpoint, script, revision and connection state.
- Persistent diagnostics drawer showing structured events, reconnects and matron errors.
- Explicit loading, synced, reconnecting, degraded and disconnected states.
- Preserve bridge/device parameters on every internal transition.
- Keyboard navigation, focus states and touch-safe controls.
- Shared visual tokens based on the current `:7777` UI.

Exit gate: all pages inherit one shell and pass route/origin/reconnect E2E tests.

## Milestone 3 — virtual-device parity

### K/E and parameters

- Balanced key press/release on pointer, keyboard, blur, pagehide and disconnect.
- Encoder drag, wheel and keyboard input with bounded deltas.
- Parameter descriptors, normalized values, pickup and latest-value lanes.

### Grid

- Four vports, 8×8/16×8/16×16, rotation and intensity.
- Add/remove lifecycle and authoritative LED snapshots.
- Multitouch slide, held-key ledger and reconnect release.

### Arc

- Four vports, two/four rings, 64 LED levels and intensity.
- Delta, key, touch gestures and authoritative feedback.

### MIDI and gamepad

- Browser MIDI input/output lifecycle, learn, feedback and hotplug.
- Gamepad buttons, d-pad, sticks and triggers with dead zones and centering.

Exit gate: standard norns scripts cannot distinguish Ingenue virtual devices from the corresponding public norns APIs for covered operations.

## Milestone 4 — Builder and script-specific surfaces

Goal: build musical interfaces on top of the stable runtime rather than bypassing it.

Code changes:

- Versioned per-script surface schema.
- Grid/Arc/MIDI/gamepad widgets in addition to K/E/parameter widgets.
- Import/export validation and migrations.
- Script-provided optional surface metadata.
- Presets and reusable controller templates.
- Live preview through the same authoritative command path.

Exit gate: a saved surface survives reload, script switching and protocol upgrades without stale control events.

## Milestone 5 — visual parity and performance

Goal: make Ingenue feel like a native norns instrument.

Code changes:

- Consolidate shared design tokens and component states.
- Visual-regression snapshots for desktop, tablet and phone widths.
- Touch target, contrast, focus and reduced-motion checks.
- Frame-time and command-latency budgets.
- Long-session reconnect and memory tests.

Exit gate: functional and visual contract suites are green, followed by final acceptance on a real norns Shield.

## Working rule

Each milestone is delivered as one meaningful PR or a small number of complete vertical slices. New UI features do not bypass the shared runtime boundary, and a regression discovered on real hardware receives a browser fixture scenario before the fix is merged.
