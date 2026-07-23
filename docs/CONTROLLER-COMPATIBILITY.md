# Browser controller compatibility priorities

This document records which existing norns controller interfaces Ingenue should emulate first.

## Priority 1: monome Grid

Target the native `grid.connect()` / vport contract rather than a script-specific layout.

Required compatibility:

- virtual ports 1–4, with port 1 as the default compatibility target;
- 8×8, 16×8 and 16×16 device profiles;
- `key(x, y, z)` press/release semantics;
- 16-step LED brightness, `led`, `all`, `intensity`, `refresh`;
- rotation and responsive browser orientation;
- full frame on reconnect plus bounded deltas;
- optional virtual hotplug lifecycle for scripts which wait on `grid.add`;
- coexistence with a physical Grid without stealing its vport.

The existing Ingenue adapter already injects a 16×8 virtual Grid into an empty port 1 and mirrors varibright LED frames. The next Grid slice hardens lifecycle, size selection, rotation, multiple ports and real-script compatibility.

Reference scripts for validation: awake, mlr, meadowphysics, n.kria, ndls and cheat_codes_2.

## Priority 2: monome Arc

Implement a native-compatible virtual Arc, not generic browser knobs.

Required compatibility:

- 2-ring and 4-ring layouts;
- 64 LEDs per ring at 16 brightness levels;
- high-resolution `delta(n, delta)` events;
- Arc 2025 pushbutton `key(n, z)` support;
- `led`, `all`, `segment`, `refresh` frame mirroring;
- inertia-free touch rotation plus optional fine/coarse gesture modifiers;
- vports 1–4 and coexistence with physical Arc.

Reference scripts for validation: arcify, mangl, easygrain, ndls, cheat_codes_2, gridofpoints and pedalboard.

## Priority 3: Launchpad / Midigrid browser skin

Do not emulate every Launchpad MIDI protocol in the norns device layer. Existing norns Midigrid already translates Launchpads and other MIDI pad matrices into Grid semantics. Ingenue should therefore expose a Launchpad-style browser layout which targets the same virtual Grid backend:

- 8×8 pad area;
- optional top and side utility buttons;
- configurable coordinate transforms;
- monochrome varibright compatibility as the guaranteed baseline;
- optional RGB presentation only as browser-side decoration unless a script-specific adapter defines colors.

This gives Launchpad familiarity while retaining compatibility with ordinary Grid scripts.

## Priority 4: browser Gamepad

The norns `gamepad` API is standardized and can be represented with a D-pad, A/B/X/Y, shoulders, triggers and two analog sticks. It is useful but appears in fewer community scripts than Grid and Arc, so it follows those interfaces.

## Not hardware-emulated: crow

Crow is CV input/output hardware. A browser can expose controls which drive parameters or explicit virtual-CV adapters, but it must not impersonate physical crow outputs or claim that voltage was produced. Crow-specific UI belongs behind opt-in script adapters.

## Delivery order

1. Grid compatibility hardening and real-script matrix.
2. Native virtual Arc and ring renderer.
3. Combined performance deck with Norns K/E + Grid + Arc.
4. Launchpad/Midigrid skin.
5. Gamepad surface.
6. Script-specific MPC/Elektron/clip-launcher adapters.
