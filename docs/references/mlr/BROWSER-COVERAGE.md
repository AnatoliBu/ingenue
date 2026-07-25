# MLR browser coverage

| MLR function | Browser input | Authority | Automated coverage |
|---|---|---|---|
| view navigation | Grid row 1 | MLR Lua | command sequence + LED/state rendering |
| ALT modifier | hold x16 | MLR Lua | balanced hold/release and reconnect cleanup |
| quantize/TIME | x15 and ALT+x15 | MLR Lua | raw Grid command sequence |
| patterns | x5–x8 | MLR pattern_time | state cards + Grid callbacks |
| recalls | x9–x12 | MLR recall tables | state cards + Grid callbacks |
| track focus | rows 2–7 | MLR Lua | published focus state |
| record/play/reverse/rate | REC Grid rows | MLR + softcut | raw callbacks + track state |
| cut position | CUT Grid rows | MLR + softcut | press/release sequence |
| two-point loop | two simultaneous pads | MLR held ledger | multitouch and Shift-click chord E2E |
| clip assignment | CLIP Grid rows | MLR Lua | raw callbacks + clip/track state |
| clip load/clear/save | K2/E2/K3/E3 | native MLR UI | K/E parity; native modal remains on norns |
| output/track params | E1–E3 and params | norns paramset | authoritative parameter runtime |
| playheads | no browser prediction | softcut phase callback | 20 Hz state + Grid LED frame |
| reconnect | automatic | Ingenue lifecycle | release ledger + resubscribe + snapshot |

## Acceptance boundary

CI proves protocol, state parsing, UI rendering and callback ordering. A final Shield acceptance pass must still confirm audio consequences: buffer input, softcut recording, loop sound, reverse/rate transitions, quantized timing, file selection and pset session recall.
