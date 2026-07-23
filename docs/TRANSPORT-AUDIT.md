# Phase 0 transport audit and benchmark procedure

Tracking issue: #2  
Parent epic: #1

## Purpose

Establish what Ingenue currently guarantees before introducing virtual Grid traffic, MIDI gestures, playheads, meters, or a new realtime state protocol.

This document combines the initial code audit with a repeatable browser-side benchmark procedure. Real latency numbers must be collected on the target norns hardware; repository inspection alone cannot produce them honestly.

## Current transport map

```text
Browser
  ├─ HTTP :7777 ───────────────→ Ingenue Python service
  │                                  └─ UDP OSC :10111 ─→ matron remote handlers
  │
  └─ WebSocket :5555 ──────────→ matron REPL
                                     └─ Lua expressions / params inspection
```

### Browser → Ingenue Python service

The browser uses ordinary HTTP API calls for file management, installs, health checks, updates, and control helpers. `web/server.py` is the always-on service served on port `7777`.

HTTP response success proves that the Python service received and handled the request. It does not necessarily prove that a downstream Lua script applied the requested state.

### Browser → matron WebSocket

The browser opens a direct WebSocket connection to matron on port `5555`. The current application uses this connection for the live REPL and for reading or changing running-script state through Lua expressions, including `params`.

This is a developer REPL transport, not yet a versioned application-state protocol. There is no explicit contract for snapshots, revisions, delta ordering, or resynchronization.

### Ingenue Python service → matron OSC

`web/server.py` sends key, encoder, and parameter controls to matron over local UDP OSC on port `10111`.

The sender is explicitly fire-and-forget:

- no acknowledgement from the script;
- no sequence or command identifier;
- no retry;
- no proof that resulting state reached the browser;
- no delivery distinction between a disposable intermediate fader value and an important discrete command.

The existing `_CTL` diagnostics count requests that reached the Python service. They are useful, but they are not end-to-end acknowledgements.

## Main finding

A global tick rate does not solve the actual problem.

Ingenue currently combines three paths with different guarantees:

1. HTTP request/response to the Python service;
2. direct browser WebSocket to the matron REPL;
3. fire-and-forget local UDP OSC from Python to matron.

The next layer needs an explicit state and command protocol above whichever underlying transports remain.

## Risks confirmed by the architecture

### Split connection ownership

The browser talks both to Ingenue and directly to matron. Connection lifecycle, diagnostics, reconnection, and eventual authorization therefore span more than one channel.

### No end-to-end acknowledgement

A successful HTTP control response can confirm that Ingenue accepted a command and attempted an OSC send. It cannot confirm that the current script applied it.

### Undefined reconnect state

Reconnecting the REPL socket does not define a full state snapshot. The browser may reconnect while retaining stale controls, selected tracks, LEDs, or editor state.

### Continuous-control backlog

A slider or XY pad may generate hundreds of browser events per second. Without coalescing, obsolete intermediate values can consume transport and Lua processing time.

The desired behavior is:

- update the local UI immediately;
- cap network publication rate;
- replace queued intermediate values with the newest value;
- always deliver the final value at gesture end.

### Streaming-state backlog

Grid LEDs, playheads, and meters value freshness more than perfect delivery. Commands such as step edits or preset loads require reliable acknowledgement. Mixing both in one FIFO queue will either lose edits or accumulate stale frames.

## Required delivery classes

### Reliable

Examples:

- transport start/stop;
- step creation/deletion;
- preset load;
- script action;
- final committed parameter value.

Required properties:

- command id;
- acknowledgement or rejection;
- ordered authoritative state revision;
- timeout/error visibility.

### Coalescible

Examples:

- faders;
- knobs;
- XY pads;
- envelope point dragging.

Required properties:

- only the newest pending value matters;
- capped publication rate;
- guaranteed final value;
- no unbounded queue.

### Ephemeral

Examples:

- playhead position;
- VU meters;
- waveform cursor;
- transient Grid LED animation.

Required properties:

- disposable old frames;
- explicit maximum rate;
- newest-frame preference;
- no retransmission backlog.

## Benchmark matrix

Run each test at least three times on:

- wired Ethernet, where available;
- normal Wi-Fi near the router;
- Wi-Fi at the intended performance location;
- idle script;
- representative script while audio and sequencing are active.

Record device model, OS image, script, browser, client device, network mode, and timestamp.

| Test | Metric | Current meaning |
|---|---|---|
| HTTP baseline | RTT to `/api/version` | Browser ↔ Python service only |
| HTTP burst | failures and RTT under concurrency | Python HTTP capacity, not Lua delivery |
| WebSocket connect | time until matron socket opens | Browser ↔ matron connection setup |
| WebSocket reconnect | disconnect detection and recovery | Current lifecycle behavior |
| Control endpoint burst | accepted responses and `_CTL` count | Browser → Python acceptance only |
| CPU/memory observation | load while benchmark runs | Device safety under audio workload |
| End-to-end command | input → Lua acknowledgement | Not measurable until a probe is added |
| State publication | Lua mutation → browser render | Not measurable until state protocol exists |

## Browser benchmark script

Open Ingenue on the target device, open the browser developer console, paste the script below, and run:

