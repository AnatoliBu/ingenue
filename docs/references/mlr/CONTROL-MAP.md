# MLR control map

Coordinates are 1-indexed, matching the norns Grid API. Row 1 is navigation; rows 2–7 are tracks 1–6; row 8 is unused by upstream MLR.

## Audio storage model

All six softcut voices use buffer 1. MLR divides that shared buffer into clip regions. Each track selects one clip region; it does not own a separate audio buffer.

The browser exposes the seven upstream assignable regions as C1–C7 and tracks/voices as T1–T6.

## Global norns controls

- E1 always changes `output_level`.
- The meaning of K2, K3, E2 and E3 depends on the active MLR view.
- K1 is not assigned by MLR itself; norns still reserves it for system navigation outside the script surface.

## Navigation row — y=1

| Grid key | Normal | While ALT (x16 held) |
|---|---|---|
| x1 | REC view | clear the complete softcut buffer, then enter REC |
| x2 | CUT view | CUT view |
| x3 | CLIP view | CLIP view |
| x5–x8 | pattern 1–4: record/start/stop according to state | stop recording, stop playback and clear pattern |
| x9–x12 | recall 1–4: record/stop recording/execute according to state | clear recall |
| x15 press | toggle quantize | enter TIME while held |
| x15 release | no action | return to previous view |
| x16 hold | ALT modifier | — |

## REC view

### Grid rows 2–7

| Coordinate | Action |
|---|---|
| x1 | toggle track recording arm |
| x3–x7 | focus the touched track row |
| ALT + x3–x7 | toggle tempo mapping for the track |
| x8 | toggle reverse |
| x9–x15 | set speed exponent from -3 through +3; x12 is unity |
| x16 | start or stop the track; upstream toggles both softcut play and rec state, while the record level decides whether audio is written |

### norns

- K2 toggles the encoder information page.
- Page A: E2 volume, E3 speed modulation.
- Page B: E2 record level, E3 pre-level/overdub amount.

## CUT view

### Grid rows 2–7

- Press x1–x16 to jump the track to one of sixteen cut positions. A cut also starts a stopped track.
- Hold two positions on the same row and release either one to set an inclusive loop range.
- ALT + any position toggles track start/stop instead of cutting.
- Touching a track row also focuses that track.

### norns

- E2 changes focused-track volume.
- K2, K3 and E3 have no musical action in upstream 2.2.5.

## CLIP view

### Grid rows 2–7

- x1–x7 assigns clip slot 1–7 to the touched track.
- The touched row becomes `clip_sel`, the selected track for clip operations.

### norns

- E2 selects `load`, `clear` or `save`.
- K2 release executes the selected action.
- E3 selects a reset multiplier of 1/2, 1, 2, 4, 8 or 16 beats relative to tempo.
- K3 press resets the selected clip region to the chosen length.
- `load` and `save` enter native norns file/text entry; Ingenue triggers but does not counterfeit those modal workflows.

## TIME view

- E2 changes `clock_tempo`.
- E3 changes `quant_div` from 1–32.
- The Grid remains on the global navigation row until ALT+x15 is released.

## Explicit browser workflow

The browser workflow panel does not add a second MLR API. It composes the exact mappings above:

- assigning Tn → Cn emits CLIP x3, then the selected clip cell on the selected track row;
- Record emits assignment, REC x1 arm and REC x16 start only when required by authoritative state;
- Stop recording toggles REC x1 without forcing playback to stop;
- Cut/play emits CUT x2 and one cut cell;
- Apply loop emits CUT x2 followed by down/down/up/up on the chosen row;
- Load/Clear/Save clamps E2 to `load`, moves to the requested action and releases K2;
- clip reset clamps E3 to 1/2 beat, moves to the requested multiplier and presses K3;
- Clear complete buffer emits ALT down, REC tap, ALT up.
