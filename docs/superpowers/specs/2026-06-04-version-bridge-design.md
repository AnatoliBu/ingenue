# ingenue version bridge — design

**Date:** 2026-06-04
**Status:** design approved, pre-implementation
**Scope:** whole arc, one spec (per decision below)

## Problem

norns scripts can hard-pin a minimum OS version via `norns.version.required = <YYMMDD>`.
The norns OS is now being ported to many other handhelds, and those ports add things
that a literal "update to latest norns" would wipe out. So users on ports get stuck:
a script demands a version newer than what the port reports, and there's no path
forward except hand-hacking.

Worse, **many of these blocks are false.** The port's true base norns is often recent
enough, but the port shipped without a `version.txt`, so norns reports version `000000`
and *every* version-pinned script fails the gate.

ingenue should be the bridge across this: always know the real OS version, surface it,
flag incompatibilities at install time, and offer graduated, honest ways through —
from a no-risk metadata repair to an experimental Lua-layer backport — while being
explicit about what it can and cannot safely do.

## How norns enforces version (verified on a live port, panicos)

- At boot, `lua/core/norns.lua` reads `$HOME/version.txt` into `norns.version.update`.
  If the file is missing, it defaults to `"000000"`.
- `lua/core/script.lua` `Script.run`:
  ```lua
  if tonumber(norns.version.required) and tonumber(norns.version.required) > tonumber(norns.version.update) then
    norns.scripterror("version " .. norns.version.required .. " required")
    Script.clear()
    return
  end
  ```
- That single numeric compare is the **entire** enforcement. `norns.version.required`
  is reset to `nil` before each script load and set by the script's own top-level code.

Consequences:
- The "fib" is trivial: raise `norns.version.update` (live-set over the matron REPL
  for this session, and/or write `version.txt` for future boots) and the gate passes.
