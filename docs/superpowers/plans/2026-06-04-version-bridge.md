# Version Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ingenue detect a port's true norns OS version, gate version-incompatible script installs, repair false blocks in one tap, and (experimentally) auto-derive Lua-layer backports from upstream norns git — refusing honestly when a gap needs C-layer features.

**Architecture:** All Lua execution in the live VM (fingerprint probes, C-binding existence checks, the live-set of `norns.version.update`) rides the existing client-side matron channel in `index.html` (`matronSend`/`matronOnData`, `@@ING_…@@` sentinel parsing). All decision logic, git fetching, diffing, file writes, snapshots, and `version.txt` writes live server-side in a new **stdlib-only, import-side-effect-free** module `web/bridge.py`, called by thin endpoints in `web/server.py`. A bundled `web/bridge_db.json` asset holds fingerprint probes, the version-int→git-ref map, and the C-binding symbol list. The browser orchestrates a multi-round dance (server prepares → client probes → server applies) because only the browser can talk to matron.

**Tech Stack:** Python 3 stdlib only (`http.server`, `subprocess`, `json`, `re`, `shutil`, `urllib`); `git` CLI; vanilla JS in `index.html`; tests via stdlib `unittest`.

**Source spec:** `docs/superpowers/specs/2026-06-04-version-bridge-design.md`

---

## File structure

| File | New? | Responsibility |
|---|---|---|
| `web/bridge.py` | **new** | Pure logic: parse `version.required`; classify gate verdict; compute effective version; resolve git ref; fetch/diff upstream lua; scan diffs for low-level bindings; snapshot/restore. No module-level side effects, stdlib only. |
| `web/bridge_db.json` | **new** | Fingerprint probes, `YYMMDD→tag` ref map, C-binding symbol list, schema version. |
| `web/tests/test_bridge.py` | **new** | `unittest` suite for everything in `bridge.py` + `bridge_db.json` schema. |
| `web/tests/fixtures/` | **new** | Real upstream lua diff fixtures + sample script headers. |
| `web/server.py` | modify | Add `/api/bridge/*` endpoints (thin); add `version_required` to `analyze_dir`'s report. Reuse `_busy_lock`. |
| `web/index.html` | modify | Bridge client orchestration; config status line; install-gate renderings; risky-update modal; extend the mock layer for probes. |
| `README.md` | modify | "version bridge" section. |

### Endpoint contract (server is stateless except a short-lived prep cache)

- `GET  /api/bridge/probes` → `{db_version, fingerprint:[{id,version,lua}], bindings:[sym,…], ondisk:{reported,source,norns_root}}`. Server fills `ondisk` from disk (git-describe on the dust-relative norns tree). Client runs `fingerprint` lua + reads live `norns.version.update`, computes `fingerprinted` and `effective`.
- `POST /api/bridge/gate` body `{url|name, effective, reported}` → verdict `{case, required, effective, reported, msg}` where `case ∈ {compatible, false_block, genuine_gap, no_pin}`.
- `POST /api/bridge/repair` body `{target, home}` → writes `version.txt` (snapshotted). Client separately live-sets the global over matron.
- `POST /api/bridge/backport/plan` body `{required, norns_root}` → fetches upstream at resolved ref, diffs lua, scans → `{prep, target_ref, files:[…], bindings:[sym,…]}` (no writes; stashes prepared tree under a temp dir keyed by `prep`).
- `POST /api/bridge/backport/apply` body `{prep, bindings_present:{sym:bool}}` → if any false: `{ok:false, refused:true, missing:[…]}` (nothing written). Else snapshot + write files → `{ok:true, snapshot, applied:[…]}`.
- `POST /api/bridge/backport/commit` body `{target, home}` → bump marker (`version.txt`); client live-sets the global. (Called by client only after client-side verify probes pass.)
- `POST /api/bridge/rollback` body `{snapshot}` → restore manifest.

All mutating endpoints acquire `_busy_lock` non-blocking; collision → 409 (mirrors existing install/heal/self-update).

### Client orchestration sequence (in `index.html`)

```
on install tap:
  if not matronReady -> skip gate (today's behavior)
  GET /api/bridge/probes -> run fingerprint lua via matronSend -> compute effective, reported
  POST /api/bridge/gate {url, effective, reported}
  switch verdict.case:
    compatible | no_pin -> install as today
    false_block -> amber strip; on "repair & install":
        POST /api/bridge/repair {target:required, home}; matronSend set update; install
    genuine_gap -> 3-way modal:
        cancel -> nothing
        update_anyway -> matronSend set update=required; POST /api/bridge/commit; install
        risky -> POST .../plan -> probe each binding via matronSend
                 -> POST .../apply {prep, bindings_present}
                    refused -> show missing bindings, offer update_anyway/cancel
                    applied -> run fingerprint probes for `required` via matronSend (VERIFY)
                       verify ok -> POST .../commit; install; "restart matron"; offer rollback
                       verify fail -> POST .../rollback {snapshot}; show failure; offer update_anyway/cancel
```

---

## Phase 0 — Test harness & data asset

### Task 0.1: Test runner + importable module skeleton

**Files:**
- Create: `web/bridge.py`
- Create: `web/tests/__init__.py` (empty)
- Create: `web/tests/test_bridge.py`

- [ ] **Step 1: Create the empty package init**

```bash
: > web/tests/__init__.py
```

- [ ] **Step 2: Write the skeleton module** (`web/bridge.py`)

```python
"""ingenue version bridge — pure logic (stdlib only, no import side effects).

Everything here takes explicit arguments (paths, dicts) and returns plain data,
so it is unit-testable off-device. server.py supplies real paths and the lock.
"""
import json
import os
import re
import shutil
import subprocess

SCHEMA_VERSION = 1
```

- [ ] **Step 3: Write the first failing test** (`web/tests/test_bridge.py`)

```python
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import bridge  # noqa: E402


class TestModule(unittest.TestCase):
    def test_schema_version_present(self):
        self.assertEqual(bridge.SCHEMA_VERSION, 1)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 4: Run the suite, verify it passes**

Run: `python3 -m unittest discover -s web/tests -p 'test_*.py' -v`
Expected: `1 test … OK`

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/__init__.py web/tests/test_bridge.py
git commit -m "test: bridge module skeleton + stdlib unittest harness"
```

### Task 0.2: `bridge_db.json` data asset + schema validation

**Files:**
- Create: `web/bridge_db.json`
- Modify: `web/bridge.py` (add `load_db`, `validate_db`)
- Test: `web/tests/test_bridge.py`

- [ ] **Step 1: Write the data asset** (`web/bridge_db.json`)

```json
{
  "schema_version": 1,
  "ref_map": {
    "231114": "v2.8.3",
    "240221": "v2.8.4"
  },
  "bindings": ["_norns", "_path", "_dbg", "_startup_status"],
  "fingerprint": [
    {
      "id": "clock_link_set_tempo",
      "version": "240221",
      "lua": "type(clock)=='table' and type(clock.link)=='table' and clock.link.set_tempo~=nil"
    },
    {
      "id": "lattice_present",
      "version": "231114",
      "lua": "pcall(require,'lattice')"
    }
  ]
}
```

