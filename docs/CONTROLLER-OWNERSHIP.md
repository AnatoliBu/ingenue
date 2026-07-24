# Browser controller ownership

Ingenue treats browser controllers as real input devices. Two unrelated browser sessions must not drive the same norns callback stream at the same time, and a dropped Wi-Fi connection must not leave a key, Grid cell, Arc key, D-pad or analog axis held forever.

## Stable browser identity

`RealtimeSession` stores a random `client_id` in browser `sessionStorage` and sends it in every protocol `hello`. The value survives reloads and automatic WebSocket reconnects in the same tab, but normal independent tabs receive separate identities.

Clients which do not send `client_id` remain compatible. The server assigns them a connection-scoped legacy identity, so they receive safety cleanup but cannot reclaim a lease after reconnect.

## Resources

Ownership is independent for:

- `control` — K1–K3 and E1–E3;
- `params` — direct, normalized, delta, trigger and catalog parameter commands;
- `gamepad` — buttons, D-pad and analog axes;
- `grid:1` through `grid:4`;
- `arc:1` through `arc:4`.

The first valid command implicitly claims its resource. Another `client_id` receives a protocol `reject` until the current owner releases the resource or its reconnect lease expires. A single browser may own several resources, and different browsers may safely own different Grid or Arc ports.

Clients may also issue explicit control-plane commands:

```json
{"target":"session","action":"claim","args":{"resource":"grid:1"}}
{"target":"session","action":"release","args":{"resource":"grid:1"}}
{"target":"session","action":"release_all","args":{}}
```

These commands are settled by Python because they change transport ownership, not matron state. Hardware, parameter and controller commands remain Lua-applied.

## Disconnect safety

The server records stateful input only after Lua acknowledges that it was applied. When the final socket for a `client_id` disappears, Ingenue immediately dispatches balanced release commands for every recorded input:

- control, Grid, Arc and gamepad buttons receive `z = 0`;
- D-pad axes receive `sign = 0`;
- analog axes receive `value = 0`.

The synthetic release uses the same validated adapter and Lua dispatcher as browser input. Its acknowledgement has no browser waiter and is intentionally ignored.

## Reconnect lease

Resource ownership is retained for five seconds after the final socket disconnects. During this grace period:

- the same `client_id` may reconnect and resume ownership;
- unrelated clients are rejected;
- all held input has already been released, so the grace period cannot sustain a stuck note or button.

If the owner does not return, the state bridge expires the lease and publishes an authoritative ownership delete. The `ownership` realtime channel exposes active and reconnecting resources and the configured grace period.

## Revision semantics

Ownership changes increment the same global realtime revision as device state. Peers which do not subscribe to `ownership` receive an empty delta at that revision, preserving ordered revision continuity without exposing unwanted channel data.

## Validation boundary

CI covers competing clients, reconnect reclaim, lease expiry, multi-socket identities, applied-input tracking, synthetic release dispatch, ownership snapshots, browser identity persistence and Python 3.7 grammar. Real-device checks should still include abruptly closing a phone or laptop while holding each supported control type.
