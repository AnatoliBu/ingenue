# Per-script UI Builder

Ingenue's UI Builder creates script-specific performance surfaces without modifying community scripts. Every interactive widget uses the same typed browser → realtime → Lua-applied path as the built-in controller pages, while norns remains authoritative for script state, parameters, Grid/Arc LEDs and musical timing.

Open `http://norns.local:7777/builder.html`.

## Schema v2 and migration

Schema version `2` keeps the exact script name, surface name, one-to-four-column layout, metadata and at most 64 ordered widgets. Version `1` layouts are migrated automatically on first load and written to the v2 per-script storage key. Imports remain exact-script: a surface for `awake` cannot be applied to `mlr`.

```json
{
  "version": 2,
  "script": "mlr",
  "name": "MLR companion",
  "columns": 4,
  "metadata": {"source": "local", "revision": null},
  "widgets": [
    {"id":"grid","type":"grid","span":4,"label":"MLR 16×8","port":1,"shape":"16x8"},
    {"id":"focus","type":"key","span":1,"label":"K2 view","n":2},
    {"id":"rate","type":"encoder","span":1,"label":"E3 rate","n":3,"step":1},
    {"id":"output","type":"param","span":2,"label":"Output","paramId":"output_level","step":0.01}
  ]
}
```

## Widgets

- **Key:** K1–K3 with balanced pointer and keyboard release.
- **Encoder:** E1–E3 through buttons, wheel and keyboard arrows.
- **Parameter:** normalized norns parameter with one applied command in flight and authoritative formatted feedback.
- **Grid:** vport 1–4, 8×8, 16×8 or 16×16, ordinary `grid.key` input and authoritative LED frame rendering.
- **Arc:** vport 1–4 and ring 1–4, delta gestures, wheel/keyboard input, Arc key and authoritative 64-LED feedback.
- **MIDI:** note, CC or pitch-bend source mapped to K/E/parameter targets. Permission is user-initiated; connected inputs hotplug through Web MIDI. Held key mappings are released on device, profile, page, script or realtime loss.
- **Gamepad:** virtual button, d-pad or analog controls using the existing `gamepad.button`, `gamepad.dpad` and `gamepad.analog` contracts.
- **Label and spacer:** safe non-interactive layout elements; imported text is assigned through `textContent`.

## Templates and presets

The Builder ships reusable Performance, Grid + Arc, MIDI keys, Gamepad and MLR companion templates. Applying a template replaces the active layout only after confirmation. Named presets are stored per exact script and can be saved, loaded or removed without changing the currently running norns script.

## Script-provided metadata

A script or read-only adapter may publish an optional `ingenue_ui`, `ingenueUI` or `ui_surface` schema inside authoritative script state. The Builder uses it only when the browser has no local layout for that exact script. The first edit creates a local override; reset removes the override and exposes script metadata again. Invalid or cross-script metadata is ignored rather than partially rendered.

## Realtime and lifecycle

The preview subscribes to `script`, `params`, `control`, `grid` and `arc`. Imported JSON never executes Lua. Grid and Arc frames are rendered from norns snapshots/deltas instead of browser guesses. Every lifecycle transition—blur, page hide, hidden document, reconnect or script switch—releases held K/Grid/Arc/MIDI/gamepad state before the surface becomes inactive.

Editing remains available through a temporary reconnect, while preview controls stay disabled until the authoritative snapshot is synchronized again.

## CI contract

Node tests cover v1→v2 migration, exact-script validation, every widget schema, templates, metadata and preset isolation. Chromium tests cover Grid/Arc/gamepad commands, authoritative LED updates, MIDI mapping and held-key cleanup through the real HTTP/proxy/WebSocket fixture. Security checks assert fixed command targets, safe text rendering and bounded schemas.
