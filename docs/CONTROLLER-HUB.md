# Controller readiness hub

Open the unified readiness page at:

```text
http://norns.local:7777/controllers.html
```

It combines the realtime hello capabilities with the authoritative snapshot and reports availability for the performance surface, Grid, Arc, automatic parameters, Launchpad, Gamepad and MIDI Learn.

The safe ping button uses `system.ping`, which is answered immediately by the Python realtime server and does not send a command into matron or alter audio. Web MIDI is reported as limited when the browser lacks `requestMIDIAccess` or the page is not running in a secure context.
