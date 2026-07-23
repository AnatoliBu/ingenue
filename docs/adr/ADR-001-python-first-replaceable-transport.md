# ADR-001: Python-first, replaceable realtime transport

- Status: accepted
- Date: 2026-07-23
- Issues: #1, #2, #3

## Context

Ingenue already runs a Python service for HTTP, files, installation, health checks and OSC dispatch. The realtime roadmap adds subscriptions, snapshots, command acknowledgements, Grid traffic and browser controls. Rust may eventually offer lower overhead, while TypeScript could reduce language count, but there is no measured evidence that the Python service is currently the bottleneck.

Audio timing remains owned by matron/Lua and SuperCollider. The browser service must never become the audio clock or sequencer authority.

## Decision

1. Keep Python as the first implementation of the control-plane and realtime gateway.
2. Define the browser-facing realtime protocol independently of Python classes and implementation details.
3. Keep audio timing, sequencing and DSP off the Python process.
4. Require bounded queues and separate reliable, coalescible and ephemeral delivery classes.
5. Measure browser-to-Lua and full HTTP-to-OSC round trips on target hardware before considering a rewrite.
6. Permit a later Rust gateway behind the same protocol if profiling proves that Python misses agreed latency, CPU, memory or queue-growth budgets.
7. Do not migrate to TypeScript merely to share a language with the browser; it must demonstrate a concrete operational or performance benefit.

## Consequences

- The project reaches a testable MVP faster by extending the existing service.
- Browser controls and Lua adapters remain insulated from a future runtime migration.
- Performance decisions are driven by hardware measurements rather than assumptions.
- A future Rust component should replace only the proven hot path; Python may continue to own installation, files, health and repository operations.

## Initial investigation thresholds

These values trigger profiling, not an automatic rewrite:

- reliable command loss: any value above zero;
- sustained queue growth: any unbounded growth;
- OSC control round-trip p95 above 60 ms on a healthy local network;
- Ingenue transport CPU above 25% of one core during representative 30 Hz Grid traffic;
- reconnect plus authoritative snapshot taking several seconds or producing stale UI.

Thresholds will be revised after Phase 0 hardware results.