- On panicos, `/home/we/version.txt` does not exist → `update == "000000"` → *all*
  versioned scripts (e.g. dreamsequence's `231114`) hard-fail, regardless of real
  capability. dreamsequence's own comment notes `231114` was a *rollback* for Fates
  compatibility (`240221` is only needed for link) — i.e. the pin is conservative.

## The capability ceiling (why "fib" alone is not enough, and where backport stops)

Making the gate pass only helps if the script's genuinely-required APIs are present.
Version gaps split by layer:

- **Lua-layer additions** (new functions/fields in `lua/core`, `util`, `clock`, etc.):
  backportable by dropping in / shimming Lua files. **In scope for the risky path.**
- **C-layer features** (matron / crone / the audio engine binary, exposed to Lua as
  `_norns.*` and a few low-level globals): **not** backportable without recompiling the
  port's core — which is exactly the port-breaking thing we refuse to do. **Out of scope;
  honest refusal.**

The backport engine's central job is therefore to *classify* a version gap as Lua-only
(can attempt) vs C-backed (must refuse), and to be honest about residual risk even when
it succeeds.

## Prior art in ingenue

`scplugins_status` / `scplugins_heal` (the 64-bit SuperCollider UGen healer) is
structurally identical to what we want: detect a host gap, measure it against a curated
set we can supply, idempotently install what's missing, flag a reboot. The version
bridge is the same pattern aimed at a different gap. We reuse: the install/heal/self-
update **lock** (409-on-collision), idempotent healing, structured status reports,
restart-semantics detection (`audio_restart`), and the fake-device mock layer (b53).

## Decisions (with rationale)

1. **Risky-path model: Lua-backport + fib, honest refusal on C gaps.**
   Rejected "fib only" (crashes on truly-absent APIs, no safety net) and "max effort
   incl. C grafting" (can brick audio/boot, not reversible). The chosen path attempts
   only what's safe/reversible and refuses cleanly otherwise.

2. **Version detection: fingerprint + on-disk fast path.**
   Try the port's norns source first (git describe / embedded constant / `version.txt`);
   if absent or untrustworthy, fingerprint the live API against a feature→version table
   and infer the highest fully-satisfied version. Port-agnostic; survives heavy port
   modification. Rejected on-disk-only (ports strip git / renumber → blind) and
   lookup-table-only (blind to unknown ports, leans on the user knowing).

3. **Delta-pack source: auto-derive from upstream git.**
   At heal time, fetch upstream norns at the target ref, diff `lua/`, and apply the
   Lua-only additions. Maximally general / self-scaling vs a hand-curated bundle.
   The added risk of auto-applying OS diffs is contained by the C-binding safety gate
   (decision 1's classifier) plus post-apply verification + rollback. Rejected
   bundled-hand-vetted (safe but limited reach) and community-catalog (needs infra/
   moderation/trust before it delivers anything).

4. **Honest repair = one-tap, separate from the scary path.**
   When a script fails the gate *only* because `version.txt` is missing/zero but its pin
   is ≤ the fingerprinted true base, treat it as a no-risk metadata fix with its own
   frictionless affordance — not the 3-way warning dialog. The dialog is reserved for
   genuine pins-above-base. Rejected silent auto-repair (writes an OS file without
   consent) and always-full-dialog (makes the harmless common case feel dangerous,
   trains click-through).

5. **One big spec, whole arc.** detect → display → gate → auto-derive heal → rollback,
   in one document/plan. Accepted tradeoff: larger, riskier first implementation that
   couples the dangerous auto-patch component to the safe foundation. Mitigated by
   designing strongly-bounded units (below) so it remains reviewable/testable in slices.

6. **Probe execution client-side, not a new server-side ws client.**
   The live matron link is client-side (`matronSend`/`matronOnData`, `@@ING_...@@`
   sentinel parsing). `server.py` is stdlib-only. Fingerprint/binding probes ride the
   existing client channel; decision logic, git, diff, file writes, snapshots live
   server-side. Rejected adding a server-side websocket client (new dependency, breaks
   stdlib-only server, no real gain — the browser already holds the link). Ramification:
   gate detection needs an active ingenue browser session with matron up (true by
   construction during install).

7. **Honest-repair offered only at the install gate, not in config.**
   Config informs but does not act (stated boundary). A bare "repair stamp" button out
   of context invites "did I just update my norns?" confusion. Ramification: a user with
   already-installed scripts that error on launch won't get a repair offer until they
   re-touch the script; relaxing this later is a one-line addition — future
   consideration, not built now.

8. **Server hands the client probe snippets** (rather than the client hardcoding them),
   so all version knowledge stays in one updatable asset that rides self-update.

9. **"Update anyway" stays a distinct option** even though it can crash. Many pins are
   conservative (dreamsequence rolled its own pin back). Make the risk legible rather
   than removing the choice.

## Architecture — seven bounded units

Lua *execution* in the live VM rides the existing client-side matron channel. All
decision logic, git, diff, file writes, snapshots, version.txt live server-side.

| Unit | Lives in | Responsibility | Depends on |
|---|---|---|---|
| `bridge_db.json` | bundled asset | feature→version fingerprint probes; version-int→upstream git ref map; known C-binding symbol list | — (rides self-update) |
| Version intelligence | `server.py` + client probes | `effective_version` = max(on-disk / git-describe, fingerprinted); returns `{reported, fingerprinted, effective, source, confidence}` | bridge_db, matron probes, norns tree path |
| Gate | `server.py` (folds into `analyze_*`) | parse `norns.version.required`; classify `compatible` / `false_block` / `genuine_gap` | version intelligence |
| Honest repair | `server.py` + 1 client call | live-set `norns.version.update` + write correct `version.txt`; idempotent, reversible | matron, `$HOME` |
| Backport engine | `server.py` | fetch upstream at target ref → diff `lua/` → static-scan changed Lua for low-level bindings → probe live VM for each → apply if all present, refuse if any missing → verify → bump | snapshot, version intelligence, matron probes |
| Snapshot/rollback | `server.py` | copy touched files + manifest before any write; restore on demand or auto-rollback on verify-fail | — |
| UX | `index.html` | config status line (read-only); install-gate verdict rendering; 3-way modal + result states | new `/api/bridge/*` endpoints |

All mutating ops serialize through the existing install/heal/self-update lock.

### Path discovery
The norns tree path and `$HOME` are discovered once by querying the live VM
(`package.path`, `os.getenv("HOME")`) — never hardcoded — so nothing is panicos-specific.

## Data flow — the three install cases

The existing install flow already shallow-clones/analyzes a script. The gate hooks in:
the analyzer extracts `required = tonumber(match "norns%.version%.required%s*=%s*(%d+)")`;
the client supplies `effective`. The verdict drives one path.

### Case A — `compatible` (required ≤ effective, version.txt honest)
Silent. Install proceeds as today. No new UI.

### Case B — `false_block` (required ≤ effective, but version.txt missing/zero)
The dreamsequence-on-panicos case. Inline, non-modal amber strip above install:
*"your port lost its version stamp. this script (needs 231114) is actually compatible
with your norns (240221) — repair the stamp so it'll run?"* One tap → honest repair →
install proceeds. No backup warnings, no "experimental." Repair = live-set
`norns.version.update` over matron (gate passes this session immediately) + write
`version.txt` at `$HOME` (survives reboot). Prior value recorded for undo.

### Case C — `genuine_gap` (required > effective)
The 3-way modal, with backups warning + "super experimental" framing:

- **Cancel for now** — abort, nothing changed.
- **Update anyway (just lift the gate)** — pure fib: bump marker to `required`, install,
  run. Stated plainly: *"the check will pass, but if the script calls something your
  norns doesn't have, it'll error or crash mid-use."* No backport. Reversible (marker only).
- **Try risky update (experimental)** — the auto-derive backport engine, steps reported
  live in the modal:
  1. **Resolve** target upstream ref from `bridge_db` (version-int → git tag).
  2. **Fetch** upstream norns `lua/` at that ref (shallow) to temp.
  3. **Diff** vs the port's norns tree → added/changed Lua files.
  4. **Classify** — static-scan every changed chunk for low-level binding refs
     (`_norns.*`, other C-provided globals) and `require`/`include` of files absent on
     the port. For each referenced binding, probe the live VM (`print(type(_norns.x))`).
     - **Any referenced binding missing → C-backed gap → REFUSE.** Honest report listing
       the missing bindings; nothing written; offer Update-anyway / Cancel.
     - **All present → self-contained Lua → continue.**
  5. **Snapshot** every file about to be touched + manifest.
  6. **Apply** the Lua files into the port's norns tree.
  7. **Verify** — re-run the target version's fingerprint probes; previously-missing
     APIs must now resolve. **Fail → auto-rollback**, report, offer Update-anyway / Cancel.
  8. **Bump** marker to `required` (live-set + version.txt), install the script, prompt
     for the matron restart needed for core-lib changes to load.

## Safety, rollback & error handling

**Snapshot precedes every mutating write** (honest-repair and backport). Copies each
target file verbatim (mode/mtime preserved) into
`~/dust/data/ingenue/bridge/snapshots/<utc-stamp>/` with `manifest.json` recording:
files touched, prior marker value, target version, triggering script, upstream ref.
Capped to last 10; oldest pruned.

**Rollback:**
- **Auto** — inside the backport engine on verify-fail or mid-apply write error: restore
  snapshot, leave marker untouched, report which step failed.
- **Manual** — `POST /api/bridge/rollback?snapshot=<stamp>`. Surfaced as "revert last
  bridge change" in the install-result UI only (discoverable right after a risky action,
  not cluttering config).

**Failure taxonomy** (each → structured, honestly-worded result; never a silent half-state):

| Failure | Detection | Response |
|---|---|---|
| matron link down | client has no `matronReady` | don't guess; tell user to open ingenue on-device with matron up; fall back to install-without-gate (today's behavior) |
| upstream fetch fails (offline) | git/urllib error | refuse backport, offer Update-anyway/Cancel; honest-repair + fib still work offline |
| version-int not in `bridge_db` map | lookup miss | refuse backport ("unknown target version"), still offer fib |
| C-binding missing | live probe nil | honest refusal (step 4); nothing written |
| verify fails after apply | post-apply probes still nil | auto-rollback + report |
| write/permission error on norns tree | OS error | auto-rollback partial writes; report path |
| concurrent bridge/install/self-update | existing lock | 409, "another operation is running" |

