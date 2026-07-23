# Web MIDI bridge and MIDI Learn

Tracking: #5

`/midi.html` owns browser-side Web MIDI permission, device enumeration, learning and local profiles. Profiles are keyed by the exact active norns script name and a fingerprint containing the input manufacturer, name and browser port id. A profile never activates silently for another script or input.

## Secure-context requirement

Web MIDI is a secure-context API. Plain LAN HTTP such as `http://norns.local:7777` may not expose `navigator.requestMIDIAccess`. Ingenue reports this explicitly. Use an HTTPS reverse proxy (and add its exact origin to `INGENUE_REALTIME_ORIGINS`) or a trustworthy localhost context.

## Applied parameter path

The browser never guesses norns parameter ranges or warps:

1. `param.describe` asks Lua for authoritative type, raw-normalized value, range, formatted value and writability.
2. Absolute CC / pitch bend uses `param.set_normalized`; Lua calls `set_raw` for CONTROL/TAPER and discrete mapping for NUMBER/OPTION/BINARY.
3. Relative CC uses `param.delta` and the normal `params:delta` implementation.
4. Lua returns the resulting descriptor inside the applied ACK.

`ControlSpec.DB` and other non-finite display ranges are represented with textual min/max metadata while normalized 0–1 remains finite.

## Ownership and safety

- absolute mappings use soft takeover by default;
- one absolute command is in flight per mapping and only the latest desired value is retained;
- uncertain absolute commands are safely replayed after reconnect;
- key mappings deduplicate held/released gates;
- script or input changes deactivate the whole runtime before loading another exact profile;
- corrupt saved rows and unsupported parameter profiles fail closed.

Sysex and software-synth privileges are not requested. Output ports are enumerated for future feedback support but this slice does not send feedback yet.
