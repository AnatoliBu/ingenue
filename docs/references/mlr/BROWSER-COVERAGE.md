# MLR browser coverage

| MLR function | Browser input | Authority | Automated coverage |
|---|---|---|---|
| view navigation | workflow or Grid row 1 | MLR Lua | exact command sequence + LED/state rendering |
| track/clip target | explicit T1–T6 and C1–C7 selectors | MLR Lua | CLIP assignment sequence |
| record workflow | Record / Stop recording | MLR + softcut | assignment, REC arm and transport sequence |
| ALT modifier | hold x16 | MLR Lua | balanced hold/release and reconnect cleanup |
| quantize/TIME | x15 and ALT+x15 | MLR Lua | raw Grid command sequence |
| patterns | x5–x8 | MLR pattern_time | state cards + Grid callbacks |
| recalls | x9–x12 | MLR recall tables | state cards + Grid callbacks |
| track focus | rows 2–7 | MLR Lua | published focus state |
| record/play/reverse/rate | workflow or REC Grid rows | MLR + softcut | exact callbacks + track state |
| cut position | Cut/play or CUT Grid rows | MLR + softcut | press/release sequence |
| two-point loop | explicit start/end, multitouch or Shift-click chord | MLR held ledger | down/down/up/up E2E |
| clip assignment | workflow or CLIP Grid rows | MLR Lua | exact callbacks + clip/track state |
| clip load/clear/save | explicit action or K2/E2 | native MLR UI | deterministic E2/K2 sequence; native modal remains on norns |
| clip reset length | explicit factor or K3/E3 | native MLR UI | deterministic 1/2–16 beat E3/K3 sequence |
| output/track params | E1–E3 and params | norns paramset | authoritative parameter runtime |
| playheads | no browser prediction | softcut phase callback | 20 Hz state + Grid LED frame |
| reject diagnostics | workflow status + diagnostics drawer | realtime settlement | target, code and message preserved |
| reconnect | automatic | Ingenue lifecycle | release ledger + resubscribe + snapshot |

## Acceptance boundary

CI proves protocol, state parsing, UI rendering, composed callback ordering and deterministic reject presentation. A final Shield acceptance pass must still confirm audio consequences: buffer input, softcut recording, loop sound, reverse/rate transitions, quantized timing, file selection and pset session recall.
