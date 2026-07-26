# MLR reference and browser parity

Ingenue treats `tehn/mlr` as a reference application for proving that the browser can replace the physical norns/Grid control surface without taking authority away from the script.

Pinned upstream:

- repository: `tehn/mlr`
- commit: `1c21309bdfa1a6bdccd5f4fef5aea9768870732f`
- script version: `2.2.5`
- source: `mlr.lua`

The pinned script uses six softcut voices, a 16×8 varibright Grid, K1–K3, E1–E3, norns parameters, four gesture patterns and four recall slots. Ingenue does not fork or patch MLR. The norns script remains authoritative; the Ingenue mod only observes public script state and the browser sends normal K/E/Grid callbacks.

## Browser contract

The MLR page provides:

- an explicit workflow for track/clip targeting, recording, transport, cuts, loops and clip operations;
- the complete 16×8 Grid input surface and authoritative LED frame;
- simultaneous multitouch holds;
- a desktop Shift-click chord gesture for two-point loop selection;
- K1–K3 momentary controls and E1–E3 bounded deltas;
- six track state cards;
- clip, pattern and recall state;
- view, focus, ALT and quantize state;
- reconnect-safe release of every held or latched input;
- a persistent command status that exposes the exact target, error code and reject message.

No browser action calls softcut directly. The explicit workflow emits the same original Grid/K/E sequences as a physical surface. Audio, timing, quantization, patterns, recalls, psets, file selection and buffer operations remain inside MLR/norns.

## Files

- `USAGE.md` — practical record, playback, loop and clip-management workflow.
- `CONTROL-MAP.md` — exact Grid and norns control mapping.
- `STATE-AND-LED-CONTRACT.md` — state published by the adapter and LED meanings.
- `BROWSER-COVERAGE.md` — implementation and acceptance matrix.
- `TEST-SEQUENCES.md` — deterministic browser and real-Shield scenarios.
