# Browser virtual gamepad

Ingenue exposes a touchscreen/mouse gamepad surface through the native norns `gamepad` callback API. It does not impersonate a USB HID device. The active script and audio remain on norns; the browser sends validated input commands and waits for Lua-applied acknowledgements.

Open:

```text
http://norns.local:7777/gamepad.html
```

## Callbacks

The bridge supports:

- `gamepad.button(name, state)` for A/B/X/Y, shoulders, stick clicks, select and start;
- `gamepad.dpad(axis, sign)` for X/Y directions;
- `gamepad.axis(sensor_axis, sign)` for digitalized d-pad, sticks and triggers;
- `gamepad.analog(sensor_axis, value, half_reso)` for both sticks and analog triggers.

Stick values are normalized in the browser, then reported to Lua using a signed 32767 half-resolution. Triggers use 0–65535. Digital axis transitions follow the norns two-thirds threshold.

## Input safety

Buttons and directions have balanced press/release ledgers. Opposite d-pad directions release the old sign before applying the new sign. Sticks and triggers use one applied value in flight plus one latest desired value, so reconnects converge to the final position rather than replaying an obsolete movement.

All controls return to neutral on pointer cancellation, page hide, window blur, visibility loss and connection loss.

## Compatibility boundary

This is a callback-compatible virtual source, not HID hardware emulation. Scripts which read `gamepad.button`, `gamepad.dpad`, `gamepad.axis` or `gamepad.analog` work without a physical controller. Code which enumerates a particular USB GUID or reads raw HID events remains outside this adapter.
