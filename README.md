# ingenue

A responsive, modern redesign of **maiden** (the web editor for monome norns), built
first as a high-fidelity interactive prototype and headed toward replacing system maiden
on-device (starting with the PanicOS / handheld port).

- `web/` — the interactive prototype (`index.html`, served by `server.py`). Single
  self-contained page; loads the real Ace editor + the live community catalog
  (`community.json`) enriched with demo videos / last-updated (`enriched.json`, from the
  [`nornslist`](../nornslist) scraper).
- `mcp/` — `maiden_mcp.py`, a companion MCP server exposing the device bridge (REPL,
  scripts, files, engines). Shares its `engine_check_conflict` plumbing with the web UI's
  install-time deconfliction.
- `DESIGN-NOTES.md` — what's built + the backlog.

## Run the preview

```bash
python3 web/server.py 8780      # → http://<this-machine>:8780/
```

## Status

Prototype is feature-rich (responsive layout, ~26 themes, editor/console/split + first-class
file manager, redesigned repo manager with GitHub discovery, install dock, engine
deconfliction). Not yet wired to a real device — that's the next phase (ship as the
"ingenue" mod that toggles against system maiden).

## Stretch goals (PRs welcome)

- **Browser → MIDI bridge for PARAMS.** Use the Web MIDI API so a controller plugged
  into the *computer* running ingenue can MIDI-learn and drive the running script's
  params over the live matron link — MIDI mapping without the controller on the norns.
  Prototyped then shelved for scope; would love someone to pick it up.
