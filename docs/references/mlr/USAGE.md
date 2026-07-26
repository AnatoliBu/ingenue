# Using MLR from Ingenue

The browser surface has two layers:

1. **MLR workflow** — explicit track, clip, record, transport, cut, loop and clip-management controls.
2. **Raw 16×8 Grid + K/E** — exact access to the original MLR 2.2.5 interface.

Both layers send the same ordinary Grid/K/E callbacks. MLR and softcut remain authoritative.

## Buffer and clip model

MLR does not give every track a separate audio buffer. All six softcut voices use buffer 1. Clip slots are regions inside that shared buffer. A track points at one clip region at a time.

Ingenue exposes the seven upstream clip slots as C1–C7 and the six voices as T1–T6.

## Record a loop

1. Choose a track and clip region.
2. Press **Record into selected clip**. Ingenue enters CLIP, assigns the region, enters REC, arms recording and starts the track when needed.
3. Feed audio into the norns input.
4. Press **Stop recording** to stop writing while leaving playback running.
5. Choose loop start/end and press **Apply loop**, or Shift-click two cells on the same CUT row.
6. Use **Cut / play** to jump to one of sixteen positions. A cut starts a stopped track, matching upstream MLR.

## Play and stop

**Start track / Stop track** uses REC column 16. A CUT action also starts a stopped track and jumps to the chosen position.

## Load, clear and save a clip

Choose a track and clip, select `Load`, `Clear selected clip` or `Save`, then press **Execute action**.

- Load and Save open the native norns file/text modal. Continue on the norns screen.
- Clear affects only the selected clip region.
- Clear complete buffer reproduces upstream ALT+REC and destroys every clip region.

## Reset clip length

The upstream multipliers are ½, 1, 2, 4, 8 and 16 beats. Ingenue deterministically clamps E3 to the first value before selecting the requested multiplier and pressing K3.

## Rejections

The workflow status shows the command name, machine-readable error code and server message. Common causes are another browser owning the Grid, stale runtime context, an inactive MLR script, or a Grid vport without the MLR key callback.
