#!/usr/bin/env python3
"""Tests for dependency detection in analyze_dir + classify_downloads.

Regression suite for two classes of over-aggressive "needs install" prompts:

  1. BUNDLED ENGINE false positive — a script that ships its own SuperCollider
     engine (e.g. pit-orchisstra carries lib/engine_rudimentssnek.sc and sets
     `engine.name = "RudimentsSnek"`) was flagged as MISSING the engine because
     self-engine detection matched the `Engine_*.sc` filename case-sensitively,
     so a lowercase `engine_*.sc` slipped through. The script then dead-ended at
     "paste its git url" for an engine that doesn't live in any other repo.

  2. WRONG-ARCH / ALREADY-PROVIDED download — a script that downloads a
     SuperCollider plugin pack (PortedPlugins-RaspberryPi.zip is 32-bit ARM) was
     offered for install even on a 64-bit (aarch64) device where scsynth can't
     load it AND the OS already provides 64-bit PortedPlugins. Installing it
     would break the engine. classify_downloads must skip those.

Hermetic: builds fixture script dirs in temp, no network, no device.
Run:  python3 deploy/test_dep_detect.py
"""
import os, sys, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "web"))
import server  # noqa: E402


def make_script(files):
    """Write {relpath: content} into a fresh temp dir, return its path."""
    d = tempfile.mkdtemp(prefix="ingenue-dep-")
    for rel, content in files.items():
        p = os.path.join(d, rel)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w") as f:
            f.write(content)
    return d


def analyze(files, name="fixture"):
    # Force a clean, empty device view so the ONLY thing that can mark an engine
    # present is the script's own bundled copy (self_engines).
    server._engine_cache = set()
    server._sc_covered_cache = set()
    d = make_script(files)
    try:
        return server.analyze_dir(d, name)
    finally:
        shutil.rmtree(d, ignore_errors=True)


PASS, FAIL = [], []


def check(cond, label):
    (PASS if cond else FAIL).append(label)
    print(("ok  " if cond else "FAIL") + "  " + label)


# ---- bundled engine detection ------------------------------------------------

def test_bundled_lowercase_engine():
    """pit-orchisstra case: lib/engine_<x>.sc (lowercase file) + engine.name."""
    rep = analyze({
        "pit-orchisstra.lua": 'engine.name = "RudimentsSnek"\n',
        "lib/engine_rudimentssnek.sc": "Engine_RudimentsSnek : CroneEngine {\n}\n",
    }, name="pit-orchisstra")
    check(rep["engines"] == ["RudimentsSnek"], "lowercase: engine.name still detected")
    check(rep["missing_engines"] == [], "lowercase: bundled engine NOT flagged missing")
    check(rep["needs_setup"] is False, "lowercase: no spurious 'needs setup'")


def test_bundled_propercase_engine():
    """Regression guard: the conventional Engine_Foo.sc must still be detected."""
    rep = analyze({
        "foo.lua": 'engine.name = "Foo"\n',
        "Engine_Foo.sc": "Engine_Foo : CroneEngine {\n}\n",
    })
    check(rep["missing_engines"] == [], "propercase: bundled engine NOT flagged missing")


def test_engine_class_in_oddly_named_file():
    """SC compiles classes by content, not filename — an Engine_Bar class in a
    file NOT named Engine_*.sc still provides the engine."""
    rep = analyze({
        "bar.lua": 'engine.name = "Bar"\n',
        "lib/weirdname.sc": "Engine_Bar : CroneEngine {\n}\n",
    })
    check(rep["missing_engines"] == [], "class-decl: engine detected from .sc body")


def test_genuinely_missing_engine_still_flagged():
    """A script that references an engine it does NOT ship and isn't installed
    must still report it missing (don't over-correct into never flagging)."""
    rep = analyze({"x.lua": 'engine.name = "TotallyAbsent"\n'})
    check(rep["missing_engines"] == ["TotallyAbsent"], "missing: real missing engine still flagged")


# ---- download classification (arch / already-provided) -----------------------

PORTED_RPI = "https://github.com/schollz/portedplugins/releases/download/v0.4.6/PortedPlugins-RaspberryPi.zip"
PORTED_A64 = "https://github.com/schollz/portedplugins/releases/download/v0.4.6/PortedPlugins-aarch64.zip"
SAMPLE_ZIP = "https://example.com/files/some-samples.zip"


def test_download_wrong_arch_skipped():
    offer, skip = server.classify_downloads([PORTED_RPI], "aarch64", set(), sc_satisfied=False)
    check(offer == [], "arch: 32-bit pack not offered on aarch64")
    check(len(skip) == 1 and "arch" in skip[0]["reason"].lower(), "arch: skip reason mentions arch")


def test_download_right_arch_on_real_norns_offered():
    """On a 32-bit norns (armv7l) the RaspberryPi pack is the CORRECT arch."""
    offer, skip = server.classify_downloads([PORTED_RPI], "armv7l", set(), sc_satisfied=False)
    check(offer == [PORTED_RPI], "arch: 32-bit pack offered on 32-bit norns")
    check(skip == [], "arch: nothing skipped on matching arch")


def test_download_non_plugin_always_offered():
    offer, skip = server.classify_downloads([SAMPLE_ZIP], "aarch64", {"FooUGen_scsynth.so"}, sc_satisfied=True)
    check(offer == [SAMPLE_ZIP], "non-plugin: sample pack always offered")
    check(skip == [], "non-plugin: never skipped")


def test_download_already_provided_skipped():
    """Correct-arch PortedPlugins pack, but the OS already provides the plugins."""
    offer, skip = server.classify_downloads([PORTED_A64], "aarch64", {"PortedPlugins_scsynth.so"}, sc_satisfied=False)
    check(offer == [], "covered: provided pack not re-offered")
    check(len(skip) == 1 and "provided" in skip[0]["reason"].lower(), "covered: skip reason mentions provided")


def test_analyze_dir_filters_wrong_arch_download():
    """End-to-end: a script whose only setup is a wrong-arch plugin download
    should not be flagged as needing setup on aarch64."""
    if server.ARCH_ELF.get(os.uname().machine) != "aarch64":
        print("skip  analyze_dir arch filter (not on aarch64 host)")
        return
    rep = analyze({"d.lua": f'-- downloads {PORTED_RPI}\nos.execute("curl {PORTED_RPI}")\n'})
    check(PORTED_RPI not in rep["downloads"], "e2e: wrong-arch download filtered from offer")


def main():
    for fn in sorted(g for g in globals() if g.startswith("test_")):
        globals()[fn]()
    print(f"\n{len(PASS)} passed, {len(FAIL)} failed")
    sys.exit(1 if FAIL else 0)


if __name__ == "__main__":
    main()
