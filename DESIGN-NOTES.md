# ingenue — design notes

Modern, responsive redesign of **maiden** for norns. Prototype lives in `web/index.html`.
The build stamp (config panel header, `bN · date · summary`) identifies the loaded version.

> **History note:** this lived in `norns-panicos/mockups/` until a parallel `git clean`
> in that repo wiped the untracked files. Recovered from a cached browser copy (b18) and
> moved here to its own committed repo so it's protected.

## Built (verified in the prototype)

1. **Responsive layout** via CSS container queries — phone / tablet / desktop.
2. **~41 color themes** (base16 / Catppuccin / Rosé Pine / Tokyo Night / Everforest / Ayu /
   Gruvbox Material / …), themed across the whole UI; **editor syntax generated from each
   palette** so even schemes Ace doesn't bundle color the editor.
3. **Dynamic prefs** — `prefers-color-scheme` default (follows OS until you pick),
   `pointer:coarse` font bump, `prefers-reduced-motion`. Persists via localStorage.
4. **Editor / console / split** view modes (desktop/iPad), resizable console (drag, clamped),
   real Ace editor (editable, Lua mode).
5. **Floating file tree drawer** on every size (iPhone-style), hides in the repo manager;
   quick-open via tab-bar tree button / iPhone top-bar menu.
6. **First-class file manager** — browse anywhere up to `dust` (the top limit), breadcrumb,
   multi-select, new folder, **rename**, **delete (confirm)**, **download (zips multiples)**,
   **unified upload** (files + multiple folders via drag, one handler; config toggle to split
   for touch), **smart batched upload** (many small files → one archive, not N round-trips).
7. **Repo manager redesign** — cards (always expanded, rich detail), search, sort (recent /
   last-updated / name / author / stars), source filter, install dock with live log +
   success/error, **bulk install** (multi-select + select-all + batched trust gate).
8. **Real community catalog (350+)** loaded dynamically; enriched with last-updated + demo.
9. **Expandable card detail** — last-updated, code/docs/discuss/norns.community links, and
   **embedded demo** (YouTube/Vimeo/SoundCloud; Instagram + other → link; non-URL → none;
   all URLs validated → no broken links).
10. **GitHub sources & discovery** — color-coded sources (community / custom / @you / github),
    token in config (on-device/proxied messaging), live GitHub search (paged, Enter-only,
    hide-already-have), cross-matched to the catalog.
11. **Untrusted-source install gate** — warns for non-community sources, 1–4 wk snooze (capped).
12. **B1 — bulk install** ✅ ; **B2 — engine deconfliction** ✅ (Cancel / Install anyway /
    Install renamed [prefilled free name] / **Use existing** [dedupe]); **B3 — MCP server** ✅.
13. **Help (?)** modal — shortcuts + doc links + build stamp.

## Port codec/UGen health — "fix missing requirements for the install architecture" (b24)

