# Virtual Grid v1

Tracking: #6

The Ingenue Lua mod mirrors Grid vport 1 without replacing a connected physical Grid.

## Output path

The mod wraps the existing vport `led`, `all`, and `refresh` methods. Original methods are called first, so physical hardware behavior is preserved. On `refresh`, the latest 0–15 LED frame is encoded as one hexadecimal character per cell and sent to the localhost Python bridge.

Default virtual dimensions are 16×8 when no physical device occupies vport 1. If physical Grid 1 is connected, its actual dimensions are mirrored instead.

## Input path

Browser presses use `grid.key` protocol commands. After validation, the Lua adapter calls the current `grid.vports[port].key(x, y, z)` callback and acknowledges only after it returns.

This first version intentionally targets the normal `grid.connect(port)` vport API. Scripts which bypass vports and attach callbacks directly to an opaque physical device are not virtualized yet.

## Lifecycle

The wrapper is installed once at `system_post_startup`. Core `grid.cleanup()` still clears script callbacks and LEDs normally; because the original methods remain in the call chain, physical Grid cleanup is unchanged and the cleared frame is mirrored to the browser.

## Performance surface

Open `/performance.html` to use:

- a responsive 16×8 Grid;
- K1–K3 press/release input;
- E1–E3 vertical drag and mouse-wheel input;
- applied command log;
- adapter install/enable/online state.