**Idempotency:** honest-repair and backport no-op cleanly if already applied (marker ≥
target, files already match) — safe to retry, matching `scplugins_heal`.

**Residual risk we cannot undo:** a script that *ran* under a fib may have written bad
state to its own data files (psets/samples). The snapshot owns the OS files; the warning
owns this gap explicitly.

## UX surfaces

### Config modal — read-only status line
One new line, styled like existing audio/SCP health lines, e.g.:
> *norns base: **240221** · fingerprinted (no version stamp on disk) · latest upstream is 250420 — you're ~14 months behind*

States: stamp present & honest (`reported`), stamp missing/zero (`fingerprinted`),
fingerprint inconclusive (`detected ≥ 230101, couldn't pin exactly` — low confidence).
**No buttons.** All actions are contextual at install.

### Install gate — three renderings
- *compatible* → nothing (silent).
- *false_block* → inline amber strip + one **"repair & install"** tap. No modal/warnings.
- *genuine_gap* → modal: title states the gap (*"dreamsequence needs norns 231114;
  you're on 000000/240221"*), three buttons (Cancel / Update anyway / **Try risky
  update**), persistent "experimental — back up psets & samples first" line under risky.

### Risky-update modal — live progress
Reuses the per-job log style of install/heal. Step list fills in:
Resolve ✓ · Fetch ✓ · Diff (7 files) ✓ · Classify… → then one of:
- **applied** ✓ → "backported 7 Lua files, verified, marker set to 231114. **restart
  matron** to load core changes." + quiet "revert this change" link.
