# MLR state and LED contract

## Published state

The Ingenue MLR observer publishes a read-only `mlr` realtime channel:

```text
active
version
view / view_name
focus
alt
quantize
tracks[1..6]
clips[1..7]
patterns[1..4]
recalls[1..4]
```

Each track contains:

```text
play, rec, loop, loop_start, loop_end
clip, pos_grid, speed, reverse, tempo_map
volume, record_level, pre_level
clip_name, clip_length, clip_bpm
```

The observer reads the running script's global state after `script_post_init`. It never changes MLR tables or softcut state. Updates are sent only when a compact signature changes; playhead movement is sampled at 20 Hz.

## LED meanings

The browser renders the ordinary authoritative Grid frame already produced by the Ingenue Grid adapter. It does not reconstruct LEDs from MLR state.

### Navigation row

- active view: 15
- ALT: 9
- quantize: 9
- pattern: recording 15, playing 9, populated 5, empty 3
- recall: recording 15, active 11, populated 5, empty 2

### REC rows

- recording: x1 level 9, otherwise level 3
- focused track markers: x3 and x4 level 7
- tempo map: x5 level 7
- reverse: x8 level 7
- selected speed: x12+speed level 9
- play: x16 level 15

### CUT rows

- selected loop range: level 4
- current playhead: level 15

### CLIP rows

- selected track row: level 4 across all sixteen columns
- assigned clip slot: level 10

## Lifecycle

- On MLR start, the observer sends a full state set.
- On MLR cleanup or script replacement, it sends an inactive empty state.
- Browser controls are disabled whenever realtime is not synced.
- Blur, page hide, visibility loss and socket loss release every pointer, keyboard key and Shift-click loop anchor.
- LED state is cleared through the existing Grid lifecycle adapter during script cleanup.
