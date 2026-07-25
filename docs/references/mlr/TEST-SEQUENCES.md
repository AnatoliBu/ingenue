# MLR acceptance sequences

## CI fixture

1. Open `/mlr.html` through the localhost bridge.
2. Confirm a 16×8 surface, six tracks, seven clips, four patterns and four recalls.
3. Press and release a cut pad; assert balanced `grid.key` commands.
4. Shift-click two pads on one track; assert down/down/up/up ordering.
5. Hold ALT, trigger a navigation action and release ALT.
6. Trigger K2 and E2; assert standard norns callbacks.
7. Hold a pad, destroy the socket and confirm local release plus resubscription.
8. Confirm all LEDs come from the published Grid frame.

## Real norns Shield

1. Install upstream MLR and load known 48 kHz WAV files into clip slots.
2. Verify REC view record, play, reverse, seven speed positions and tempo-map toggles.
3. Verify CUT jumps on all six tracks.
4. Create forward and reverse loops with physical Grid, multitouch browser and Shift-click browser; compare loop boundaries.
5. Record, play, stop and clear all four patterns.
6. Record, execute and clear all four recalls.
7. Toggle quantize and compare cut timing against the physical Grid.
8. Enter TIME with ALT+x15 and adjust tempo/quant division from browser E2/E3.
9. Run native load, clear, save and resize operations using browser K/E controls while observing the norns modal UI.
10. Disconnect Wi-Fi while pads are held, reconnect, and confirm no track, modifier or loop key remains stuck.
11. Save a pset, restart MLR, reload it and verify browser state follows the restored session.
