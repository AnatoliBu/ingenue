# Browser MIDI and gamepad lifecycle

Browser-owned devices must reach norns through the same Lua-applied runtime as on-screen controls. Hotplug and transport loss are lifecycle transitions, not UI-only status changes.

## MIDI

- Only connected Web MIDI ports are selectable.
- Profiles remain scoped to the exact active norns script and input fingerprint.
- Held mapped keys for K1–K3 are tracked from note-on until their matching note-off.
- Input disconnect, input change, profile change, script change, page hide or realtime loss sends the matching key release before clearing the profile.
- Reconnect rebuilds parameter descriptors and pickup state from norns rather than reusing stale browser metadata.
- Absolute parameter traffic remains one applied command in flight with the newest desired value queued.
- The localhost bridge remains the supported path when ordinary LAN HTTP is not a trustworthy Web MIDI context.

## Physical browser gamepad

- Only the W3C standard gamepad mapping is accepted; unknown layouts are never guessed.
- Buttons map to A/B/X/Y, shoulders, stick buttons, SELECT and START.
- D-pad buttons map to signed X/Y callbacks.
- Standard axes map to left/right sticks; L2/R2 values map to normalized trigger axes.
- Radial stick dead zones and change thresholds suppress drift and transport spam.
- Connection, disconnection, focus loss, page hide and realtime loss neutralize every pressed button, direction, stick and trigger.
- Physical and on-screen gamepad controls share the same `gamepad.button`, `gamepad.dpad` and `gamepad.analog` commands.

## CI contract

Node tests protect standard mapping, dead zones, change-only emission, neutralization and MIDI held-key release. Chromium tests emulate a standard browser gamepad and Web MIDI hotplug, then assert the complete browser → WebSocket → norns fixture command sequence.