> NOTE for the implementer: `ref_map` entries are placeholders to be verified against
> real norns release dates during Task 5.1. The two above are the link/lattice-era
> anchors the spec calls out; expand only with date→tag pairs you have confirmed.

- [ ] **Step 2: Write the failing tests** (append to `test_bridge.py`)

```python
class TestDb(unittest.TestCase):
    def setUp(self):
        self.db = bridge.load_db()

    def test_db_loads(self):
        self.assertEqual(self.db["schema_version"], bridge.SCHEMA_VERSION)

    def test_db_valid(self):
        bridge.validate_db(self.db)  # raises on problem

    def test_ref_map_keys_are_six_digit_ints(self):
        for k in self.db["ref_map"]:
            self.assertRegex(k, r"^\d{6}$")

    def test_fingerprint_entries_well_formed(self):
        for e in self.db["fingerprint"]:
            self.assertIn("id", e)
            self.assertIn("version", e)
            self.assertIn("lua", e)
            self.assertRegex(e["version"], r"^\d{6}$")
```

- [ ] **Step 3: Run, verify failure**

Run: `python3 -m unittest discover -s web/tests -p 'test_*.py' -v`
Expected: FAIL — `AttributeError: module 'bridge' has no attribute 'load_db'`

- [ ] **Step 4: Implement `load_db` + `validate_db`** (append to `bridge.py`)

```python
_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bridge_db.json")


def load_db(path=_DB_PATH):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def validate_db(db):
    if db.get("schema_version") != SCHEMA_VERSION:
        raise ValueError("bridge_db schema_version mismatch")
    if not isinstance(db.get("ref_map"), dict):
        raise ValueError("ref_map must be an object")
    for k in db["ref_map"]:
        if not re.fullmatch(r"\d{6}", k):
            raise ValueError(f"ref_map key not YYMMDD: {k}")
    if not isinstance(db.get("bindings"), list):
        raise ValueError("bindings must be a list")
    for e in db.get("fingerprint", []):
        if not all(key in e for key in ("id", "version", "lua")):
            raise ValueError(f"fingerprint entry missing keys: {e}")
        if not re.fullmatch(r"\d{6}", e["version"]):
            raise ValueError(f"fingerprint version not YYMMDD: {e}")
    return True
```

- [ ] **Step 5: Run, verify pass**

Run: `python3 -m unittest discover -s web/tests -p 'test_*.py' -v`
Expected: all OK

- [ ] **Step 6: Commit**

```bash
git add web/bridge.py web/bridge_db.json web/tests/test_bridge.py
git commit -m "feat(bridge): bundled bridge_db.json + schema validation"
```

---

## Phase 1 — Version intelligence

### Task 1.1: Parse `norns.version.required` from script text

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing tests**

```python
class TestParseRequired(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(bridge.parse_required("norns.version.required = 231114"), 231114)

    def test_with_comment_and_spacing(self):
        src = "norns.version.required   =  240221 -- needs link\n"
        self.assertEqual(bridge.parse_required(src), 240221)

    def test_absent_returns_none(self):
        self.assertIsNone(bridge.parse_required("function init() end"))

    def test_first_wins(self):
        self.assertEqual(bridge.parse_required("a\nnorns.version.required=200101\nnorns.version.required=999999"), 200101)
```

- [ ] **Step 2: Run, verify failure** (`AttributeError: parse_required`)

Run: `python3 -m unittest web.tests.test_bridge.TestParseRequired -v` (run from repo root; if module path fails use the discover form below)
Run: `python3 -m unittest discover -s web/tests -p 'test_*.py' -v`

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
_REQUIRED_RE = re.compile(r"norns\.version\.required\s*=\s*(\d+)")


def parse_required(text):
    """Return the int after the first `norns.version.required = N`, or None."""
    m = _REQUIRED_RE.search(text)
    return int(m.group(1)) if m else None
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): parse norns.version.required from script text"
```

### Task 1.2: On-disk version detection (git-describe / version.txt) from the norns tree

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing tests** (use a temp dir to simulate a norns tree)

```python
import tempfile


class TestOndisk(unittest.TestCase):
    def test_version_txt_wins_when_nonzero(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "version.txt"), "w") as f:
                f.write("240221\n")
            info = bridge.ondisk_version(d)
            self.assertEqual(info["reported"], 240221)
            self.assertEqual(info["source"], "version.txt")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_zero_version_txt_is_treated_as_unknown(self):
        d = tempfile.mkdtemp()
        try:
            with open(os.path.join(d, "version.txt"), "w") as f:
                f.write("000000")
            info = bridge.ondisk_version(d)
            self.assertEqual(info["reported"], 0)
            self.assertEqual(info["source"], "none")
        finally:
            shutil.rmtree(d, ignore_errors=True)

    def test_missing_everything(self):
        d = tempfile.mkdtemp()
        try:
            info = bridge.ondisk_version(d)
            self.assertEqual(info["reported"], 0)
            self.assertEqual(info["source"], "none")
        finally:
            shutil.rmtree(d, ignore_errors=True)
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def ondisk_version(norns_root):
    """Best-effort true version from the on-disk norns tree.
    Order: $norns_root/version.txt (if nonzero) -> git describe tag mapped later.
    Returns {reported:int, source:str}. reported==0 means 'unknown'."""
    vt = os.path.join(norns_root, "version.txt")
    try:
        with open(vt, "r", encoding="utf-8") as f:
            n = int((f.read() or "0").strip() or "0")
        if n > 0:
            return {"reported": n, "source": "version.txt"}
    except (OSError, ValueError):
        pass
    return {"reported": 0, "source": "none"}
```

> NOTE: git-describe→date mapping is intentionally deferred. On-disk `version.txt`
> is the only honest on-disk signal; absent it, the fingerprint path (client-side)
> is authoritative. Keeping this function pure-disk keeps it testable.

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): on-disk norns version detection (version.txt)"
```

### Task 1.3: Compute fingerprinted + effective version from probe results

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing tests**

```python
class TestEffective(unittest.TestCase):
    def setUp(self):
        self.fp = [
            {"id": "a", "version": "231114", "lua": "x"},
            {"id": "b", "version": "240221", "lua": "y"},
        ]

    def test_fingerprint_highest_passing(self):
        # both pass -> 240221
        self.assertEqual(bridge.fingerprinted_version({"a": True, "b": True}, self.fp), 240221)

    def test_partial_pass(self):
        self.assertEqual(bridge.fingerprinted_version({"a": True, "b": False}, self.fp), 231114)

    def test_none_pass(self):
        self.assertEqual(bridge.fingerprinted_version({"a": False, "b": False}, self.fp), 0)

    def test_effective_is_max(self):
        intel = bridge.intelligence(reported=240221, probe_results={"a": True, "b": False}, fingerprint=self.fp)
        self.assertEqual(intel["effective"], 240221)
        self.assertEqual(intel["fingerprinted"], 231114)
        self.assertEqual(intel["reported"], 240221)

    def test_effective_prefers_fingerprint_when_reported_zero(self):
        intel = bridge.intelligence(reported=0, probe_results={"a": True, "b": True}, fingerprint=self.fp)
        self.assertEqual(intel["effective"], 240221)
        self.assertIn(intel["confidence"], ("high", "low"))
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def fingerprinted_version(probe_results, fingerprint):
    """Highest fingerprint `version` whose probe passed; 0 if none."""
    best = 0
    for e in fingerprint:
        if probe_results.get(e["id"]):
            best = max(best, int(e["version"]))
    return best


def intelligence(reported, probe_results, fingerprint):
    fp = fingerprinted_version(probe_results, fingerprint)
    effective = max(int(reported or 0), fp)
    passed = sum(1 for e in fingerprint if probe_results.get(e["id"]))
    confidence = "high" if (reported or passed >= 2) else "low"
    return {"reported": int(reported or 0), "fingerprinted": fp,
            "effective": effective, "confidence": confidence}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): fingerprinted + effective version computation"
```

