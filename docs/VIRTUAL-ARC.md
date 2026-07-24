# Configurable virtual Arc controller

Tracking: native-controller delivery order in `CONTROLLER-COMPATIBILITY.md`.

Ingenue exposes a browser-hosted monome Arc-compatible surface at `/performance.html`. The browser is only an input and display device: the active norns script, params, engine and audio remain on norns.

## Device profile

The virtual Arc profile stores:

- Arc vport 1–4;
- a native 2-ring or 4-ring device shape.

The profile is persisted in `dust/code/ingenue/data/virtual-arc-config` and loaded before each script initializes. Changing the profile uses the Lua-applied `arc.configure` command; success is acknowledged only after Lua has persisted and attached the device.

Ingenue refuses to move the virtual Arc onto a vport occupied by a physical device. If a physical Arc appears on the configured vport it remains authoritative. When a virtual or physical device disappears, Lua publishes `/ingenue/arc/disconnect`, and the realtime server deletes that port from authoritative snapshots instead of retaining stale LEDs after reconnect.

## Native contract

The adapter uses the normal `arc.connect()` vport callbacks and mirrors the standard Arc methods:

- `delta(n, delta)` and Arc 2025-style `key(n, z)` input;
- 64 LEDs per ring, 16 brightness levels;
- `led`, `all`, `segment`, `intensity` and `refresh` output;
- full authoritative frame after script init, device reconciliation and reconnect;
- ports 1–4 in the realtime state schema.

A physical Arc remains authoritative. Output is forwarded to the original vport methods, and a physical device is never overwritten by the browser device.

## Browser interaction

- drag around a ring for high-resolution rotation;
- mouse wheel sends coarse ±4 deltas;
- Left/Right arrows send ±1, Shift+Left/Right sends ±8;
- center A1–A4 buttons send balanced press/release events;
- rings render only Lua-published LED frames, never optimistic browser state;
- the display selector can show two or four rings without changing the configured device profile.

## Transport and cleanup

Arc commands are validated by Python, assigned a server wire id, sent to matron on `/ingenue/control-command`, executed by Lua, and acknowledged only after the script callback returns. Arc LED frames return on `/ingenue/arc/frame` and are published through the authoritative `arc` protocol channel.

On script cleanup, every known Arc frame is zeroed and republished. This prevents the browser from showing the previous script's LEDs while the next script is loading.

## Activation

The installer enables the Ingenue mod automatically. A newly installed mod needs one norns/matron restart. After restart, open:

```text
http://norns.local:7777/performance.html
```

## Validation boundary

CI validates profile normalization, OSC dispatch, stale-port deletion, frame encoding, gesture math, Lua wiring and Python 3.7 grammar. Real-device validation remains required against arcify, mangl, easygrain, ndls, cheat_codes_2, gridofpoints and pedalboard.
