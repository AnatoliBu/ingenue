# Per-script UI Builder

Ingenue's UI Builder creates small performance surfaces without changing the active norns script. The browser stores a versioned layout for the exact script name and renders its widgets through the same realtime ownership and Lua-applied command path as the built-in performance pages.

Open:

```text
http://norns.local:7777/builder.html
```

## Schema

Builder schemas use version `1` and contain:

- the exact active script name;
- a user-facing surface name;
- one to four responsive columns;
- at most 64 ordered widgets.

Layouts are stored in browser `localStorage` under an encoded per-script key. Switching scripts immediately switches layouts. An imported schema must name the currently active script; this prevents accidentally applying a control surface to a different parameter namespace.

Example:

```json
{
  "version": 1,
  "script": "awake",
  "name": "Awake live",
  "columns": 2,
  "widgets": [
    {"id": "freeze", "type": "key", "span": 1, "label": "Freeze", "n": 3},
    {"id": "rate", "type": "encoder", "span": 1, "label": "Rate", "n": 2, "step": 4},
    {"id": "cutoff", "type": "param", "span": 2, "label": "Cutoff", "paramId": "filter.cutoff", "step": 0.005}
  ]
}
```

## Widgets

### Key

Targets K1, K2 or K3. Pointer input uses a press ledger, so each applied `z = 1` has a matching `z = 0` on pointer release, cancellation, page hide or ownership disconnect cleanup.

### Encoder

Targets E1, E2 or E3. The configured integer step is sent by the minus/plus buttons, mouse wheel or keyboard arrows.

### Parameter

Targets a norns parameter id through `param.set_normalized`. The active script's writable parameter catalog populates browser suggestions, but ids can also be entered manually. Each slider uses a single-inflight applied-value lane: high-rate input converges to the newest desired value without flooding matron. Lua acknowledgements update the displayed formatted value; rejection restores the last applied normalized value.

### Label and spacer

Labels create non-interactive section text. Spacers reserve layout rhythm. Imported text is assigned through `textContent`, never interpreted as HTML.

## Editing

The editor supports:

- add, remove and ordered move up/down;
- widget label, target, step and column-span editing;
- surface naming and one-to-four-column layout;
- automatic persistence after each valid change;
- formatted JSON export;
- clipboard copy and file download;
- exact-script JSON import;
- reset of only the active script's layout.

Reducing the number of columns clamps widget spans to the new layout. Duplicate ids, invalid parameter ids, unsupported types, excessive widget counts and malformed JSON are rejected before storage or rendering.

## Realtime and ownership

The preview subscribes to `script`, `params`, `control` and ownership-aware realtime state. It does not execute Lua from imported JSON. Widgets can only issue the fixed validated command set:

- `control.key`;
- `control.enc`;
- `param.set_normalized`;
- `param.catalog` when the active script has not published a catalog yet.

The first preview command implicitly claims the existing `control` or `params` resource. Competing browser tabs receive a protocol rejection. When the final socket disappears, the server releases held controls immediately and retains only the short reconnect lease.

Editing remains available during a temporary realtime reconnect because the schema is browser-local. Preview controls are disabled until authoritative state is synchronized again.

## Portability

Exported JSON can be copied or downloaded. Profiles are intentionally browser-local rather than written into the script repository: a UI can be changed without modifying community code, and importing remains an explicit user action.

Future schema versions can add Grid/Arc blocks or reusable groups while version `1` remains deterministic and migratable.

## Validation boundary

CI validates schema normalization, widget limits and targets, ordering, layout clamping, exact-script import, storage isolation, parameter filtering, fixed command wiring, press cleanup, safe text rendering and presence of all editor/export controls. Real-device validation should cover touch holds, Wi-Fi loss during a hold, rapid parameter movement, script switching and import/export between two browsers.
