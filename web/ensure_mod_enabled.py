#!/usr/bin/env python3
"""Idempotently enable a norns mod in dust/data/system.mods.

The file is the simple string-array format emitted by tabutil.save(). Keeping
this helper separate makes install-time mutation testable without importing the
large Ingenue backend.
"""
import json
import os
import re
import sys

_STRING_LINE = re.compile(r'^\s*"((?:[^"\\]|\\.)*)",\s*$')


def parse_mods(text):
    mods = []
    for line in (text or "").splitlines():
        match = _STRING_LINE.match(line)
        if not match:
            continue
        try:
            value = json.loads('"' + match.group(1) + '"')
        except ValueError:
            continue
        if value not in mods:
            mods.append(value)
    return mods


def serialize_mods(mods):
    lines = ["return {", "-- Table: {1}", "{"]
    for name in mods:
        lines.append("   " + json.dumps(str(name), ensure_ascii=False) + ",")
    lines.extend(["},", "}"])
    return "\n".join(lines)


def ensure_enabled(path, name):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            before = handle.read()
    except OSError:
        before = ""
    mods = parse_mods(before)
    if name in mods:
        return False, mods
    mods.append(name)
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    temporary = path + ".ingenue.tmp"
    with open(temporary, "w", encoding="utf-8") as handle:
        handle.write(serialize_mods(mods))
    os.replace(temporary, path)
    return True, mods


def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 2:
        raise SystemExit("usage: ensure_mod_enabled.py PATH MOD_NAME")
    changed, mods = ensure_enabled(args[0], args[1])
    print("enabled {} ({})".format(args[1], ", ".join(mods)) if changed else
          "{} already enabled".format(args[1]))


if __name__ == "__main__":
    main()
