# Ingenue coding-agent instructions

## Target runtime

- Production is monome norns on Raspberry Pi 3, `armv7l` 32-bit, with Python 3.9.2.
- Keep all runtime Python compatible with Python 3.9. CI also parses core server files with Python 3.7 grammar because older norns ports exist.
- Do not introduce runtime-only syntax such as structural pattern matching or `X | Y` type unions.
- `web/vendor/` contains a 64-bit SuperCollider UGen and is not used on the 32-bit production device. Do not make runtime behavior depend on it.
- Lua modules in `web/lib/*.lua` are loaded by matron when norns starts and must preserve cleanup handlers for Grid, Arc, MIDI, gamepad, params, and realtime state.
- Port contract: `7777` HTTP/editor/API, `7778` realtime WebSocket, `5555` matron WebSocket. The Lua state bridge normally uses `7779` on loopback.

## Architecture and authority

- Browser clients send validated realtime commands to Python; Python forwards controller work to matron/Lua over OSC.
- norns/Lua is authoritative for applied controller and parameter state. Do not acknowledge a hardware-facing command as applied before the Lua acknowledgement arrives.
- Preserve physical Grid and Arc devices. Browser controllers may occupy only unused virtual ports and must clean up balanced press/release state.
- The realtime endpoint is open by default for a trusted LAN. `INGENUE_REALTIME_STRICT=1` enables browser-origin checking; keep both modes tested.

## Definition of done

- `npm test` passes, including Node tests and Python unittest discovery.
- New behavior has focused regression coverage.
- CI passes on Python 3.9 and 3.11 with Node 24.
- Keep public repository files free of device credentials, SSH details, private network secrets, and local deployment instructions.
- Hardware verification is performed by the maintainer. Never claim a change works on real norns hardware unless that result was explicitly supplied from a live device test.