### Task 1.4: Server `GET /api/bridge/probes` + norns-root discovery

**Files:** Modify `web/server.py`

- [ ] **Step 1: Add a norns-root resolver near `available_engines`** (`web/server.py`, after the `available_engines` function ~line 420)

```python
def norns_root():
    """Locate the on-device norns lua/data tree relative to the dust path.
    Mirrors available_engines()'s dust-relative search. Returns a dir or None."""
    for rel in ("../norns", "../../norns", "../../we/norns"):
        cand = os.path.normpath(os.path.join(DUST, rel))
        if os.path.isdir(os.path.join(cand, "lua", "core")):
            return cand
    return None
```

- [ ] **Step 2: Import bridge at top of `server.py`** (add to the import line block near line 19)

```python
import bridge
```

- [ ] **Step 3: Add the GET route** (`web/server.py`, in `do_GET`, beside the other `/api/...` routes ~line 1015)

```python
            if path == "/api/bridge/probes":
                db = bridge.load_db()
                nr = norns_root()
                ondisk = bridge.ondisk_version(nr) if nr else {"reported": 0, "source": "none"}
                ondisk["norns_root"] = nr
                return self._json({"db_version": db["schema_version"],
                                   "fingerprint": db["fingerprint"],
                                   "bindings": db["bindings"], "ondisk": ondisk})
```

- [ ] **Step 4: Smoke-test the endpoint locally**

Run: `cd web && INGENUE_DUST=/tmp python3 server.py 7799 & sleep 1; curl -s localhost:7799/api/bridge/probes; kill %1`
Expected: JSON with `fingerprint`, `bindings`, `ondisk` keys (norns_root null off-device — fine).

- [ ] **Step 5: Commit**

```bash
git add web/server.py
git commit -m "feat(server): /api/bridge/probes + dust-relative norns_root discovery"
```

---

## Phase 2 — The gate

### Task 2.1: Classify the verdict

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing tests**

```python
class TestGate(unittest.TestCase):
    def test_no_pin(self):
        self.assertEqual(bridge.classify(None, effective=240221, reported=240221)["case"], "no_pin")

    def test_compatible(self):
        v = bridge.classify(231114, effective=240221, reported=240221)
        self.assertEqual(v["case"], "compatible")

    def test_false_block(self):
        # required satisfied by effective, but the live stamp (reported) is behind -> norns errors
        v = bridge.classify(231114, effective=240221, reported=0)
        self.assertEqual(v["case"], "false_block")

    def test_genuine_gap(self):
        v = bridge.classify(250101, effective=240221, reported=240221)
        self.assertEqual(v["case"], "genuine_gap")
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def classify(required, effective, reported):
    """Decide the install verdict. `reported` is the live norns.version.update;
    `effective` is max(reported, fingerprinted)."""
    if required is None:
        return {"case": "no_pin", "required": None, "effective": effective, "reported": reported}
    if required > effective:
        case = "genuine_gap"
    elif required > (reported or 0):
        case = "false_block"   # capability present, but the stamp would make norns error
    else:
        case = "compatible"
    return {"case": case, "required": required, "effective": effective, "reported": reported}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): gate verdict classification"
```

### Task 2.2: Add `version_required` to `analyze_dir`'s report

**Files:** Modify `web/server.py`; Test `web/tests/test_bridge.py` (via a fixture-based unit on the regex through bridge)

- [ ] **Step 1: Add a fixture script header** (`web/tests/fixtures/pinned_script.lua`)

```lua
-- sample header
norns.version.required = 231114 -- needs lattice
function init() end
```

- [ ] **Step 2: Failing test** (append to `test_bridge.py`)

```python
class TestFixtures(unittest.TestCase):
    def test_pinned_fixture(self):
        p = os.path.join(os.path.dirname(__file__), "fixtures", "pinned_script.lua")
        with open(p) as f:
            self.assertEqual(bridge.parse_required(f.read()), 231114)
```

- [ ] **Step 3: Run, verify it passes** (parse_required already exists — this guards the wiring)

- [ ] **Step 4: Wire into `analyze_dir`** (`web/server.py`, inside `analyze_dir`, in the `rep = {…}` dict ~line 478)

Add one key, computed from the already-collected `blob`:

```python
        "version_required": bridge.parse_required(blob),
```

- [ ] **Step 5: Verify via the deps endpoint**

Run: `cd web && INGENUE_DUST=/tmp python3 server.py 7799 & sleep 1; curl -s 'localhost:7799/api/deps?url=https://github.com/dan-derks/dreamsequence' | python3 -m json.tool | grep version_required; kill %1`
Expected: `"version_required": 231114` (network permitting; otherwise rely on Step 3 unit).

- [ ] **Step 6: Commit**

```bash
git add web/server.py web/tests/fixtures/pinned_script.lua web/tests/test_bridge.py
git commit -m "feat(server): surface version_required in analyze_dir report"
```

### Task 2.3: `POST /api/bridge/gate`

**Files:** Modify `web/server.py`

- [ ] **Step 1: Add the POST route** (`web/server.py`, in `do_POST` beside other routes ~line 1074)

```python
            if path == "/api/bridge/gate":
                url = (b.get("url") or "").strip()
                name = (b.get("name") or "").strip()
                rep = analyze_remote(url) if url else analyze_script(name)
                if rep.get("error"):
                    return self._json(rep, 400)
                v = bridge.classify(rep.get("version_required"),
                                    int(b.get("effective") or 0),
                                    int(b.get("reported") or 0))
                v["name"] = rep.get("name")
                return self._json(v)
```

- [ ] **Step 2: Smoke-test**

Run: `cd web && INGENUE_DUST=/tmp python3 server.py 7799 & sleep 1; curl -s -X POST localhost:7799/api/bridge/gate -d '{"name":"nonexistent","effective":240221,"reported":240221}'; kill %1`
Expected: a JSON error (script not installed) with 400 — confirms wiring/handler reached.

- [ ] **Step 3: Commit**

```bash
git add web/server.py
git commit -m "feat(server): /api/bridge/gate verdict endpoint"
```

---

## Phase 3 — Snapshot / rollback (built before any writer that needs it)

### Task 3.1: Snapshot + restore on a temp tree

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing tests**

