# Reference systems for Ingenue

Ingenue is not designing a browser control stack in isolation. The compatibility and product references below are mandatory study material for implementation, review, testing and hardware acceptance.

## norns and matron

Primary references:

- `monome/norns`
- matron and the Lua-facing norns libraries
- current norns release and migration notes

Study these areas:

- script load, cleanup, restart and failure lifecycle;
- key and encoder ingestion;
- Grid, Arc, MIDI, HID and gamepad routing;
- vport discovery, attachment, removal and reassignment;
- screen redraw ownership;
- Lua evaluation and callback dispatch;
- error propagation and runtime logging;
- restart behaviour across current and historical norns architectures.

Engineering rules derived from this reference:

- norns remains authoritative for script and controller state;
- browser commands are acknowledged only after Lua-side application;
- press and release events must remain balanced across disconnects;
- reconnect and script switching are lifecycle transitions, not merely transport events;
- internal matron symbols and historical service names are reference material, not a stable extension API.

## Maiden and the native norns browser experience

Primary references:

- `monome/maiden`
- official Maiden documentation;
- a live norns web interface at `http://norns.local:7777/`.

Study these areas:

- embedded HTTP serving;
- browser-to-norns WebSocket transport;
- Lua and SuperCollider REPL behaviour;
- reconnect after runtime restart;
- log streaming and readable error presentation;
- loading, disconnected, stale and failed states;
- navigation, panel structure, keyboard workflows and responsive behaviour;
- conservative use of browser capabilities on a local HTTP appliance.

Engineering rules derived from this reference:

- failures must be visible in the page and browser console;
- reconnect must restore a coherent authoritative snapshot;
- the endpoint and connection state must be inspectable;
- local-network operation must remain useful without a cloud dependency;
- localhost helpers must preserve the actual norns realtime target across navigation.

## Current Ingenue UI on port 7777

The current Ingenue interface served from `http://norns.local:7777/` is itself a visual and interaction reference. New pages should extend this language before proposing a redesign.

Preserve:

- near-black page backgrounds and slightly raised dark panels;
- thin muted green borders;
- bright lime only for primary and active actions;
- compact uppercase or monospace headings;
- restrained status chips and notices;
- large touch-safe targets;
- dense but readable layouts;
- the feeling of a musical instrument rather than a generic admin dashboard.

Avoid:

- unrelated component-library styling;
- decorative gradients and excessive animation;
- tiny controls that only work with a mouse;
- hiding transport, ownership or ACK state;
- page-specific visual systems that fragment the application.

## Reference-to-test contract

| Area | Primary reference | Required protection |
| --- | --- | --- |
| Script lifecycle | matron / norns runtime | load, cleanup, restart and script-switch tests |
| K1-K3 and E1-E3 | matron input path | press/release and encoder-delta browser E2E |
| Grid and Arc | norns Lua libraries and vports | configuration, feedback, reconnect and release tests |
| MIDI, HID and gamepad | norns device libraries | routing, ownership, hotplug and neutral-state tests |
| Logs and errors | Maiden REPL and console | ACK, reject, timeout and reconnect diagnostics |
| Embedded web routing | Maiden and native norns web | origin, proxy, navigation and WebSocket endpoint tests |
| Visual language | current Ingenue `:7777` UI | shared tokens, responsive checks and visual regression |

## Hardware acceptance boundary

Browser fixtures and CI can validate public protocol behaviour, UI event handling, routing, ownership, ACK semantics and reconnect logic. They cannot prove the exact installed norns runtime, system services, audio timing, USB behaviour or script-specific performance. Real Shield acceptance is still required after CI passes.
