# Real norns Shield acceptance matrix

This matrix is the final physical-hardware gate for Ingenue on the Raspberry Pi 3B+ norns Shield. Browser fixtures are intentionally unable to mark these rows as passed.

Record the norns OS version, Ingenue commit, browser/version, network mode, running script and connected hardware for every session. Preserve diagnostics JSON, screenshots or short videos for failures.

## 1. Installation and service lifecycle

- Install or update Ingenue from the documented path.
- Reboot the Shield and confirm `http://norns.local:7777/` returns without manually starting a process.
- Confirm Maiden remains available independently.
- Load, stop, change and crash a script; verify Ingenue follows matron lifecycle without stale controls.
- Leave the browser disconnected long enough to cross the reconnect lease, then reconnect and verify clean ownership.

## 2. Browser and realtime transport

- Test direct LAN access and the localhost Browser MIDI bridge route.
- Confirm the bridge preserves the Shield realtime target on every internal navigation.
- Run transport diagnostics idle and while a demanding script is playing.
- Verify reconnect after Wi-Fi interruption, browser sleep/wake and Shield service restart.
- Confirm diagnostics show ACK, reject, timeout and reconnect events accurately.

## 3. K/E and parameters

- Hold and release K1–K3 with pointer and keyboard input.
- Lose focus, hide the page and disconnect Wi-Fi during each hold; no key may remain down.
- Exercise E1–E3 by drag, wheel, plus/minus and keyboard arrows.
- Move continuous, option, binary, trigger, taper and wide-range parameters.
- Verify displayed formatted values match the norns screen and parameter menu.
- Reject or interrupt an edit and confirm the browser returns to the last Lua-applied value.

## 4. Grid and Arc coexistence

- Connect a physical Grid while a browser virtual Grid occupies another vport.
- Repeat with reconnect, script reload, rotation, intensity and 8×8/16×8/16×16 profiles.
- Verify multitouch slide and simultaneous holds from phone/tablet.
- Disconnect the browser during a hold and confirm the script receives releases.
- Connect a physical Arc while browser Arc uses another vport.
- Verify two- and four-ring layouts, delta direction, Arc keys, 64-LED feedback and intensity.
- Confirm browser devices do not replace or renumber physical devices unexpectedly.

## 5. Browser MIDI and USB MIDI

- Test note, CC, pitch-bend and relative encoder mappings with real hardware.
- Unplug/replug the controller, switch inputs, switch scripts and change profiles while a note is held.
- Confirm every held K mapping is released and parameter pickup is rebuilt from norns state.
- Test the localhost bridge on ordinary LAN HTTP and direct Web MIDI where the browser permits it.
- Verify MIDI output/feedback where supported by the selected profile.

## 6. Physical browser gamepad

- Test a controller that reports the W3C `standard` mapping.
- Verify face/shoulder/stick buttons, SELECT/START, d-pad, sticks and triggers.
- Check dead-zone behavior with hands off the sticks.
- Disconnect, sleep or blur the browser while controls are active; all values must return to neutral.
- Confirm unknown/non-standard mappings are rejected rather than guessed.

## 7. MLR 2.2.5

Use the pinned `tehn/mlr` reference documented under `docs/references/mlr/`.

- Load seven representative samples and verify clip names/lengths.
- Exercise all six tracks in REC, CUT, CLIP and TIME views.
- Verify one-point cuts, two-point loops, reverse, speed, tempo-map and play/stop.
- Record and overdub through softcut; listen for clicks, dropped audio and timing drift.
- Record/start/stop/clear all four patterns.
- Record/execute/clear all four recalls.
- Toggle quantization and confirm musical timing against the norns clock.
- Compare browser Grid LEDs, loop regions, playheads and track state with physical Grid behavior.
- Interrupt Wi-Fi during ALT, a two-key loop chord, recording and pattern capture; verify balanced recovery.

CI verifies commands and observer state only. Audible timing and softcut correctness must be judged here.

## 8. Builder v2

- Confirm automatic migration of an existing v1 layout.
- Build and save K/E/parameter/Grid/Arc/MIDI/gamepad widgets.
- Verify authoritative Grid/Arc feedback and every lifecycle release path.
- Save/load/delete named presets and switch between several scripts.
- Publish optional script metadata, then verify local edit override and reset-to-metadata behavior.
- Export on one browser and import on another; cross-script imports must be rejected.
- Test desktop, tablet and phone layouts with touch interaction.

## 9. Native norns behavior

- Exercise script file selection and text-entry dialogs initiated through normal script controls.
- Save, load and delete psets; reboot and verify expected persistence.
- Confirm Ingenue never bypasses native modal ownership or executes imported arbitrary Lua.
- Check screen redraw and menu operation while browser controls are active.

## 10. Sixty-minute soak

Run a representative audio script for at least 60 minutes while repeatedly using browser controls.

- Perform at least 20 disconnect/reconnect cycles.
- Switch pages and scripts repeatedly.
- Keep diagnostics available and check that logs remain bounded.
- Watch CPU, memory, audio dropouts and UI responsiveness.
- End with all controls neutral, one active browser session and no abandoned ownership.

## Acceptance rule

The software/CI milestones may be considered complete while this matrix is pending, but the project must not be described as fully validated on Shield until every applicable row has evidence from the physical device. Any failure discovered here receives a deterministic fixture regression test before its fix is merged.
