# Ingenue testing strategy

Ingenue treats the browser, realtime server, Lua adapter and norns script as one control path. A green unit suite is not enough: routing, browser security rules, pointer lifecycles and WebSocket behaviour must also be exercised in a real browser.

The implementation and acceptance references behind this strategy are documented in [`REFERENCE-SYSTEMS.md`](./REFERENCE-SYSTEMS.md).

## Fast unit and protocol contracts

Run:

```bash
npm test
```

This layer covers browser-independent controller logic, schemas, queues, protocol reducers, realtime hubs, ownership, applied acknowledgements, localhost bridge behaviour and OSC/Lua command adaptation. CI runs the Python portion against supported Python versions.

## Chromium browser-to-norns contract

Run:

```bash
npm install
npx playwright install chromium
npm run test:browser
```

The browser harness starts:

1. a static Ingenue HTTP server;
2. a minimal RFC 6455 norns realtime fixture;
3. the production localhost bridge;
4. headless Chromium through Playwright.

The fixture publishes authoritative script, Grid, Arc and parameter snapshots. It records browser commands and returns Lua-style applied ACK or reject responses. It also implements ownership, heartbeat and forced disconnects.

The browser suite must cover:

- every shipped page booting without an uncaught exception;
- every realtime page reaching an authoritative `synced` state;
- localhost navigation preserving `device`, `rt` and `bridge` parameters;
- proxied pages connecting to the configured norns endpoint rather than an inferred localhost port;
- K1-K3 press/release and E1-E3 deltas;
- Grid press/release, configuration and feedback;
- Arc key/delta, configuration and feedback;
- parameter ACK, reject and matron-timeout reporting;
- reconnect and re-subscription after abrupt socket loss;
- release of held controls during page lifecycle transitions;
- gamepad buttons, d-pad, sticks and triggers;
- cross-browser resource ownership and rejection;
- Browser MIDI permission, learn, profile activation and normalized parameter commands;
- per-script UI Builder persistence, import/export and live preview commands;
- centralized `[ingenue realtime]` diagnostics;
- absence of unexpected page errors and failed first-party requests.

## Transport diagnostics on a real Shield

After CI passes and the branch is installed on norns, open:

```text
http://norns.local:7777/transport-diagnostics.html
```

Run the default 100-sample test while idle, then repeat while a representative script is playing. Record the device, browser, network mode, active script and JSON report.

## Failure artifacts

The Chromium CI job should retain on failure:

- console and runner output;
- Playwright HTML report;
- trace archives;
- screenshots;
- retained failure video.

Open a trace locally with:

```bash
npx playwright show-trace test-results/<test>/trace.zip
```

## Hardware acceptance boundary

The browser fixture validates the public browser-to-realtime contract and Lua-applied response semantics. It cannot prove electrical USB behaviour, serialosc, ALSA, audio timing, exact installed norns runtime behaviour or script-specific performance. Real Shield acceptance remains required for installation, system services, actual Lua callbacks, CPU and memory load, network stability and audio continuity.
