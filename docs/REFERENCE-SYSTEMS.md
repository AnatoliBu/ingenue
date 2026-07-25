# Reference systems for Ingenue

Ingenue is not designing a browser control stack in isolation. The compatibility and product references below are mandatory study material for implementation, review, testing and hardware acceptance.

## norns and matron

Primary references:

- `monome/norns`;
- matron and the Lua-facing norns libraries;
- current norns release and migration notes.

Study script load/cleanup/restart, K/E ingestion, Grid/Arc/MIDI/HID routing, vports, screen ownership, callback dispatch, runtime logs and failure propagation.

Engineering rules:

- norns remains authoritative for script and controller state;
- browser commands are acknowledged only after Lua-side application;
- press and release events remain balanced across disconnects;
- reconnect and script switching are lifecycle transitions;
- internal matron symbols are reference material, not a stable extension API.

## Maiden and the native norns browser experience

Primary references:

- `monome/maiden`;
- official Maiden documentation;
- a live Ingenue/norns web interface at `http://norns.local:7777/`.

Study embedded HTTP, WebSocket reconnect, REPL/log presentation, loading/disconnected/stale states, navigation, keyboard workflows and local-HTTP constraints.

Engineering rules:

- failures are visible in-page and in browser diagnostics;
- reconnect restores one coherent authoritative snapshot;
- endpoint and connection state are inspectable;
- local-network operation has no cloud dependency;
- localhost helpers preserve the actual norns realtime target.

## MLR reference application

`tehn/mlr` is the first script-level compatibility reference. Ingenue pins commit `1c21309bdfa1a6bdccd5f4fef5aea9768870732f` (`mlr.lua` 2.2.5) and treats it as a complete musical acceptance scenario rather than a generic Grid demo.

The detailed contract lives under `docs/references/mlr/` and covers:

- six softcut tracks and seven clip slots;
- REC, CUT, CLIP and TIME views;
- the complete 16×8 Grid coordinate map;
- two-point loop chords and multitouch ordering;
- patterns, recalls, ALT and quantize;
- K1–K3/E1–E3 behavior;
- authoritative Grid LED meanings;
- a read-only observer state channel;
- browser and real-Shield acceptance sequences.

Engineering rules:

- Ingenue never forks or patches MLR;
- MLR/softcut remain authoritative for audio and timing;
- browser input uses ordinary Grid and K/E callbacks;
- the MLR observer is read-only and publishes only changed state;
- LEDs are rendered from the standard Grid frame, not reconstructed optimistically;
- native file/text entry and pset workflows stay on norns.

## Current Ingenue UI on port 7777

The interface served from `http://norns.local:7777/` is the visual and interaction baseline. Preserve near-black backgrounds, raised dark panels, muted-green borders, lime active accents, compact monospace headings, touch-safe controls, visible runtime state and an instrument—not dashboard—feel.

Avoid unrelated component-library styling, excessive animation, mouse-only controls, hidden transport/ACK state and page-specific visual systems.

## Reference-to-test contract

| Area | Primary reference | Required protection |
| --- | --- | --- |
| Script lifecycle | matron / norns runtime | load, cleanup, restart and script-switch tests |
| K1-K3 and E1-E3 | matron input path | press/release and encoder-delta browser E2E |
| Grid and Arc | norns Lua libraries and vports | configuration, feedback, reconnect and release tests |
| MIDI, HID and gamepad | norns device libraries | routing, ownership, hotplug and neutral-state tests |
| MLR | pinned `tehn/mlr` 2.2.5 | full control map, observer state, LED frame and musical scenario tests |
| Logs and errors | Maiden REPL and console | ACK, reject, timeout and reconnect diagnostics |
| Embedded web routing | Maiden and native norns web | origin, proxy, navigation and WebSocket endpoint tests |
| Visual language | current Ingenue `:7777` UI | shared tokens, responsive checks and visual regression |

## Hardware acceptance boundary

Browser fixtures and CI validate protocol behavior, event ordering, routing, ownership, state parsing, ACK semantics, reconnect logic and UI rendering. They cannot prove audio recording, softcut timing, USB devices, native modal workflows or the exact installed Shield runtime. Each script-level reference therefore ends with a real norns Shield acceptance sequence.
