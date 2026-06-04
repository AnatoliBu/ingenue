#!/usr/bin/env python3
"""
ingenue backend — serves the web app AND a device API over the real norns dust tree.
Portable: discovers dust relative to itself, so it works on ANY norns (not just this port).

Install layout (norns mod):  dust/code/ingenue/{index.html, *.json, server.py, lib/mod.lua}
=> dust is two levels up from here. Override with INGENUE_DUST if needed.

  python3 server.py [PORT]            # default 7777

API (confined to the dust tree):
  GET  /api/installed                 -> ["awake", ...]            (dirs in dust/code)
  GET  /api/ls?path=code/awake        -> [{name,type,size,mod},...]
  GET  /api/read?path=...             -> raw text
  PUT  /api/write?path=...            -> {ok:true}                 (body = content)
  POST /api/install  {name,url,force} -> git clone url into dust/code/name
  POST /api/remove   {name}           -> delete dust/code/name
"""
import http.server, socketserver, os, sys, json, re, shutil, subprocess, urllib.parse, urllib.request, datetime

HERE = os.path.dirname(os.path.abspath(__file__))


def find_dust():
    env = os.environ.get("INGENUE_DUST")
    if env and os.path.isdir(os.path.join(env, "code")):
        return os.path.realpath(env)
    up = os.path.realpath(os.path.join(HERE, "..", ".."))      # dust/code/ingenue -> dust
    if os.path.isdir(os.path.join(up, "code")):
        return up
    for d in (os.path.expanduser("~/dust"), "/home/we/dust",
              "/storage/roms/ports/norns/data/dust"):
        if os.path.isdir(os.path.join(d, "code")):
            return os.path.realpath(d)
    return up


DUST = find_dust()
CODE = os.path.join(DUST, "code")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7777


def safe(rel):
    rel = urllib.parse.unquote(rel or "").lstrip("/")
    full = os.path.realpath(os.path.join(DUST, rel))
    root = os.path.realpath(DUST)
    if full != root and not full.startswith(root + os.sep):
        raise ValueError("path escapes dust")
    return full


def safe_script_dir(name):
    name = (name or "").strip().strip("/")
    if not name or "/" in name or name in (".", ".."):
        raise ValueError("bad script name")
    full = os.path.realpath(os.path.join(CODE, name))
    if os.path.dirname(full) != os.path.realpath(CODE):
        raise ValueError("script escapes dust/code")
    return full, name


def ensure_home_dust():
    """Many scripts' install.sh hardcode /home/we/dust. On ports where dust lives
    elsewhere, symlink it so those installers work — a general port patch."""
    hw = "/home/we/dust"
    if os.path.exists(hw) or os.path.realpath(DUST) == os.path.realpath(hw):
        return ""
    try:
        os.makedirs("/home/we", exist_ok=True)
        os.symlink(os.path.realpath(DUST), hw)
        return f"port patch: symlinked {hw} -> {DUST}\n"
    except OSError as e:
        return f"warn: could not create {hw} symlink: {e}\n"