```python
class TestSnapshot(unittest.TestCase):
    def test_snapshot_then_restore_roundtrip(self):
        root = tempfile.mkdtemp()
        snaproot = tempfile.mkdtemp()
        try:
            f1 = os.path.join(root, "a.txt")
            with open(f1, "w") as f:
                f.write("original")
            snap = bridge.snapshot(snaproot, [f1], meta={"why": "test"})
            self.assertTrue(os.path.isdir(snap))
            with open(f1, "w") as f:
                f.write("changed")
            bridge.restore(snap)
            with open(f1) as f:
                self.assertEqual(f.read(), "original")
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(snaproot, ignore_errors=True)

    def test_snapshot_records_absent_files_for_deletion_on_restore(self):
        root = tempfile.mkdtemp()
        snaproot = tempfile.mkdtemp()
        try:
            newf = os.path.join(root, "new.lua")  # does not exist yet
            snap = bridge.snapshot(snaproot, [newf], meta={})
            with open(newf, "w") as f:
                f.write("added by backport")
            bridge.restore(snap)
            self.assertFalse(os.path.exists(newf))  # restore removes files that were absent
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(snaproot, ignore_errors=True)
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def snapshot(snaproot, files, meta, stamp="manual"):
    """Copy each path in `files` (verbatim) into a new snapshot dir under snaproot.
    Files that don't exist are recorded as 'absent' so restore() deletes them.
    `stamp` is supplied by the caller (server passes a UTC stamp) to stay testable."""
    snap = os.path.join(snaproot, stamp)
    os.makedirs(os.path.join(snap, "files"), exist_ok=True)
    manifest = {"meta": meta, "entries": []}
    for i, src in enumerate(files):
        key = f"{i}_{os.path.basename(src)}"
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(snap, "files", key))
            manifest["entries"].append({"path": src, "stored": key, "absent": False})
        else:
            manifest["entries"].append({"path": src, "stored": None, "absent": True})
    with open(os.path.join(snap, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)
    return snap


def restore(snap):
    """Restore a snapshot dir: copy stored files back; delete files marked absent."""
    with open(os.path.join(snap, "manifest.json"), "r", encoding="utf-8") as f:
        manifest = json.load(f)
    for e in manifest["entries"]:
        if e["absent"]:
            try:
                os.remove(e["path"])
            except OSError:
                pass
        else:
            shutil.copy2(os.path.join(snap, "files", e["stored"]), e["path"])
    return True
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): snapshot + restore (handles added files via absent-marking)"
```

### Task 3.2: Prune to last N snapshots

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing test**

```python
class TestPrune(unittest.TestCase):
    def test_keeps_only_n_newest(self):
        snaproot = tempfile.mkdtemp()
        try:
            for name in ("20240101", "20240102", "20240103"):
                os.makedirs(os.path.join(snaproot, name))
            bridge.prune_snapshots(snaproot, keep=2)
            left = sorted(os.listdir(snaproot))
            self.assertEqual(left, ["20240102", "20240103"])
        finally:
            shutil.rmtree(snaproot, ignore_errors=True)
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def prune_snapshots(snaproot, keep=10):
    try:
        dirs = sorted(d for d in os.listdir(snaproot)
                      if os.path.isdir(os.path.join(snaproot, d)))
    except OSError:
        return
    for d in dirs[:-keep] if keep > 0 else dirs:
        shutil.rmtree(os.path.join(snaproot, d), ignore_errors=True)
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): prune snapshots to last N"
```

### Task 3.3: `POST /api/bridge/rollback`

**Files:** Modify `web/server.py`

- [ ] **Step 1: Add a snapshot-root constant + route** (`web/server.py`)

Near other path constants (after `CODE = …` ~line 43):

```python
BRIDGE_DATA = os.path.join(DUST, "data", "ingenue", "bridge")
SNAP_ROOT = os.path.join(BRIDGE_DATA, "snapshots")
```

In `do_POST`:

```python
            if path == "/api/bridge/rollback":
                snap = os.path.join(SNAP_ROOT, os.path.basename(b.get("snapshot", "")))
                if not os.path.isdir(snap):
                    return self._json({"error": "no such snapshot"}, 404)
                if not _busy_lock.acquire(blocking=False):
                    return self._json({"error": "another operation is running"}, 409)
                try:
                    bridge.restore(snap)
                finally:
                    _busy_lock.release()
                return self._json({"ok": True, "restored": os.path.basename(snap)})
```

- [ ] **Step 2: Smoke-test (404 path)**

Run: `cd web && INGENUE_DUST=/tmp python3 server.py 7799 & sleep 1; curl -s -X POST localhost:7799/api/bridge/rollback -d '{"snapshot":"nope"}'; kill %1`
Expected: `{"error": "no such snapshot"}` with 404.

- [ ] **Step 3: Commit**

```bash
git add web/server.py
git commit -m "feat(server): /api/bridge/rollback + snapshot paths"
```

---

## Phase 4 — Honest repair

### Task 4.1: Write `version.txt` (snapshotted, atomic)

**Files:** Modify `web/server.py` (uses `bridge.snapshot`); no new pure logic needed.

- [ ] **Step 1: Add a helper + route** (`web/server.py`)

Helper near `norns_root` (~line 425):

```python
def _utc_stamp():
    return datetime.datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")


def write_version_txt(home, target):
    """Snapshot then atomically write $home/version.txt = target. Returns snapshot dir."""
    vt = os.path.join(home, "version.txt")
    os.makedirs(SNAP_ROOT, exist_ok=True)
    snap = bridge.snapshot(SNAP_ROOT, [vt],
                           meta={"action": "repair", "target": target, "file": vt},
                           stamp=_utc_stamp())
    tmp = vt + ".ingtmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(f"{int(target):06d}\n")
    os.replace(tmp, vt)
    bridge.prune_snapshots(SNAP_ROOT)
    return snap
```

Route in `do_POST`:

```python
            if path == "/api/bridge/repair":
                home = b.get("home") or os.path.expanduser("~")
                target = int(b.get("target") or 0)
                if target <= 0:
                    return self._json({"error": "bad target"}, 400)
                if not _busy_lock.acquire(blocking=False):
                    return self._json({"error": "another operation is running"}, 409)
                try:
                    snap = write_version_txt(home, target)
                finally:
                    _busy_lock.release()
                return self._json({"ok": True, "wrote": target,
                                   "snapshot": os.path.basename(snap)})
```

- [ ] **Step 2: Smoke-test against a temp HOME**

Run: `cd web && INGENUE_DUST=/tmp python3 server.py 7799 & sleep 1; curl -s -X POST localhost:7799/api/bridge/repair -d '{"home":"/tmp/fakehome","target":231114}'; mkdir -p /tmp/fakehome; cat /tmp/fakehome/version.txt 2>/dev/null; kill %1`
Expected: first call may 400/err if dir missing; after `mkdir`, re-run → `{"ok":true,"wrote":231114}` and `version.txt` contains `231114`.

> NOTE: ensure `os.makedirs(home, exist_ok=True)` is acceptable — DO NOT create it; if
> `home` doesn't exist, return `{"error":"home not found"}`. Add that guard:

```python
                if not os.path.isdir(home):
                    return self._json({"error": "home not found"}, 400)
```

- [ ] **Step 3: Commit**