```js
await ingenueTransportBenchmark({ samples: 100, concurrency: 8 });
```

The function measures only claims it can prove today: HTTP RTT and matron WebSocket connection setup. It returns a JSON-safe report that can be copied into this document or attached to issue #2.

```js
window.ingenueTransportBenchmark = async function ingenueTransportBenchmark(options = {}) {
  const samples = Math.max(10, Number(options.samples || 100));
  const concurrency = Math.max(1, Math.min(32, Number(options.concurrency || 8)));
  const httpUrl = options.httpUrl || new URL('api/version', location.href).href;
  const wsUrl = options.wsUrl || `ws://${location.hostname}:5555/`;

  const percentile = (sorted, p) => {
    if (!sorted.length) return null;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
    return Number(sorted[index].toFixed(2));
  };

  const summarize = values => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    const mean = sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null;
    return {
      count: sorted.length,
      min_ms: sorted.length ? Number(sorted[0].toFixed(2)) : null,
      mean_ms: mean == null ? null : Number(mean.toFixed(2)),
      p50_ms: percentile(sorted, 0.50),
      p95_ms: percentile(sorted, 0.95),
      p99_ms: percentile(sorted, 0.99),
      max_ms: sorted.length ? Number(sorted[sorted.length - 1].toFixed(2)) : null,
    };
  };

  async function timedFetch() {
    const started = performance.now();
    const response = await fetch(httpUrl, { cache: 'no-store' });
    await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return performance.now() - started;
  }

  async function runPool(total, width, operation) {
    const values = [];
    const errors = [];
    let next = 0;

    async function worker() {
      while (true) {
        const index = next++;
        if (index >= total) return;
        try {
          values.push(await operation(index));
        } catch (error) {
          errors.push(String(error && error.message || error));
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(width, total) }, worker));
    return { values, errors };
  }

  function timedWebSocketConnect(timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const socket = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        try { socket.close(); } catch (_) {}
        reject(new Error(`WebSocket timeout after ${timeoutMs} ms`));
      }, timeoutMs);

      socket.addEventListener('open', () => {
        clearTimeout(timeout);
        const elapsed = performance.now() - started;
        socket.close();
        resolve(elapsed);
      }, { once: true });

      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      }, { once: true });
    });
  }

  const startedAt = new Date().toISOString();
  const serialHttp = await runPool(samples, 1, timedFetch);
  const concurrentHttp = await runPool(samples, concurrency, timedFetch);
  const wsConnect = await runPool(Math.min(samples, 30), 1, () => timedWebSocketConnect());

  const report = {
    benchmark_version: 1,
    started_at: startedAt,
    page: location.href,
    user_agent: navigator.userAgent,
    online: navigator.onLine,
    config: { samples, concurrency, httpUrl, wsUrl },
    http_serial: {
      latency: summarize(serialHttp.values),
      errors: serialHttp.errors,
    },
    http_concurrent: {
      latency: summarize(concurrentHttp.values),
      errors: concurrentHttp.errors,
    },
    websocket_connect: {
      latency: summarize(wsConnect.values),
      errors: wsConnect.errors,
    },
    limits: [
      'HTTP results stop at the Ingenue Python response.',
      'WebSocket results measure connection setup, not command acknowledgement.',
      'This benchmark does not measure audio latency or browser-to-Lua state application.',
    ],
  };

  console.table({
    http_serial_p50_ms: report.http_serial.latency.p50_ms,
    http_serial_p95_ms: report.http_serial.latency.p95_ms,
    http_concurrent_p50_ms: report.http_concurrent.latency.p50_ms,
    http_concurrent_p95_ms: report.http_concurrent.latency.p95_ms,
    websocket_connect_p50_ms: report.websocket_connect.latency.p50_ms,
    websocket_connect_p95_ms: report.websocket_connect.latency.p95_ms,
  });
  console.log(JSON.stringify(report, null, 2));
  return report;
};
```

## Results template

```json
{
  "device": "norns shield / Raspberry Pi model",
  "norns_os": "",
  "script": "",
  "audio_state": "idle | playing | stressed",
  "client": "",
  "browser": "",
  "network": "wired | wifi-near | wifi-performance-location",
  "report": {}
}
```

## Minimum protocol recommendation

Do not replace all existing transports in one step. Add an application-level realtime channel with:

- protocol version;
- client and session id;
- full snapshot on subscription;
- monotonic authoritative revision;
- incremental deltas;
- explicit resync request;
- heartbeat and connection health;
- command ids with acknowledgement/rejection;
- bounded queues;
- separate reliable, coalescible, and ephemeral delivery classes.

Keep the matron REPL as a developer tool rather than treating it as the implicit production state protocol.

## Phase 0 exit criteria requiring hardware

Repository inspection has established the transport shape and its guarantee gaps. Issue #2 should remain open until the following are collected on the real device:

- wired and Wi-Fi benchmark reports;
- CPU and memory impact while audio is active;
- reconnect behavior during a real Wi-Fi interruption;
- evidence of whether rapid control bursts produce stale or dropped state;
- an end-to-end acknowledgement probe that measures browser input → applied Lua state.

The acknowledgement probe is the next code change. It should be developed as one significant block and committed separately after these baseline measurements are understood.