Many scripts play through **SuperCollider engines** built on community **UGen plugins**
(PortedPlugins, mi-UGens, f0plugins, …), distributed as precompiled **32-bit ARM** `.so`.
On a **64-bit (aarch64) norns port** scsynth silently rejects the wrong-arch binaries, so an
engine's *class* loads (its name appears in the engine list) but its UGens are "not installed"
→ SynthDefs fail to build → **the script loads but is silent** (e.g. amenbreak's AnalogTape/Fverb).
PanicOS ships a *half-implemented* state: PortedPlugins `.sc` **classes** present, **zero** compiled
`.so`. ingenue now:

- **Ships the fix.** Bundles aarch64 UGen binaries in `web/vendor/sc-plugins-arm64-*.tar.gz`
  ([seajaysec/sc-plugins-arm64](https://github.com/seajaysec/sc-plugins-arm64), 68 `.so` × 10
  collections) — so a port that includes ingenue gets them with **no extra dependency**, installable **offline**.
- **Silently checks on every launch** (`/api/scplugins`, not tied to installing any script). Reads the
  host arch + the `.so` arch across the SC Extensions dirs; detects *missing* and *wrong-arch* binaries
  and the *classes-but-no-binaries* half-state. Surfaces a dismissable banner only when a 64-bit host
  actually needs it.
- **Heals** (`/api/scplugins/heal`) into a **binary-only** dir (`…/Extensions/ingenue-ugens/`) —
  `.so` need not sit next to `.sc`, so no duplicate-class breakage. Idempotent (skips correct-arch
  binaries already present). Offline by default; if GitHub is reachable and a **newer** release exists,
  offers to fetch it instead. **Always recommends a full device power-cycle** (scsynth loads plugins
  only at boot). Self-healing: if a reboot/OS-update ever wipes them, the next launch re-detects + re-offers.

> Diagnostic note: the silence was first mis-attributed to a FLAC/libsndfile codec gap (off a bad `ldd`
> read); a `ctypes` functional probe disproved it before any system change. The real class was the
> SC-UGen arch mismatch above. Verify codec/arch claims functionally before touching system files.

## Backlog

> **Shipped b25–b26:** B5 (README + carousel), B6 (tag filter + nb "additional voice"),
> B7 (ingenue consumes a nightly `feed.json` — scraper-side generator still TODO in nornslist),
> B8 (mods manager), B9 (live params + presets), B10 (audio health + restart), plus live
> REPL/files/editor-save, device info, and **live file-browser write ops** (mkdir / rename /
> delete / upload — real `/api/mkdir`,`/api/rename`,`/api/rm`,`/api/write`). B11 (wide-range
> param number-entry) done. Remaining: per-dep trust-gating in the recursive heal, and the
> nornslist-side feed generator (the scraper emitting the nightly `feed.json` ingenue consumes).

- **B4 — Patches & dependency handling.** ✅ **Shipped (b20–b23).** Dependency analyzer
  (`/api/deps`, by name for installed or by url via shallow clone for un-installed) detects
  install scripts, sample/audio downloads, SC-engine extensions, required scripts, nb voices,
  and native build tools. **Recursive tracing** (`traceDeps`, depth ≤ 4, cycle-safe) walks the
  whole require graph — a script → the scripts it needs → *their* needs — and renders it as a
  nested plan. **Heal** runs the graph **deepest-first**: each dependency is cloned and its own
  installer run before the parent's, so e.g. amenbreak's downloads land via a port-proofed
  Python interpreter of `install.sh` (native tar/zip, `/home/we/dust`→real-dust translation,
  BusyBox-safe). Heal is also offered automatically right after install when the graph needs it.
  *Remaining:* per-dep trust-gating in the recursive path, optional curated port patches.
- **B5 — Rich detail from norns.community.** Pull README description + an image gallery into
  the expanded card; hide the gallery if no/only-generic images; **album-style left/right
  carousel** for multiples. (`nornslist` scraper can be extended to capture these.)
- **B6 — Tag filter facet.** A real multi-select tag filter from existing catalog tags (with
  counts; today tags are only an undiscoverable click-a-pill shortcut), plus a **dynamically
  generated "additional voice" tag** for scripts that register **nb voices** — making the
  nb-rig flow (filter → select all → bulk install) one obvious path.
- **B7 — ingenue ↔ nornslist integration.** Reduce duplicated work + local overhead by
  designing what the [`nornslist`](../nornslist) scraper precomputes (READMEs, images,
  last-updated, demos, nb-voice detection, engine names) and ships as a **nightly-refreshed
  static data feed** ingenue consumes, vs. what ingenue must compute live (GitHub search,
  device state). Goal: ingenue stays light on-device; heavy enrichment is offloaded.
- **B8 — Mods manager.** Detect the current state of norns **mods** on device (scan
  `dust/code/*/lib/mod.lua` + the enabled-mods state norns persists), expose them in ingenue for
  **enable/disable**, and **remind to restart norns** when you enable a mod that wasn't already on
  (mods load at startup). Mirror of the SYSTEM > MODS menu, in the browser.
- **B9 — Live parameters + preset + MIDI bridge.** A view into the running script's **PARAMS**
  menu: read the param tree from matron and **edit values in the browser with changes reflected
  live on device** (and vice-versa), plus **save/load presets**. Stretch: a **MIDI mapping** mode
  that uses the **browser** (Web MIDI) as a bridge to MIDI controllers connected to the *computer*,
  mapping them to the params ingenue sees — MIDI-learn without the controller being on the norns.
  (Depends on a live matron link — same websocket plumbing as the REPL/MCP work.)
- **B10 — Audio-server health + restart.** Detect jack/audio-stack state (jackd/scsynth/crone
  alive; recent `playback device "hw:0" is already in use` / `JackServer::Open failed` in the log —
  the device-handoff race that kills all audio on a stack restart) and expose a **status line +
  Restart Audio button in config**. Best-effort restart; recommends a full power-cycle when it can't.

- **B11 — Safer wide-range param edits (someday).** Some scripts declare a huge param
  range (e.g. acid_test `sequence length` 1–256) but can't survive an arbitrary in-range
  change live (mid-clock array resize → crash). Idea: for very-wide-range integer params,
  commit on a tap / number entry instead of a twitchy slider (set 32 deliberately, not by
  smearing through 256), and/or let scripts/us flag known-risky params. Low priority.

## Shipping plan (proposed — "ingenue" on device)

- Ship as a **norns mod** you enable/disable that switches the served web app from system
  maiden to ingenue (asset swap + maiden restart, since maiden is a separate process — a pure
  Lua mod can't do it alone; needs a small shell/service step).
- **Auto-self-updater** — checks the hosted repo for pushes, offers to update, shows the
  changelog (git log). Feasible.
- Eventually request inclusion in the norns-community installer to target regular maiden.
- *Open question:* asset-swap-and-restart vs. run ingenue on its own port and redirect.