```bash
git add web/server.py
git commit -m "feat(server): /api/bridge/repair — snapshotted version.txt write"
```

---

## Phase 5 — Backport engine

### Task 5.1: Confirm + expand the `ref_map` against real norns release dates

**Files:** Modify `web/bridge_db.json`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Determine the real date→tag mapping**

Run (per candidate tag, confirm the date norns stamps for it):
```bash
for t in v2.8.3 v2.8.4 v2.9.0; do
  echo -n "$t -> "; \
  git -c advice.detachedHead=false archive --remote=https://github.com/monome/norns.git "$t" CHANGELOG.md 2>/dev/null | tar -xO 2>/dev/null | head -3
done
```
Use the CHANGELOG top entry date (YYMMDD) as the key. Record confirmed pairs only.

- [ ] **Step 2: Update `ref_map` in `bridge_db.json`** with confirmed pairs, e.g.:

```json
  "ref_map": {
    "231114": "v2.8.3",
    "240221": "v2.8.4"
  },
```

- [ ] **Step 3: Add a resolve function + tests** (`bridge.py` + `test_bridge.py`)

Test:
```python
class TestResolve(unittest.TestCase):
    def test_known(self):
        self.assertEqual(bridge.resolve_ref(231114, {"231114": "v2.8.3"}), "v2.8.3")

    def test_unknown_returns_none(self):
        self.assertIsNone(bridge.resolve_ref(999999, {"231114": "v2.8.3"}))
```
Implementation (append to `bridge.py`):
```python
def resolve_ref(required, ref_map):
    """Map a YYMMDD pin to an upstream git tag, or None if unknown."""
    return ref_map.get(f"{int(required):06d}")
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge_db.json web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): YYMMDD->tag ref resolution + confirmed ref_map entries"
```

### Task 5.2: Scan a lua diff for low-level binding references

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing tests**

```python
class TestBindingScan(unittest.TestCase):
    def setUp(self):
        self.bindings = ["_norns", "_path", "_dbg"]

    def test_detects_referenced_binding(self):
        code = "function util.foo()\n  return _norns.audio_get()\nend\n"
        self.assertEqual(bridge.scan_bindings(code, self.bindings), ["_norns"])

    def test_pure_lua_returns_empty(self):
        code = "function util.foo()\n  return clock.run\nend\n"
        self.assertEqual(bridge.scan_bindings(code, self.bindings), [])

    def test_multiple_unique_sorted(self):
        code = "_path.x() _norns.y() _norns.z()"
        self.assertEqual(bridge.scan_bindings(code, self.bindings), ["_norns", "_path"])
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def scan_bindings(code, bindings):
    """Return the sorted unique low-level binding symbols referenced in `code`.
    Matches `<sym>` as a word followed by `.` or `[` (table access) or `(`."""
    found = set()
    for sym in bindings:
        if re.search(r"\b" + re.escape(sym) + r"\s*[.\[(]", code):
            found.add(sym)
    return sorted(found)
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): scan lua for low-level C-binding references"
```

### Task 5.3: Fetch upstream lua at a ref and diff against the port tree

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py` (with a local fake "upstream" git repo)

- [ ] **Step 1: Failing test** (build a throwaway git repo as fake upstream)

```python
class TestFetchDiff(unittest.TestCase):
    def _git(self, *a, cwd):
        subprocess.run(["git", *a], cwd=cwd, check=True,
                       capture_output=True, env={**os.environ,
                       "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t",
                       "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t"})

    def test_diff_lists_added_and_changed_lua(self):
        up = tempfile.mkdtemp()
        port = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(up, "lua", "core"))
            with open(os.path.join(up, "lua", "core", "util.lua"), "w") as f:
                f.write("-- v2\nfunction util.new() end\n")
            with open(os.path.join(up, "lua", "core", "added.lua"), "w") as f:
                f.write("-- brand new\n")
            self._git("init", "-q", cwd=up)
            self._git("add", "-A", cwd=up)
            self._git("commit", "-qm", "v2", cwd=up)
            self._git("tag", "vX", cwd=up)

            os.makedirs(os.path.join(port, "lua", "core"))
            with open(os.path.join(port, "lua", "core", "util.lua"), "w") as f:
                f.write("-- v1\n")  # older content -> changed
            # added.lua absent in port -> added

            changed = bridge.fetch_and_diff_lua("file://" + up, "vX", port)
            rels = sorted(c["rel"] for c in changed)
            self.assertEqual(rels, ["lua/core/added.lua", "lua/core/util.lua"])
            self.assertTrue(all("upstream_text" in c for c in changed))
        finally:
            shutil.rmtree(up, ignore_errors=True)
            shutil.rmtree(port, ignore_errors=True)
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def fetch_and_diff_lua(upstream_url, ref, port_root, subdir="lua", timeout=180):
    """Shallow-fetch `upstream_url` at `ref`, compare its `subdir` tree against
    port_root/subdir, and return [{rel, upstream_text}] for files that are new or
    whose bytes differ. Caller is responsible for removing the temp clone via the
    returned tmpdir? -> No: we clone into a tempdir we clean here, returning only text.
    """
    import tempfile
    tmp = tempfile.mkdtemp(prefix="ing_bridge_")
    try:
        r = subprocess.run(["git", "clone", "--depth", "1", "--branch", ref,
                            upstream_url, tmp + "/up"], capture_output=True, text=True,
                           timeout=timeout)
        if r.returncode != 0:
            raise RuntimeError("clone failed: " + (r.stderr or "")[-300:])
        up_sub = os.path.join(tmp, "up", subdir)
        changed = []
        for root, _dirs, files in os.walk(up_sub):
            for f in files:
                if not f.endswith(".lua"):
                    continue
                up_path = os.path.join(root, f)
                rel = os.path.relpath(up_path, os.path.join(tmp, "up"))
                with open(up_path, "r", encoding="utf-8", errors="ignore") as fh:
                    up_text = fh.read()
                port_path = os.path.join(port_root, rel)
                try:
                    with open(port_path, "r", encoding="utf-8", errors="ignore") as fh:
                        port_text = fh.read()
                except OSError:
                    port_text = None
                if port_text != up_text:
                    changed.append({"rel": rel, "upstream_text": up_text})
        return changed
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): fetch upstream lua at ref + diff against port tree"
```

### Task 5.4: Build a backport plan (diff → scan → bindings to probe)

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing test**

```python
class TestPlan(unittest.TestCase):
    def test_plan_aggregates_bindings_across_changed_files(self):
        changed = [
            {"rel": "lua/core/util.lua", "upstream_text": "x = _norns.a()"},
            {"rel": "lua/core/clock.lua", "upstream_text": "y = _path.b()"},
            {"rel": "lua/core/pure.lua", "upstream_text": "z = clock.run"},
        ]
        plan = bridge.build_plan(changed, bindings=["_norns", "_path", "_dbg"])
        self.assertEqual(plan["bindings"], ["_norns", "_path"])
        self.assertEqual(sorted(f["rel"] for f in plan["files"]), 
                         ["lua/core/clock.lua", "lua/core/pure.lua", "lua/core/util.lua"])
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def build_plan(changed, bindings):
    """From [{rel, upstream_text}] produce {files:[…], bindings:[unique sorted]}."""
    refs = set()
    for c in changed:
        refs.update(scan_bindings(c["upstream_text"], bindings))
    return {"files": changed, "bindings": sorted(refs)}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): build backport plan (files + bindings to probe)"