- **refused (C gap)** → honest report listing missing bindings + Update-anyway / Cancel.
- **rolled back** → which step failed + nothing left changed + Update-anyway / Cancel.

### Endpoints (mutating ones behind the existing lock)
- `GET /api/bridge/version` — intelligence
- `GET /api/bridge/gate?url=` — verdict (may fold into existing `/api/deps`)
- `POST /api/bridge/repair`
- `POST /api/bridge/backport`
- `POST /api/bridge/rollback`

Probe Lua snippets are returned by the server for the client to run and POST results
back, keeping fingerprint/binding tables server-owned in `bridge_db.json`.

## Testing strategy

Layered to keep most testing off-device:

- **Pure-Python unit tests (bulk):** `required` regex across real catalog scripts;
  `effective_version` max-logic; gate A/B/C classification table; static binding-scanner
  (known pure-Lua vs known C-dependent diffs → assert refuse-vs-apply); snapshot/rollback
  round-trips on a temp tree; idempotency (apply twice → no-op); `bridge_db.json` schema.
- **Fixture-driven diff tests:** check in real upstream norns `lua/` diffs (e.g. the
  231114→240221 link/lattice era) so classifier + applier run against genuine deltas.
  Pull fixtures from the live device + upstream git (panicos access).
- **Mock matron layer:** extend the b53 fake-device demo so probe request/response
  (`@@ING_...@@`) is fakeable — gate/UX testable in-browser with synthetic version
  states (false_block, genuine_gap, C-refusal), zero hardware.
- **On-device smoke (panicos):** dreamsequence false_block repair; a synthetic
  genuine_gap the engine can satisfy; one it must refuse; verify auto-rollback by
  deliberately corrupting a probe.

## Open risks (eyes-open, not blockers)

1. **version-int → git ref mapping is the soft underbelly.** norns tags aren't a clean
   `vYYMMDD` series throughout history; the map in `bridge_db.json` is manual curation.
   Unknown ref → refuse backport (still offer fib). Degrades gracefully.
2. **Static binding-scan can be fooled.** Lua is dynamic (`_norns[varname]`, metatables).
   Backstop: post-apply verify auto-rolls-back if a hidden C dep leaves the feature
   unresolved — but a script could still call a hidden binding at *runtime* our probes
   didn't exercise. Hence "Update anyway" honesty language applies even to a "successful"
   backport.
3. **Restart semantics vary by port.** "restart matron" may be a service restart or a
   power-cycle (per `audio_restart` learnings). Reuse that detection; word accordingly.
4. **Fingerprint confidence floor.** Too few probes pass → report a *range* and lean
   toward showing the genuine_gap dialog rather than silently passing. False caution over
   false confidence.

## Deliverables

- `bridge_db.json` bundled asset (probes, ref map, binding list) + schema.
- `server.py`: version intelligence, gate (into `analyze_*`), honest repair, backport
  engine, snapshot/rollback, `/api/bridge/*` endpoints — all behind the existing lock.
- `index.html`: config status line, install-gate renderings, risky-update modal + result
  states, rollback affordance; mock-layer extension for probes.
- Test suite (Python unit + diff fixtures) and on-device smoke checklist.
- **README: a "version bridge" section** explaining the mechanism, the Lua-vs-C ceiling,
  and exactly what "risky update" does and does not touch.

## Out of scope (this spec)

- Community delta-pack catalog / contribution infra (future; auto-derive covers reach now).
- Repairing already-installed errored scripts from config (future one-line relaxation).
- Any C-layer / matron / crone / audio-engine modification.
