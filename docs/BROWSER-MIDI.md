# Browser MIDI and the localhost bridge

Ingenue MIDI Learn maps a MIDI controller connected to a computer into Lua-applied norns controls and parameters. MIDI never needs to travel over USB or ALSA on norns: the browser reads the local controller and sends validated realtime commands to the active script.

## Why the LAN page may be blocked

Web MIDI is exposed only to browser contexts the browser considers trustworthy. An ordinary device URL such as:

```text
http://norns.local:7777/midi.html
```

is usually not considered trustworthy, even though it is on a private network. This is a browser security boundary, not a limitation of MIDI itself or Ingenue's realtime transport.

Ingenue does not require converting norns to HTTPS. Instead, run the bundled read-only reverse proxy on the computer connected to the MIDI device. Browsers treat `http://localhost` as a trustworthy local origin.

## One-time setup

1. Open the ordinary Ingenue MIDI page.
2. Download `midi-local.py` from the recovery panel.
3. In a terminal, change to the download folder and run the command shown by Ingenue. For the default norns host:

```sh
python3 midi-local.py --device norns.local --device-port 7777 --realtime-port 7778 --open
```

No Python packages are required. The helper binds only to `127.0.0.1`, opens:

```text
http://localhost:7780/midi.html?device=norns.local&rt=7778&bridge=localhost
```

and proxies read-only UI files from norns. The page's WebSocket still connects directly to `norns.local:7778`, so audio, scripts, params, ownership and Lua acknowledgements remain on the device.

## Non-default addresses

Use an IP address when mDNS is unavailable:

```sh
python3 midi-local.py --device 192.168.1.50 --open
```

Override ports independently:

```sh
python3 midi-local.py \
  --device 192.168.1.50 \
  --device-port 8800 \
  --realtime-port 8801 \
  --local-port 8890 \
  --open
```

The helper rejects schemes, paths, credentials and embedded ports in `--device`; use the dedicated port arguments.

## Security boundary

The localhost helper:

- listens only on `127.0.0.1`;
- accepts only GET and HEAD for proxied Ingenue files;
- strips hop-by-hop headers;
- does not proxy POST, PUT or DELETE;
- does not terminate or relay the realtime WebSocket;
- exposes a local health endpoint at `/__ingenue_midi_bridge__/health`;
- forwards no browser cookies, authorization headers or request body.

This creates a trustworthy local browser origin. It is not an authentication layer for the norns realtime port. Keep Ingenue on a trusted network or enable its strict-origin mode.

When `INGENUE_REALTIME_STRICT=1` is enabled on norns, explicitly allow the local bridge origin before restarting Ingenue:

```sh
INGENUE_REALTIME_STRICT=1 \
INGENUE_REALTIME_ORIGINS=http://localhost:7780
```

Use the actual `--local-port` value when it differs from `7780`. The origin list is exact, so `127.0.0.1` and `localhost` are separate entries if both are used.

## Browser support

When the localhost page opens, press **Grant MIDI permission**, select the input and use Learn. If the page reports that Web MIDI is unsupported rather than insecure, use a desktop browser that exposes `navigator.requestMIDIAccess`; the helper cannot add a missing browser API.

## Profiles and ownership

Mappings remain scoped to the exact active script and MIDI device fingerprint in browser storage. Parameter commands use normalized Lua-applied control, and the MIDI tab participates in the same `params` / `control` ownership leases as every other Ingenue surface.

## Validation

CI starts a real loopback upstream server and the localhost bridge, follows the launch redirect, verifies static proxying and health data, blocks write methods, validates host parsing, checks direct realtime host selection, and parses the helper with Python 3.7 grammar.
