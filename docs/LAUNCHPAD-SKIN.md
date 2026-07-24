# Launchpad / Midigrid browser skin

Ingenue's Launchpad page is a browser presentation for the existing authoritative Grid bridge. It does not emulate a particular Launchpad MIDI protocol and does not add a second device inside norns.

Open:

```text
http://norns.local:7777/launchpad.html
```

## Matrix

The center 8×8 matrix sends ordinary `grid.key(x, y, z)` commands to the selected norns Grid vport. LED levels come only from the latest Grid frame published by Lua. A browser press changes the physical appearance of the pad while held, but never fabricates an LED state.

## Page rails

The top rail selects an eight-column page and the right rail selects an eight-row page. This exposes:

- one page for 8×8;
- two horizontal pages for 16×8;
- four page combinations for 16×16;
- up to four pages per axis for larger physical Grids accepted by the realtime protocol.

The rails are browser navigation controls. They are not sent to norns and are not presented as authoritative Grid LEDs.

## Coordinate transforms

The browser can rotate the current 8×8 page by quarter turns and independently flip X or Y. Transforms are applied locally before the selected page offset is added. They are useful when matching the physical orientation or coordinate convention of a MIDI pad controller.

## Input safety

Pointer input is tracked at matrix level, which supports multi-touch and sliding between pads. Moving to a new pad sends release for the old coordinate before press for the new coordinate. All held pads are released on page changes, transform changes, port changes, visibility loss and reconnect.

## Compatibility boundary

The guaranteed output is monochrome 16-level varibrightness, matching the norns Grid contract. Browser styling may use a color accent, but no RGB data is claimed or sent unless a future opt-in adapter defines an RGB protocol.
