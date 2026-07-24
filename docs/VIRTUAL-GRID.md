# Configurable virtual Grid

Ingenue exposes one browser-hosted monome Grid-compatible device through the normal norns `grid.connect()` vport contract. The active script, engine and audio remain on norns; the browser only sends key events and renders authoritative LED frames.

## Profiles

The performance deck supports the common native layouts:

- 8×8;
- 16×8;
- 16×16.

A profile also stores vport 1–4 and rotation 0°, 90°, 180° or 270°. The configuration is persisted in `dust/code/ingenue/data/virtual-grid-config` and loaded before each script initializes. Reload the script after changing its vport or dimensions so scripts which cache `g.cols` / `g.rows` rebuild their layout.

Ingenue refuses to move the virtual Grid onto a vport occupied by a physical device. If a physical Grid appears on the configured vport, it remains authoritative; the virtual device can be moved to another free vport from the browser.

## Input

Grid input preserves standard `key(x, y, z)` semantics. Pointer tracking is container-level rather than button-level, which allows:

- simultaneous touches;
- sliding between cells;
- a balanced release before the next cell is pressed;
- release-all on disconnect, page hide or pointer cancellation.

## Output and lifecycle

`led`, `all`, `intensity`, `rotation` and `refresh` are mirrored into an authoritative frame. Frames include:

- vport;
- oriented columns and rows;
- 16-level LED payload;
- sequence and global intensity;
- virtual/physical identity;
- rotation 0–3.

Changing vport publishes a delete operation for the old port before the new full frame. Device reconciliation also publishes `/ingenue/grid/disconnect` whenever a previously mirrored physical or virtual port disappears, preventing stale devices from remaining in reconnect snapshots.

On script cleanup, every attached Grid frame is zeroed and republished before the next script starts. The browser therefore never treats LEDs from the previous script as current state.

## Device validation

CI validates shape and rotation normalization, OSC command validation, stale-port deletion, persistent configuration wiring, multitouch slide semantics, cleanup frames, Python 3.7 compatibility and the legacy Grid/Arc/MIDI contracts. Real-device validation remains required against awake, mlr, meadowphysics, n.kria, ndls and cheat_codes_2.
