# Virtual Arc controller

Tracking: native-controller delivery order in `CONTROLLER-COMPATIBILITY.md`.

Ingenue exposes a browser-hosted monome Arc-compatible surface at `/performance.html`. The browser is only an input and display device: the active norns script, params, engine and audio remain on norns.

## Device contract

The Lua mod attaches a four-ring virtual Arc to empty Arc vport 1. It uses the normal `arc.connect()` vport callbacks and mirrors the standard Arc output methods:

- `delta(n, delta)` and Arc 2025-style `key(n, z)` input;
- 64 LEDs per ring, 16 brightness levels;
- `led`, `all`, `segment`, `intensity` and `refresh` output;
- full authoritative frame after script init and reconnect;
- ports 1–4 in the realtime state schema.

A physical Arc remains authoritative. Output is still forwarded to the original vport methods, and a physical device replacing the virtual vport is not overwritten.

## Browser interaction

- drag around a ring for high-resolution rotation;
- mouse wheel sends coarse ±4 deltas;
- Left/Right arrows send ±1, Shift+Left/Right sends ±8;
- center A1–A4 buttons send balanced press/release events;
- rings render only Lua-published LED frames, never optimistic browser state;
- the 2-ring/4-ring selector changes presentation only and does not fabricate device output.

## Transport

Arc commands are validated by Python, assigned a server wire id, sent to matron on `/ingenue/control-command`, executed by Lua, and acknowledged only after the script callback returns. Arc LED frames return on `/ingenue/arc/frame` and are published through the authoritative `arc` protocol channel.

## Activation

The installer enables the Ingenue mod automatically. A newly installed mod needs one norns/matron restart. After restart, open:

```text
http://norns.local:7777/performance.html
```

## Current limitations

- CI validates the protocol, frame encoding, gesture math and Lua wiring but cannot execute a real matron runtime.
- Compatibility with individual Arc scripts still needs the device matrix: arcify, mangl, easygrain, ndls, cheat_codes_2, gridofpoints and pedalboard.
- Browser touch cannot reproduce the physical inertia and tactile detents of an Arc; emitted deltas remain deterministic and high resolution.
