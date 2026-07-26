# Ingenue quality contract

Milestone 5 turns visual consistency, accessibility, responsiveness and runtime stability into repeatable browser contracts. These checks complement the functional browser ↔ norns suite; they do not replace real norns Shield acceptance.

## Shared budgets

| Contract | Budget |
|---|---:|
| Normal desktop control target | at least 36 × 36 px |
| Normal phone control target | at least 44 × 44 px |
| Normal text contrast | at least 4.5:1 |
| Animation-frame cadence p95 | at most 50 ms |
| Animation-frame cadence maximum | at most 150 ms |
| Safe `system.ping` ACK latency p95 | at most 250 ms |
| Safe `system.ping` ACK latency maximum | at most 750 ms |
| Automated reconnect soak | 8 cycles |

The budgets intentionally leave headroom for a Raspberry Pi 3B+ norns Shield and ordinary Wi-Fi instead of tuning only for a fast desktop fixture.

## Compact instrument controls

Grid cells, MLR pads, Launchpad pads, Arc LEDs and range/checkbox/radio controls are exempt from the ordinary 36/44 px rectangle rule. Their usability comes from the whole instrument surface, spacing, drag/multitouch support and balanced release semantics. Enlarging each 16×16 or 16×8 cell to 44 px would make the instrument unusable on phones.

The exemption is narrow. Ordinary buttons, links, text fields, selectors, diagnostics controls and Builder actions still have to meet the target-size contract.

## Accessibility

Every public surface is checked for:

- a programmatic name on visible buttons, links, fields and custom button roles;
- visible keyboard focus with a two-pixel accent outline;
- normal text token contrast of at least 4.5:1;
- no unintended horizontal document overflow at desktop, tablet and phone widths;
- reduced-motion behavior that collapses animation and transition duration;
- touch-safe navigation and ordinary controls.

These checks are browser-level invariants. They are not a complete manual screen-reader audit, but they prevent the most common regressions from entering `main` unnoticed.

## Timing and stability

The fixture measures two distinct paths:

1. `requestAnimationFrame` cadence on a representative performance surface.
2. Twelve sequential `system.ping` commands settled by the real browser session, RFC 6455 fixture and ACK broker.

The reconnect soak destroys the active socket eight times and requires:

- authoritative `synced` recovery after every cycle;
- one browser runtime session rather than duplicated sessions/listeners;
- one active fixture client after recovery;
- bounded runtime event logs;
- empty outbound queue, pending command map and in-flight set;
- stable shell/diagnostics DOM counts.

These are deterministic leak proxies. JavaScript heap measurements are deliberately not used as a blocking CI gate because browser GC timing is nondeterministic.

## Visual baselines

Stable screenshots cover representative instrument and construction surfaces at desktop, tablet and phone widths. Screenshots run in dark mode with reduced motion and disabled animations.

A baseline update is acceptable only when the visual change is intentional and reviewed. Functional test failures must never be hidden by blindly regenerating screenshots. The checked-in Linux Chromium visual signatures are the CI source of truth. Each signature hashes a quantized 48×48 grid of decoded screenshot pixels, so harmless PNG compression and one-pixel antialias noise do not invalidate the baseline. On mismatch Playwright writes the actual PNG into the failing test artifact so the visual change can be reviewed before updating the signature.

## Evidence boundary

CI can certify DOM, routing, typed commands, reconnect behavior, authoritative fixture state, timing budgets and visual layout. It cannot certify audible softcut timing, USB hotplug, a physical Grid/Arc, actual MIDI hardware, native norns file/text dialogs or pset persistence. Those remain in `SHIELD-ACCEPTANCE.md`.
