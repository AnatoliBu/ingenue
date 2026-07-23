# Web MIDI Learn

`/midi.html` owns Web MIDI permission, device enumeration, learn state and browser-local profiles. It never opens SysEx access.

Profiles are keyed by the exact active `norns.state.name` and the selected MIDI input fingerprint. A script or device change deactivates the prior runtime before loading another profile.

## Device authority

The browser does not guess Norns parameter ranges. It requests `param.describe` from Lua and uses the returned normalized value for pickup. `CONTROL` and `TAPER` use their native raw 0–1 API; `NUMBER` and `OPTION` are rounded to device-side discrete values; non-trigger binary params use a threshold. Trigger params reject absolute mapping.

Commands:

- `param.describe`
- `param.set_normalized`
- `param.delta`

Every mutation remains Lua-applied and returns the resulting parameter descriptor in `ack.result.param`. Infinite dB metadata is represented as nullable numeric fields plus exact text fields; the normalized raw value remains finite.

## Web platform constraint

Web MIDI is a secure-context API. Direct HTTP device pages may not expose it. In that case the UI reports the insecure-origin state rather than pretending there are no devices. Serve the frontend through HTTPS or a trustworthy localhost origin and add that exact origin to `INGENUE_REALTIME_ORIGINS` when needed.

## Ownership

Absolute mappings use soft takeover. After pickup, the browser owns the target until the script, device or profile changes. Relative mappings call `params:delta`, preserving each Norns parameter's native delta semantics.