def run_install(full):
    """Interpret a script's lib/install.sh ourselves so it works on ANY port:
    downloads + tar extracts run in Python (native gzip/xz, no BusyBox-tar / GNU-tar
    differences), /home/we/dust is translated to the real dust, and other commands
    (builds, etc.) fall back to the shell."""
    import shlex, tarfile, zipfile
    inst = os.path.join(full, "lib", "install.sh")
    log = []
    pp = ensure_home_dust().strip()
    if pp:
        log.append(pp)
    cwd = full
    ok = True
    for raw in open(inst, "r", errors="ignore"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.replace("/home/we/dust", DUST)
        try:
            if line.startswith("echo "):
                log.append(line[5:].strip().strip('"').strip("'"))
            elif line.startswith("cd "):
                d = line[3:].strip()
                cwd = d if os.path.isabs(d) else os.path.normpath(os.path.join(cwd, d))
                os.makedirs(cwd, exist_ok=True)
            elif re.search(r"\b(wget|curl)\b", line) and re.search(r"https?://", line):
                url = re.search(r"(https?://\S+)", line).group(1).rstrip("\"'")
                om = re.search(r"-[oO]\s+(\S+)", line)
                out = om.group(1) if om else os.path.basename(url.split("?")[0])
                dest = os.path.join(cwd, out)
                urllib.request.urlretrieve(url, dest)
                log.append(f"downloaded {out} ({os.path.getsize(dest)} bytes)")
            elif line.startswith("tar "):
                fm = re.search(r"(\S+\.(?:tar\.gz|tgz|tar\.xz|tar|zip))\b", line)
                if fm:
                    p = fm.group(1)
                    p = p if os.path.isabs(p) else os.path.join(cwd, p)
                    if p.endswith(".zip"):
                        with zipfile.ZipFile(p) as z: z.extractall(cwd)
                    else:
                        with tarfile.open(p) as t: t.extractall(cwd)
                    log.append(f"extracted {os.path.basename(p)}")
            elif line.startswith("rm "):
                for f in shlex.split(line)[1:]:
                    if not f.startswith("-"):
                        try: os.remove(f if os.path.isabs(f) else os.path.join(cwd, f))
                        except OSError: pass
            elif line.startswith("mkdir"):
                for d in shlex.split(line)[1:]:
                    if not d.startswith("-"):
                        os.makedirs(d if os.path.isabs(d) else os.path.join(cwd, d), exist_ok=True)
            else:
                r = subprocess.run(line, shell=True, cwd=cwd, capture_output=True, text=True, timeout=900)
                if r.returncode != 0:
                    ok = False
                    log.append(f"$ {line}\n  ! exit {r.returncode}: {(r.stderr or r.stdout).strip()[-200:]}")
                elif r.stdout.strip():
                    log.append(f"$ {line}\n  {r.stdout.strip()[-200:]}")
        except Exception as e:  # noqa: BLE001
            ok = False
            log.append(f"! {line[:60]} -> {e}")
    return ok, "\n".join(log)


def analyze_script(name):
    """Scan an INSTALLED script for its dependency surface."""
    full, name = safe_script_dir(name)
    if not os.path.isdir(full):
        raise ValueError("not installed")
    return analyze_dir(full, name)


def analyze_remote(url):
    """Shallow-clone a repo to a temp dir, analyze, clean up — for tracing un-installed deps."""
    import tempfile
    tmp = tempfile.mkdtemp(prefix="ing_dep_")
    target = os.path.join(tmp, "s")
    try:
        r = subprocess.run(["git", "clone", "--depth", "1", url, target],
                           capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return {"error": "clone failed", "log": (r.stderr or "")[-300:]}
        return analyze_dir(target, re.sub(r"\.git$", "", os.path.basename(url.rstrip("/"))))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def analyze_dir(full, name):
    texts, files = [], []
    for root, dirs, fs in os.walk(full):
        if ".git" in root:
            continue
        for f in fs:
            rel = os.path.relpath(os.path.join(root, f), full)
            files.append(rel)
            if f.endswith((".lua", ".sh", ".sc")):
                try:
                    with open(os.path.join(root, f), "r", encoding="utf-8", errors="ignore") as fh:
                        texts.append(fh.read())
                except OSError:
                    pass
    blob = "\n".join(texts)
    urls = re.findall(r"https?://[^\s'\")]+", blob)
    downloads = sorted(set(u for u in urls
                           if re.search(r"\.(tar\.gz|tgz|zip|tar\.xz)|/releases/download/|archive\.org", u)))
    sc_ext = sorted(set(re.findall(r"([A-Za-z0-9_]+_scsynth\.so)", blob)))
    reqs = sorted(set(r for r in re.findall(r"require[\s(]+['\"]([A-Za-z0-9_]+)/lib", blob)
                      if r not in (name, "core")))
    native = []
    if any(f.endswith("go.mod") for f in files): native.append("go")
    if any(f.endswith("Makefile") for f in files): native.append("make")
    if re.search(r"\baubio|aubiogo", blob): native.append("aubio")
    if re.search(r"soxgo|\bsox\b", blob): native.append("sox")
    if re.search(r"audiowaveform", blob): native.append("audiowaveform")
    rep = {
        "name": name,
        "install_script": any(f.endswith("install.sh") for f in files),
        "downloads": downloads[:12],
        "sc_extensions": sc_ext,
        "needs_sc_ext": bool(sc_ext) or "Extensions/" in blob,
        "requires_scripts": reqs,
        "nb": bool(re.search(r"require[\s(]+['\"]nb/|/nb/lib|nb_voice|nb:add", blob)),
        "native": sorted(set(native)),
    }
    rep["needs_setup"] = bool(rep["install_script"] or rep["downloads"] or rep["needs_sc_ext"]
                              or rep["nb"] or rep["requires_scripts"])
    return rep


def listing(full):
    out = []
    for name in sorted(os.listdir(full)):
        p = os.path.join(full, name)
        try:
            st = os.stat(p)
            out.append({"name": name, "type": "dir" if os.path.isdir(p) else "file",
                        "size": st.st_size, "mod": datetime.date.fromtimestamp(st.st_mtime).isoformat()})
        except OSError:
            pass
    return out


# ---------------------------------------------------------------------------
# SuperCollider UGen plugin health (the "silent engine on 64-bit norns" class)
# ---------------------------------------------------------------------------
# Community SC UGen plugins ship as precompiled 32-bit ARM .so. On a 64-bit
# (aarch64) port scsynth silently rejects wrong-arch .so, so engine *classes*
# load but their UGens are "not installed" -> SynthDefs fail -> script is silent.
# ingenue ships matching 64-bit binaries (web/vendor) and, if it detects a
# 64-bit host missing/half-installed UGens, offers to drop them where scsynth
# scans. .so (server) need NOT sit next to .sc (lang) -> we install binary-only
# (no duplicate-class breakage). Always recommend a FULL DEVICE REBOOT after.

ELF_MACHINE = {0x28: "arm", 0xB7: "aarch64", 0x3E: "x86_64", 0x103: "loongarch"}
# host arch (uname) -> the ELF e_machine that scsynth here can actually load
ARCH_ELF = {"aarch64": "aarch64", "arm64": "aarch64", "x86_64": "x86_64", "amd64": "x86_64"}


def elf_arch(path):
    """('64','aarch64') etc. from an ELF header, or None if not an ELF."""
    try:
        with open(path, "rb") as f:
            h = f.read(20)
    except OSError:
        return None
    if len(h) < 20 or h[:4] != b"\x7fELF":
        return None
    bits = "64" if h[4] == 2 else "32"
    little = h[5] == 1
    e_machine = int.from_bytes(h[18:20], "little" if little else "big")
    return bits, ELF_MACHINE.get(e_machine, f"machine:0x{e_machine:x}")


def host_arch():
    m = os.uname().machine
    return m, m in ("aarch64", "arm64", "x86_64", "amd64")


def sc_ext_dirs():
    """Existing SuperCollider Extensions dirs scsynth may scan (system first)."""
    cands = ["/usr/share/SuperCollider/Extensions",
             "/usr/local/share/SuperCollider/Extensions",
             os.path.expanduser("~/.local/share/SuperCollider/Extensions")]
    # norns process HOME variants (port may set HOME elsewhere)
    for h in (os.environ.get("HOME"), os.path.join(DUST, "..")):
        if h:
            cands.append(os.path.join(os.path.realpath(h), ".local/share/SuperCollider/Extensions"))
    seen, out = set(), []
    for d in cands:
        rd = os.path.realpath(d)
        if rd not in seen and os.path.isdir(rd):
            seen.add(rd); out.append(rd)
    return out


def bundle_path():
    import glob
    g = sorted(glob.glob(os.path.join(HERE, "vendor", "sc-plugins-arm64-*.tar.gz")))
    return g[-1] if g else None


def bundle_info():
    import tarfile
    p = bundle_path()
    if not p:
        return {"present": False, "so_names": []}
    m = re.search(r"-(v[\d.]+)\.tar\.gz$", os.path.basename(p))
    names = []
    try:
        with tarfile.open(p, "r:gz") as tf:
            names = sorted({os.path.basename(n) for n in tf.getnames() if n.endswith(".so")})
    except Exception:  # noqa: BLE001
        pass
    return {"present": True, "path": p, "version": m.group(1) if m else "?",
            "elf": "aarch64", "so_count": len(names), "so_names": names}


def _so_basenames_in_ext_dirs():
    """{basename: arch_machine} for every .so under the Extensions dirs."""
    found = {}
    for d in sc_ext_dirs():
        for root, _dirs, files in os.walk(d):
            for f in files:
                if f.endswith(".so"):
                    a = elf_arch(os.path.join(root, f))
                    if a:
                        found.setdefault(f, a[1])  # first/system copy wins
    return found


def scplugins_status():
    machine, is64 = host_arch()
    binf = bundle_info()
    want_elf = ARCH_ELF.get(machine)                       # what scsynth here loads
    present = _so_basenames_in_ext_dirs()
    right = {n: a for n, a in present.items() if a == want_elf}
    wrong = {n: a for n, a in present.items() if a != want_elf}
    # "half-implemented": plugin .sc classes present (e.g. PanicOS ships PortedPlugins
    # classes) but no/too-few correct-arch binaries to back them.
    PLUGIN_HINT = re.compile(r"ported|ugens|plugins|f0plugins|mi-?ugens", re.I)
    classes = 0
    for d in sc_ext_dirs():
        for root, _dirs, files in os.walk(d):
            if PLUGIN_HINT.search(root):
                classes += sum(1 for f in files if f.endswith(".sc"))
    bundled_can_fix = binf.get("present") and binf.get("elf") == want_elf
    # measure the gap against exactly what we can supply: bundled UGens that have
    # no correct-arch copy present yet (wrong-arch copies don't count as present).
    bundled_names = set(binf.get("so_names") or [])
    right_names = set(right)
    missing = sorted(bundled_names - right_names) if bundled_names else []
    if not is64:
        status = "unsupported_arch"      # 32-bit host: stock plugins are fine
    elif not bundled_can_fix:
        status = "no_bundle"              # 64-bit but we ship no matching arch
    elif len(missing) > 2:
        status = "needs_install"          # enough bundled UGens are missing to matter
    else:
        status = "ok"                     # binaries are in place + correct arch
    return {
        "host_arch": machine, "is_64bit": is64, "scsynth_wants": want_elf,
        "ugen_so_total": len(present), "ugen_so_correct_arch": len(right),
        "ugen_so_wrong_arch": len(wrong), "wrong_arch_machines": sorted(set(wrong.values())),
        "bundled_total": len(bundled_names), "missing_count": len(missing),
        "missing_sample": missing[:8],
        "half_implemented": bool(classes and len(missing) > 5 and is64),
        "bundle": {k: v for k, v in binf.items() if k != "so_names"},
        "status": status, "can_heal": status == "needs_install", "reboot_required": True,
    }


def scplugins_online_version():
    """Best-effort newest release tag of the upstream aarch64 repo (short timeout)."""
    try:
        req = urllib.request.Request(
            "https://api.github.com/repos/seajaysec/sc-plugins-arm64/releases/latest",
            headers={"User-Agent": "ingenue"})
        with urllib.request.urlopen(req, timeout=5) as r:
            j = json.loads(r.read())
        tag = j.get("tag_name")
        asset = next((a["browser_download_url"] for a in j.get("assets", [])
                      if a["name"].endswith(".tar.gz")), None)
        return {"version": tag, "url": asset} if tag and asset else None
    except Exception:  # noqa: BLE001 — offline is fine, we fall back to bundled
        return None


def scplugins_heal(source="bundled", url=""):
    """Install correct-arch UGen .so (binary-only) where scsynth scans. Idempotent."""
    import tempfile, tarfile, glob
    machine, is64 = host_arch()
    want_elf = ARCH_ELF.get(machine)
    if not is64 or not want_elf:
        return {"ok": False, "error": f"host arch {machine} is not a supported 64-bit target"}
    dirs = sc_ext_dirs()
    if not dirs:
        return {"ok": False, "error": "no SuperCollider Extensions dir found on this system"}
    # choose the first writable scanned dir (system preferred), else create user dir
    target_root = next((d for d in dirs if os.access(d, os.W_OK)), None)
    if not target_root:
        target_root = os.path.expanduser("~/.local/share/SuperCollider/Extensions")
        os.makedirs(target_root, exist_ok=True)
    target = os.path.join(target_root, "ingenue-ugens")     # binary-only dir, no .sc
    os.makedirs(target, exist_ok=True)
    already = {n for n, a in _so_basenames_in_ext_dirs().items() if a == want_elf}

    tmp = tempfile.mkdtemp(prefix="ing_ugen_")
    log = []
    try:
        if source == "online":
            if not url.startswith("https://"):
                return {"ok": False, "error": "online heal needs a release url"}
            tgz = os.path.join(tmp, "pack.tar.gz")
            urllib.request.urlretrieve(url, tgz)
            log.append(f"downloaded {url}")
        else:
            tgz = bundle_path()
            if not tgz:
                return {"ok": False, "error": "no bundled plugin pack found in vendor/"}
            log.append(f"using bundled {os.path.basename(tgz)}")
        with tarfile.open(tgz, "r:gz") as tf:
            tf.extractall(tmp)                               # nosec: our own bundle
        installed, skipped, badarch = [], [], []
        for so in glob.glob(os.path.join(tmp, "**", "*.so"), recursive=True):
            name = os.path.basename(so)
            a = elf_arch(so)
            if not a or a[1] != want_elf:
                badarch.append(name); continue
            if name in already:
                skipped.append(name); continue              # correct-arch copy already loadable
            shutil.copy2(so, os.path.join(target, name))
            installed.append(name)
        log.append(f"installed {len(installed)} .so -> {target}")
        if skipped:
            log.append(f"skipped {len(skipped)} already-correct (e.g. {', '.join(sorted(skipped)[:3])})")
        if badarch:
            log.append(f"ignored {len(badarch)} non-{want_elf} binaries in pack")
        return {"ok": bool(installed) or bool(skipped), "installed": sorted(installed),
                "skipped": sorted(skipped), "dir": target,
                "count": len(installed), "reboot_required": True, "log": "\n".join(log)}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---------------------------------------------------------------------------
# Audio-server health (B10) — jack/scsynth state + the hw:0 handoff race
# ---------------------------------------------------------------------------
def norns_log_path():
    for p in (os.path.join(DUST, "..", "..", "logs", "norns.log"),
              os.path.expanduser("~/.local/share/norns/norns.log"),
              os.path.join(DUST, "..", "log", "norns.log")):
        rp = os.path.realpath(p)
        if os.path.isfile(rp):
            return rp
    return None


def proc_pid(name):
    for d in os.listdir("/proc"):
        if not d.isdigit():
            continue
        try:
            with open(f"/proc/{d}/comm") as f:
                if f.read().strip() == name:
                    return int(d)
        except OSError:
            continue
    return None


def tail_text(path, nbytes=20000):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            sz = f.tell()
            f.seek(max(0, sz - nbytes))
            return f.read().decode("utf-8", "replace")
    except OSError:
        return ""


def audio_status():
    procs = {n: proc_pid(n) for n in ("jackd", "crone", "scsynth", "sclang", "matron")}
    log = norns_log_path()
    tail = tail_text(log) if log else ""
    race = bool(re.search(r'playback device "hw:\d" is already in use|JackServer::Open failed', tail))
    quits = "JackTemporaryException : now quits" in tail
    core_up = bool(procs["jackd"] and procs["scsynth"] and procs["crone"])
    return {
        "procs": procs, "core_up": core_up,
        "recent_device_race": race, "recent_jack_quit": quits,
        "ok": core_up and not (race and not procs["scsynth"]),
        "log": os.path.basename(log) if log else None,
        "hint": ("audio server looks healthy" if core_up else
                 "audio server is down — jack couldn't hold the sound device; a full power-cycle is the reliable fix"),
    }


def audio_restart():
    # Best-effort. No norns service exists on PortMaster-style ports, so a clean
    # restart usually means a power-cycle; we try the safe options and report.
    for cmd in ("systemctl restart norns", "systemctl restart norns-jack",
                "sv restart norns"):
        try:
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=20)
            if r.returncode == 0:
                return {"ok": True, "method": cmd, "reboot_required": False,
                        "log": f"ran: {cmd}"}
        except Exception:  # noqa: BLE001
            continue
    return {"ok": False, "reboot_required": True,
            "error": "no safe auto-restart on this port",
            "hint": "power-cycle the whole device — jack only cleanly re-grabs the sound card at boot"}


# ---------------------------------------------------------------------------
# Mods manager (B8) — list dust/code/*/lib/mod.lua + the enabled-state file
# ---------------------------------------------------------------------------
def mods_state_file():
    return os.path.join(DUST, "data", "system.mods")


def read_enabled_mods():
    try:
        with open(mods_state_file()) as f:
            return re.findall(r'"([^"]+)"', f.read())
    except OSError:
        return []


def write_enabled_mods(names):
    body = "return {\n{\n" + "".join(f'   "{n}",\n' for n in names) + "},\n}\n"
    os.makedirs(os.path.dirname(mods_state_file()), exist_ok=True)
    with open(mods_state_file(), "w") as f:
        f.write(body)


def list_mods():
    enabled = set(read_enabled_mods())
    out = []
    for name in sorted(os.listdir(CODE)):
        if name.startswith("."):
            continue
        if os.path.isfile(os.path.join(CODE, name, "lib", "mod.lua")):
            out.append({"name": name, "enabled": name in enabled, "self": name == "ingenue"})
    return {"mods": out, "enabled": sorted(enabled),
            "state_file": os.path.relpath(mods_state_file(), DUST)}


def toggle_mod(name, on):
    name = (name or "").strip()
    if not name or "/" in name:
        return {"error": "bad mod name"}
    if not os.path.isfile(os.path.join(CODE, name, "lib", "mod.lua")):
        return {"error": f"{name} is not a mod (no lib/mod.lua)"}
    enabled = read_enabled_mods()
    was = name in enabled
    if on and not was:
        enabled.append(name)
    elif not on and was:
        enabled = [m for m in enabled if m != name]
    write_enabled_mods(enabled)
    return {"ok": True, "name": name, "enabled": on,
            "restart_required": bool(on) and not was,   # enabling a previously-off mod needs a restart
            "mods": list_mods()["mods"]}


# ---------------------------------------------------------------------------
# README + images (B5) — pulled from the script's GitHub repo, best-effort
# ---------------------------------------------------------------------------
def _gh_owner_repo(url):
    m = re.search(r"github\.com[:/]+([^/]+)/([^/.]+)", url or "")
    return (m.group(1), m.group(2)) if m else (None, None)


def fetch_readme(url):
    owner, repo = _gh_owner_repo(url)
    if not owner:
        return {"error": "not a github url"}
    try:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repo}/readme",
            headers={"User-Agent": "ingenue", "Accept": "application/vnd.github.raw"})
        with urllib.request.urlopen(req, timeout=8) as r:
            raw_base = r.headers.get("X-Ingenue", "")  # unused; placeholder
            md = r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return {"error": f"no README ({e.__class__.__name__})", "images": [], "text": ""}
    # raw base for resolving relative image paths (try main then master)
    base_main = f"https://raw.githubusercontent.com/{owner}/{repo}/main/"
    imgs = []
    for m in re.findall(r'!\[[^\]]*\]\(([^)\s]+)', md) + re.findall(r'<img[^>]+src=["\']([^"\']+)', md):
        u = m.strip()
        if u.startswith("http"):
            imgs.append(u)
        elif not u.startswith("data:"):
            imgs.append(base_main + u.lstrip("./"))
    # description = first non-heading, non-image prose paragraph
    desc = ""
    for para in re.split(r"\n\s*\n", md):
        s = re.sub(r"`{1,3}", "", para).strip()
        if s and not s.startswith(("#", "!", "<", "|", "-", "*", "[![")) and len(s) > 30:
            desc = re.sub(r"\s+", " ", s)[:600]
            break
    seen, uniq = set(), []
    for u in imgs:
        if u not in seen and re.search(r"\.(png|jpe?g|gif|webp)(\?|$)", u, re.I):
            seen.add(u); uniq.append(u)
    return {"owner": owner, "repo": repo, "text": desc, "images": uniq[:12]}


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=HERE, **k)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def _q(self):
        return urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

    def _body(self):
        n = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(n) if n else b""
        try:
            return json.loads(raw or b"{}")
        except Exception:
            return {"_raw": raw}

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path
        try:
            if path == "/api/installed":
                return self._json(sorted(d for d in os.listdir(CODE)
                                         if os.path.isdir(os.path.join(CODE, d))
                                         and not d.startswith(".") and d != "ingenue"))
            if path == "/api/deps":
                q = self._q(); url = q.get("url", [""])[0]
                return self._json(analyze_remote(url) if url else analyze_script(q.get("name", [""])[0]))
            if path == "/api/scplugins":
                rep = scplugins_status()
                if self._q().get("online", ["0"])[0] == "1":   # opt-in network check
                    rep["online"] = scplugins_online_version()
                return self._json(rep)
            if path == "/api/audio":
                return self._json(audio_status())
            if path == "/api/mods":
                return self._json(list_mods())
            if path == "/api/readme":
                return self._json(fetch_readme(self._q().get("url", [""])[0]))
            if path == "/api/ls":
                return self._json(listing(safe(self._q().get("path", [""])[0])))
            if path == "/api/read":
                with open(safe(self._q().get("path", [""])[0]), "r", encoding="utf-8", errors="replace") as f:
                    body = f.read().encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/plain; charset=utf-8")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
        except (ValueError, FileNotFoundError, NotADirectoryError) as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)
        return super().do_GET()

    def do_PUT(self):
        if urllib.parse.urlparse(self.path).path != "/api/write":
            return self._json({"error": "not found"}, 404)
        try:
            full = safe(self._q().get("path", [""])[0])
            data = self._body().get("_raw", b"")
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "wb") as f:
                f.write(data)
            return self._json({"ok": True, "bytes": len(data)})
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path
        b = self._body()
        try:
            if path == "/api/remove":
                full, name = safe_script_dir(b.get("name"))
                if not os.path.isdir(full):
                    return self._json({"error": f"{name} is not installed"}, 404)
                shutil.rmtree(full)
                return self._json({"ok": True, "removed": name})
            if path == "/api/scplugins/heal":
                return self._json(scplugins_heal(b.get("source", "bundled"), (b.get("url") or "").strip()))
            if path == "/api/audio/restart":
                return self._json(audio_restart())
            if path == "/api/mods/toggle":
                return self._json(toggle_mod(b.get("name"), bool(b.get("on"))))
            if path == "/api/heal":
                full, name = safe_script_dir(b.get("name"))
                inst = os.path.join(full, "lib", "install.sh")
                if not os.path.isfile(inst):
                    return self._json({"error": f"{name} has no lib/install.sh to run"}, 404)
                ok, log = run_install(full)         # interpret install.sh ourselves (port-proof downloads/extracts)
                return self._json({"ok": ok, "name": name, "log": log[-2000:]})
            if path == "/api/install":
                full, name = safe_script_dir(b.get("name"))
                url = (b.get("url") or "").strip()
                if not url.startswith(("http://", "https://", "git@")):
                    return self._json({"error": "no/invalid git url"}, 400)
                if os.path.isdir(full):
                    if b.get("force"):
                        shutil.rmtree(full)
                    else:
                        return self._json({"error": f"{name} already installed"}, 409)
                r = subprocess.run(["git", "clone", "--depth", "1", url, full],
                                   capture_output=True, text=True, timeout=180)
                if r.returncode != 0:
                    return self._json({"error": "git clone failed", "log": (r.stderr or r.stdout)[-800:]}, 500)
                return self._json({"ok": True, "installed": name,
                                   "log": (r.stderr or r.stdout)[-400:] or f"cloned {url}"})
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except subprocess.TimeoutExpired:
            return self._json({"error": "git clone timed out"}, 504)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)
        return self._json({"error": "not found"}, 404)

    def log_message(self, *a):
        pass


socketserver.ThreadingTCPServer.allow_reuse_address = True
with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), H) as httpd:
    print(f"ingenue backend on 0.0.0.0:{PORT}  (dust={DUST}, exists={os.path.isdir(CODE)})", flush=True)
    httpd.serve_forever()