```

### Task 5.5: Apply a plan's files into the port tree (snapshotted)

**Files:** Modify `web/bridge.py`; Test `web/tests/test_bridge.py`

- [ ] **Step 1: Failing test**

```python
class TestApply(unittest.TestCase):
    def test_apply_writes_files_and_returns_snapshot(self):
        port = tempfile.mkdtemp()
        snaproot = tempfile.mkdtemp()
        try:
            os.makedirs(os.path.join(port, "lua", "core"))
            with open(os.path.join(port, "lua", "core", "util.lua"), "w") as f:
                f.write("old")
            plan = {"files": [
                {"rel": "lua/core/util.lua", "upstream_text": "new util"},
                {"rel": "lua/core/added.lua", "upstream_text": "added"},
            ], "bindings": []}
            res = bridge.apply_plan(port, plan, snaproot, stamp="20240101T000000Z",
                                    meta={"action": "backport"})
            with open(os.path.join(port, "lua", "core", "util.lua")) as f:
                self.assertEqual(f.read(), "new util")
            with open(os.path.join(port, "lua", "core", "added.lua")) as f:
                self.assertEqual(f.read(), "added")
            # rollback restores: util back to 'old', added.lua removed
            bridge.restore(res["snapshot"])
            with open(os.path.join(port, "lua", "core", "util.lua")) as f:
                self.assertEqual(f.read(), "old")
            self.assertFalse(os.path.exists(os.path.join(port, "lua", "core", "added.lua")))
        finally:
            shutil.rmtree(port, ignore_errors=True)
            shutil.rmtree(snaproot, ignore_errors=True)
```

- [ ] **Step 2: Run, verify failure**

- [ ] **Step 3: Implement** (append to `bridge.py`)

```python
def apply_plan(port_root, plan, snaproot, stamp, meta):
    """Snapshot every target file, then write upstream_text into the port tree.
    On any write error, restore from the snapshot and re-raise. Returns
    {snapshot, applied:[rel,…]}."""
    targets = [os.path.join(port_root, f["rel"]) for f in plan["files"]]
    os.makedirs(snaproot, exist_ok=True)
    snap = snapshot(snaproot, targets, meta=meta, stamp=stamp)
    applied = []
    try:
        for f in plan["files"]:
            dest = os.path.join(port_root, f["rel"])
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            tmp = dest + ".ingtmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                fh.write(f["upstream_text"])
            os.replace(tmp, dest)
            applied.append(f["rel"])
    except Exception:
        restore(snap)
        raise
    return {"snapshot": snap, "applied": applied}
```

- [ ] **Step 4: Run, verify pass**

- [ ] **Step 5: Commit**

```bash
git add web/bridge.py web/tests/test_bridge.py
git commit -m "feat(bridge): apply backport plan with snapshot + auto-restore on error"
```

### Task 5.6: Backport endpoints (`plan`, `apply`, `commit`) with a prep cache

**Files:** Modify `web/server.py`

- [ ] **Step 1: Add a prep cache + the three routes** (`web/server.py`)

Near `SNAP_ROOT` constant:

```python
import tempfile
_bridge_preps = {}          # prep_token -> {"plan": …, "target_ref": …, "required": int}
_bridge_preps_lock = threading.Lock()
UPSTREAM_NORNS = "https://github.com/monome/norns.git"
```

Routes in `do_POST`:

```python
            if path == "/api/bridge/backport/plan":
                required = int(b.get("required") or 0)
                nr = b.get("norns_root") or norns_root()
                if not nr:
                    return self._json({"error": "norns tree not found"}, 400)
                db = bridge.load_db()
                ref = bridge.resolve_ref(required, db["ref_map"])
                if not ref:
                    return self._json({"error": "unknown target version", "required": required}, 422)
                try:
                    changed = bridge.fetch_and_diff_lua(UPSTREAM_NORNS, ref, nr)
                except Exception as e:  # noqa: BLE001
                    return self._json({"error": "fetch/diff failed", "detail": str(e)[:300]}, 502)
                plan = bridge.build_plan(changed, db["bindings"])
                token = os.path.basename(tempfile.mktemp(prefix="prep_"))
                with _bridge_preps_lock:
                    _bridge_preps[token] = {"plan": plan, "ref": ref,
                                            "required": required, "norns_root": nr}
                return self._json({"prep": token, "target_ref": ref,
                                   "files": [f["rel"] for f in plan["files"]],
                                   "bindings": plan["bindings"]})

            if path == "/api/bridge/backport/apply":
                token = b.get("prep", "")
                with _bridge_preps_lock:
                    prep = _bridge_preps.get(token)
                if not prep:
                    return self._json({"error": "unknown or expired prep token"}, 404)
                present = b.get("bindings_present") or {}
                missing = [s for s in prep["plan"]["bindings"] if not present.get(s)]
                if missing:
                    return self._json({"ok": False, "refused": True, "missing": missing})
                if not _busy_lock.acquire(blocking=False):
                    return self._json({"error": "another operation is running"}, 409)
                try:
                    res = bridge.apply_plan(prep["norns_root"], prep["plan"], SNAP_ROOT,
                                            stamp=_utc_stamp(),
                                            meta={"action": "backport", "ref": prep["ref"],
                                                  "required": prep["required"]})
                    bridge.prune_snapshots(SNAP_ROOT)
                finally:
                    _busy_lock.release()
                return self._json({"ok": True, "applied": res["applied"],
                                   "snapshot": os.path.basename(res["snapshot"])})

            if path == "/api/bridge/backport/commit":
                home = b.get("home") or os.path.expanduser("~")
                if not os.path.isdir(home):
                    return self._json({"error": "home not found"}, 400)
                target = int(b.get("target") or 0)
                if target <= 0:
                    return self._json({"error": "bad target"}, 400)
                if not _busy_lock.acquire(blocking=False):
                    return self._json({"error": "another operation is running"}, 409)
                try:
                    snap = write_version_txt(home, target)
                finally:
                    _busy_lock.release()
                return self._json({"ok": True, "wrote": target,
                                   "snapshot": os.path.basename(snap)})
