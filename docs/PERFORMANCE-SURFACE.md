# Performance surface

`/performance.html` is the user-facing realtime control screen. It connects to protocol v1 and subscribes to the authoritative `device`, `control`, `script`, and `grid` channels.

## Interaction rules

- Grid LED state is rendered only from Lua-published frames. Key presses never paint optimistic LEDs.
- K1–K3 and Grid cells use balanced press/release ledgers. All held controls are released on cancellation, page hide, or connection loss.
- E1–E3 support vertical drag, wheel, and explicit ±1 buttons.
- The parameter lane permits one applied command in flight and stores only the newest desired value while waiting for Lua acknowledgement.
- Controls remain disabled until an authoritative snapshot is synchronized.

The engineering page remains available at `/realtime-inspector.html`.