```

- [ ] **Step 2: Smoke-test the refuse path with a hand-made prep**

Run: `cd web && INGENUE_DUST=/tmp python3 server.py 7799 & sleep 1; \
  curl -s -X POST localhost:7799/api/bridge/backport/apply -d '{"prep":"nope"}'; kill %1`
Expected: `{"error":"unknown or expired prep token"}` 404.

- [ ] **Step 3: Commit**

```bash
git add web/server.py
git commit -m "feat(server): backport plan/apply/commit endpoints + prep cache"
```

---

## Phase 6 — Client orchestration & UX (index.html)

> JS has no unit harness in this repo. Each task below is verified via (a) the mock
> layer extension (Task 6.1) in the GitHub Pages demo and (b) the on-device smoke
> checklist (Phase 8). Keep new JS in one clearly-commented block, mirroring the
> existing `/* ===== B9 live PARAMS … */` section markers.

### Task 6.1: Probe runner over the matron channel + mock support

**Files:** Modify `web/index.html`

- [ ] **Step 1: Add a bridge probe runner** (new section near the params/matron code ~line 1339)

```javascript
/* ===== version bridge ===== */
// Run one Lua boolean expression in matron, resolve true/false via sentinel.
function bridgeProbe(id, luaExpr){
  return new Promise(res=>{
    if(!matronReady){ res(false); return; }
    const tag='@@ING_BR@@'+id+'\t';
    const prev=matronOnData; let done=false;
    matronOnData=(s)=>{ if(s.indexOf(tag)>=0){ done=true; matronOnData=prev;
      res(/\ttrue\b/.test(s.slice(s.indexOf(tag)))); } else if(prev){ prev(s); } };
    matronSend("print('"+tag.replace(/'/g,"")+"'..tostring(("+luaExpr+") and true or false))");
    setTimeout(()=>{ if(!done){ matronOnData=prev; res(false); } },1500);
  });
}
// Read the live norns.version.update and $HOME in one round-trip.
function bridgeReadEnv(){
  return new Promise(res=>{
    if(!matronReady){ res({reported:0,home:''}); return; }
    const tag='@@ING_BRENV@@'; const prev=matronOnData; let done=false;
    matronOnData=(s)=>{ const i=s.indexOf(tag); if(i>=0){ done=true; matronOnData=prev;
      const parts=s.slice(i+tag.length).split('\t'); 
      res({reported:parseInt(parts[0]||'0',10)||0, home:(parts[1]||'').trim()}); }
      else if(prev){ prev(s); } };
    matronSend("print('"+tag+"'..tostring(norns.version.update)..'\\9'..tostring(os.getenv('HOME')))");
    setTimeout(()=>{ if(!done){ matronOnData=prev; res({reported:0,home:''}); } },1500);
  });
}
```

- [ ] **Step 2: Extend the mock layer** (find the b53 mock `matronSend`/device fake; add canned responses)

In the mock device block, make `matronSend` recognise the bridge sentinels and emit fake `matronOnData` lines driven by a `window.__MOCK_BRIDGE` object, e.g.:

```javascript
// in the mock: window.__MOCK_BRIDGE = {reported:0, home:'/home/we', probes:{clock_link_set_tempo:true}}
// when matronSend sees '@@ING_BR@@<id>' -> reply '<tag>'+ (probes[id]?'true':'false')
// when it sees '@@ING_BRENV@@' -> reply tag + reported + '\t' + home
```

- [ ] **Step 3: Verify in the demo**

Run: open `web/index.html` via the demo path; in console set `window.__MOCK_BRIDGE={reported:0,home:'/home/we',probes:{lattice_present:true,clock_link_set_tempo:false}}`; call `await bridgeReadEnv()` and `await bridgeProbe('lattice_present','pcall(require,"lattice")')`.
Expected: `{reported:0, home:'/home/we'}` and `true`.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat(web): bridge probe runner over matron + mock support"
```

### Task 6.2: Gate check wired into the install flow

**Files:** Modify `web/index.html`

- [ ] **Step 1: Add `bridgeGate(url)`** that fetches probes, runs them, posts the verdict

```javascript
async function bridgeComputeEffective(){
  let probes; try{ probes=await fetch('api/bridge/probes',{cache:'no-store'}).then(r=>r.json()); }
  catch(_){ return null; }
  const env=await bridgeReadEnv();
  const results={};
  for(const e of probes.fingerprint){ results[e.id]=await bridgeProbe(e.id, e.lua); }
  // effective = max(reported, highest passing fingerprint version)
  let fp=0; for(const e of probes.fingerprint){ if(results[e.id]) fp=Math.max(fp, parseInt(e.version,10)); }
  return {effective:Math.max(env.reported, fp), reported:env.reported, home:env.home,
          fingerprinted:fp, ondisk:probes.ondisk};
}
async function bridgeGate(url){
  if(!matronReady) return {case:'no_link'};
  const eff=await bridgeComputeEffective(); if(!eff) return {case:'no_link'};
  const v=await fetch('api/bridge/gate',{method:'POST',body:JSON.stringify(
    {url, effective:eff.effective, reported:eff.reported})}).then(r=>r.json());
  v._env=eff; return v;
}
```

- [ ] **Step 2: Call `bridgeGate` before the existing install kickoff**

Locate the install button handler (search `start_job`/`/api/install` call sites). Before invoking install, `const v = await bridgeGate(url);` and branch: `no_link|no_pin|compatible` → proceed as today; `false_block` → render the amber strip (Task 6.3); `genuine_gap` → open the modal (Task 6.4). Keep the change minimal and behind `if(matronReady)`.

- [ ] **Step 3: Verify in demo** with `__MOCK_BRIDGE` set to produce each case against a known script card.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat(web): run version gate before install"
```

### Task 6.3: false_block amber strip → repair & install

**Files:** Modify `web/index.html`

- [ ] **Step 1: Render an inline strip** above the install action when `case==='false_block'`:

```javascript
function renderFalseBlock(v, onProceed){
  // amber strip: "your port lost its version stamp. <name> (needs <required>) is
  // actually compatible with your norns (<effective>). repair the stamp so it'll run?"
  // button: "repair & install" -> bridgeRepair then onProceed()
}
async function bridgeRepair(v){
  // 1) persist for future boots
  await fetch('api/bridge/repair',{method:'POST',body:JSON.stringify(
    {target:v.required, home:v._env.home})});
  // 2) live-set so THIS session's gate passes immediately
  matronSend("norns.version.update = '"+String(v.required)+"'");
}
```

- [ ] **Step 2: Wire** the strip's button to `await bridgeRepair(v); onProceed();` where `onProceed` is the existing install kickoff.

- [ ] **Step 3: Verify in demo** (mock `reported:0`, a script pinned ≤ effective) → strip appears, repair POST fires, install proceeds.

- [ ] **Step 4: Commit**

```bash
git add web/index.html
git commit -m "feat(web): false_block amber strip + one-tap repair & install"
```

### Task 6.4: genuine_gap 3-way modal + risky orchestration

**Files:** Modify `web/index.html`

- [ ] **Step 1: Build the modal** (reuse existing modal CSS/markup conventions) with title stating the gap and three buttons: Cancel / Update anyway / Try risky update, plus the persistent "experimental — back up psets & samples first" line.

- [ ] **Step 2: Implement the three actions**

```javascript
async function gapUpdateAnyway(v, onProceed){
  await fetch('api/bridge/backport/commit',{method:'POST',body:JSON.stringify(
    {target:v.required, home:v._env.home})});
  matronSend("norns.version.update = '"+String(v.required)+"'");
  onProceed();
}
async function gapRisky(v, log, onProceed){
  log('Resolve…');
  const plan=await fetch('api/bridge/backport/plan',{method:'POST',body:JSON.stringify(
    {required:v.required, norns_root:v._env.ondisk.norns_root})}).then(r=>r.json());
  if(plan.error){ log('cannot: '+plan.error); return showRefuseOrErr(v, plan); }
  log('Diff ('+plan.files.length+' files) ✓  Classify…');
  const present={};
  for(const sym of plan.bindings){ present[sym]=await bridgeProbe('bind_'+sym, "_norns and "+sym+" ~= nil or "+sym+" ~= nil"); }
  const ap=await fetch('api/bridge/backport/apply',{method:'POST',body:JSON.stringify(
    {prep:plan.prep, bindings_present:present})}).then(r=>r.json());
  if(ap.refused){ return showRefuse(v, ap.missing); }       // C gap — nothing written
  if(!ap.ok){ log('apply failed: '+(ap.error||'?')); return; }
  log('Apply ✓  Verify…');
  // VERIFY: re-run fingerprint probes for the target; all that gate `required` must pass
  const probes=await fetch('api/bridge/probes',{cache:'no-store'}).then(r=>r.json());
  let ok=true;
  for(const e of probes.fingerprint){ if(parseInt(e.version,10)<=v.required){
    if(!await bridgeProbe('vfy_'+e.id, e.lua)){ ok=false; break; } } }
  if(!ok){
    await fetch('api/bridge/rollback',{method:'POST',body:JSON.stringify({snapshot:ap.snapshot})});
    return showRolledBack(v);                                // restored, offer update_anyway/cancel
  }
  await fetch('api/bridge/backport/commit',{method:'POST',body:JSON.stringify(
    {target:v.required, home:v._env.home})});
  matronSend("norns.version.update = '"+String(v.required)+"'");
  log('backported '+ap.applied.length+' files, verified, marker set. restart matron to load core changes.');
  showRollbackLink(ap.snapshot); onProceed();
}
```

- [ ] **Step 3: Result states** — implement `showRefuse(v, missing)` (lists missing bindings + Update-anyway/Cancel), `showRolledBack(v)` (which step failed + Update-anyway/Cancel), `showRollbackLink(snap)` (quiet "revert this change" → POST rollback).

- [ ] **Step 4: Verify each branch in the demo** by driving `__MOCK_BRIDGE` (all-present → applied+verify ok; one binding missing → refuse; verify-fail → rolled back). Backport `/plan` against the real upstream works only on-device/online; for the demo, add a mock `/api/bridge/*` shim returning canned plan/apply payloads.

- [ ] **Step 5: Commit**

```bash
git add web/index.html
git commit -m "feat(web): genuine_gap 3-way modal + risky backport orchestration"
```

### Task 6.5: Config read-only status line

**Files:** Modify `web/index.html`

- [ ] **Step 1: Add a status line in the config modal** (beside the existing audio/SCP health lines; search `initAudioHealth`)

```javascript
async function initBridgeStatus(){
  const el=document.getElementById('cfg-bridge'); if(!el) return;
  const eff=await bridgeComputeEffective();
  if(!eff){ el.textContent='norns version: no live link to matron'; return; }
  const src = eff.reported ? 'reported from version.txt'
            : (eff.fingerprinted ? 'fingerprinted (no version stamp on disk)'
                                 : 'undetermined');
  el.textContent = 'norns base: '+(eff.effective||'?')+' · '+src;   // NO action buttons
}
```

Add the `<div id="cfg-bridge" class="cfg-line"></div>` near the other config health lines in the config modal markup (~line 687), and call `initBridgeStatus()` where `initAudioHealth()` is called (~line 2765).

- [ ] **Step 2: Verify in demo** the line renders all three source states via `__MOCK_BRIDGE`.

- [ ] **Step 3: Commit**

```bash
git add web/index.html
git commit -m "feat(web): config read-only norns version status line"
```

---

## Phase 7 — Documentation

### Task 7.1: README "version bridge" section

**Files:** Modify `README.md`

- [ ] **Step 1: Add a section** after the existing "bonus, for the modern norns porting crowd" paragraph, covering: what version pinning is; that ports often lose `version.txt` (false blocks); the one-tap honest repair; the 3-way gate (cancel / update anyway / risky); what "risky update" *does* (auto-derives Lua-layer additions from upstream norns, verifies, snapshots for rollback) and *does not* touch (no C/matron/engine changes; honest refusal there); the "keep backups" caveat for runtime state it can't snapshot.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: README version bridge section"
```

---

## Phase 8 — On-device smoke checklist (panicos)

> Not automated. Run after deploy (`scp` + verify + restart per the deploy memory).
> Have a backup of the norns `lua/` tree before the risky tests.

- [ ] **8.1 false_block repair:** open ingenue on panicos, install dreamsequence. Expect the amber strip (port reports `000000`, dreamsequence pins `231114`, fingerprint ≥ 231114). Tap "repair & install"; confirm `~/version.txt` now holds the repaired value, the script launches, and `norns.version.update` is live-set this session.
- [ ] **8.2 genuine_gap → applied:** craft/choose a script pinning a version above the port base but whose delta is pure-Lua + in `ref_map`. Run risky update; watch Resolve→Fetch→Diff→Classify→Apply→Verify; confirm files written, verify passes, marker set, "restart matron" shown.
- [ ] **8.3 genuine_gap → refuse:** choose a target whose diff references a missing `_norns.*` binding. Confirm the honest refusal lists the binding and nothing was written (diff `lua/` tree before/after).
- [ ] **8.4 verify-fail rollback:** temporarily point a fingerprint probe at something the applied files won't satisfy; run risky update; confirm auto-rollback restores the tree and the failure state is shown.
- [ ] **8.5 manual rollback:** after 8.2, use the "revert this change" link; confirm the snapshot restores the prior `lua/` files and `version.txt`.
- [ ] **8.6 lock:** start a self-update and a backport together; confirm the second returns 409, not a corrupt half-write.

---

## Self-review notes (author)

- **Spec coverage:** version intelligence (1.1–1.4), gate incl. three cases (2.1–2.3, 6.2–6.4), honest repair separate from scary path (4.1, 6.3), auto-derive from upstream git (5.3, 5.6), C-binding safety probe + honest refusal (5.2, 5.4, 6.4 refuse branch), snapshot/rollback + auto-rollback on verify-fail (3.1–3.3, 5.5, 6.4), config read-only line (6.5), bundled `bridge_db.json` server-owned probes (0.2, 1.4), lock reuse (3.3/4.1/5.6), README (7.1), testing strategy incl. mock layer + fixtures + on-device smoke (0.1, 5.3 fake-git, 6.x demo, Phase 8). Open risks #1–#4 are reflected: ref_map curation (5.1, 422 on unknown), scan-can-be-fooled backstopped by verify (6.4), restart wording (8.2), confidence floor (1.3 `confidence`).
- **Naming consistency:** `parse_required`, `ondisk_version`, `fingerprinted_version`, `intelligence`, `classify`, `resolve_ref`, `scan_bindings`, `fetch_and_diff_lua`, `build_plan`, `apply_plan`, `snapshot`, `restore`, `prune_snapshots` are defined once and reused with the same signatures across server routes.
- **Deferred / honest gaps to watch during build:** git-describe→date mapping is intentionally NOT implemented (Task 1.2 note) — fingerprint is authoritative when `version.txt` is absent; a stale applied-but-unverified state if the browser dies mid-flow is mitigated only by the always-present snapshot + manual rollback (no server-side reconciler in this plan).
