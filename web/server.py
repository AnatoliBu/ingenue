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
import http.server, socketserver, os, sys, json, re, shutil, subprocess, threading, urllib.parse, urllib.request, datetime, pwd, time

HERE = os.path.dirname(os.path.abspath(__file__))


def find_dust():
    env = os.environ.get("INGENUE_DUST")
    if env and os.path.isdir(os.path.join(env, "code")):
        return os.path.realpath(env)
    # climb parents looking for the dust signature (a dir with code/ AND audio/) —
    # works whether we live at dust/code/ingenue/ (installer) or dust/code/ingenue/web/ (;install)
    d = HERE
    for _ in range(6):
        if os.path.isdir(os.path.join(d, "code")) and os.path.isdir(os.path.join(d, "audio")):
            return os.path.realpath(d)
        d = os.path.dirname(d)
    for cand in (os.path.expanduser("~/dust"), "/home/we/dust",
                 "/storage/roms/ports/norns/data/dust"):
        if os.path.isdir(os.path.join(cand, "code")):
            return os.path.realpath(cand)
    return os.path.realpath(os.path.join(HERE, "..", ".."))


DUST = find_dust()
CODE = os.path.join(DUST, "code")
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 7777
HERE = os.path.dirname(os.path.realpath(__file__))   # where server.py / install.sh live


def installed_sha():
    """The commit ingenue was installed from (written by install.sh into .version).
    Used by the in-app update check to compare against github main."""
    try:
        with open(os.path.join(HERE, ".version"), encoding="utf-8") as f:
            return f.read().strip()
    except Exception:
        return ""


# ---------------------------------------------------------------------------
# Script ownership — install as the dust owner, not as root
# ---------------------------------------------------------------------------
# Real norns runs everything as `we` (uid 1000); maiden, matron, even SuperCollider.
# If ingenue is launched as root (e.g. an old systemd unit, or a launcher that
# didn't drop privs), then `git clone` and the script's install.sh end up making
# root-owned files in dust/code/<script>/ — and maiden (running as `we`) then
# fails to manage them: `unlinkat … permission denied`, "Remove" silently leaves
# files behind, the script becomes un-editable from maiden.
#
# Fix: every subprocess that *creates* files in dust/code drops to the user who
# owns dust/code (typically `we`). Operations that need root (sclang_conf.yaml
# writes, scsynth Extensions installs, systemctl restart) keep root.
#
# We use preexec_fn (which runs after fork(), before exec()) to setuid in the
# child. That's the smallest correct change: ingenue itself can keep its root
# powers for the heal endpoints that need them, while clones/installers run
# under the right uid from the start (no chown race window).
_target_owner_cache = None


def target_owner():
    """The (uid, gid, name, home) scripts in dust/code SHOULD belong to. Computed
    from dust/code's own ownership (the canonical source — whatever user owns
    dust/code is whoever runs the rest of norns), falling back to `we`, falling
    back to the current process. Cached for the life of the server."""
    global _target_owner_cache
    if _target_owner_cache is not None:
        return _target_owner_cache
    uid = gid = None
    name = home = None
    try:
        st = os.stat(CODE)
        if st.st_uid != 0:                    # dust owned by a real user
            uid, gid = st.st_uid, st.st_gid
            try:
                p = pwd.getpwuid(uid)
                name, home = p.pw_name, p.pw_dir
            except KeyError:
                name = str(uid)
    except OSError:
        pass
    if uid is None:                           # dust missing / root-owned -> try we
        try:
            p = pwd.getpwnam("we")
            uid, gid, name, home = p.pw_uid, p.pw_gid, p.pw_name, p.pw_dir
        except KeyError:
            pass
    if uid is None:                           # last resort: ourselves
        uid, gid = os.getuid(), os.getgid()
        try:
            p = pwd.getpwuid(uid)
            name, home = p.pw_name, p.pw_dir
        except KeyError:
            name = str(uid); home = os.environ.get("HOME", "/")
    _target_owner_cache = (uid, gid, name, home or os.environ.get("HOME", "/"))
    return _target_owner_cache


def _drop_privs_to(uid, gid):
    """preexec_fn factory — drop supplementary groups, setgid, setuid in the
    forked child before exec. Silently no-ops if we lack the privilege (the
    parent isn't root); ordering matters because setuid eats the cap to setgid."""
    def _do():
        try: os.setgroups([])     # drop supplementary groups; ignore if not root
        except OSError: pass
        try: os.setgid(gid)
        except OSError: pass
        try: os.setuid(uid)
        except OSError: pass
        os.umask(0o022)
    return _do


def _run_as_target():
    """Return (preexec_fn, env_overlay) suitable for stream_proc(run_as=...), or
    (None, None) when we're already running as the target user (no drop needed).
    env_overlay sets HOME/USER/LOGNAME so git etc. don't read /root/.gitconfig."""
    uid, gid, name, home = target_owner()
    if os.getuid() == uid:
        return (None, None)
    if os.getuid() != 0:
        # Not root, and not the target — we can't switch. Return no-op so the
        # caller doesn't fight us; chown_path afterward will still try.
        return (None, None)
    return (_drop_privs_to(uid, gid),
            {"HOME": home or "/", "USER": name, "LOGNAME": name})


def ownership_status():
    """Report ownership mismatches in dust/code against the target owner.
    Used by the Heal Installations row in the configuration sheet.

    Skips ingenue's own dir (the editor sometimes legitimately runs as a
    different user than the scripts) and hidden dirs. Returns a sample of
    mismatches (max 12) and the total count, so the UI can say e.g.
    "3 script(s) own-mismatch — Heal"."""
    uid, gid, name, _ = target_owner()
    bad = []
    try:
        for d in sorted(os.listdir(CODE)):
            if d == "ingenue" or d.startswith("."):
                continue
            full = os.path.join(CODE, d)
            try:
                st = os.lstat(full)
                if st.st_uid != uid or st.st_gid != gid:
                    try: cur_user = pwd.getpwuid(st.st_uid).pw_name
                    except KeyError: cur_user = str(st.st_uid)
                    bad.append({"name": d, "current": cur_user,
                                "uid": st.st_uid, "gid": st.st_gid})
            except OSError:
                continue
    except OSError:
        pass
    return {
        "target": {"uid": uid, "gid": gid, "name": name},
        "running_as": {"uid": os.getuid(), "name": pwd.getpwuid(os.getuid()).pw_name
                       if _safe_getpwuid(os.getuid()) else str(os.getuid())},
        "mismatches": bad[:12],
        "mismatch_count": len(bad),
        "ok": len(bad) == 0,
        # We can heal if we're root (always) or already running as the target.
        "can_heal": len(bad) > 0 and (os.getuid() == 0 or os.getuid() == uid),
    }


def _safe_getpwuid(uid):
    try: return pwd.getpwuid(uid)
    except KeyError: return None


def heal_ownership():
    """Walk dust/code and chown every script tree to the target owner. Skips
    ingenue's own dir. Idempotent. Requires root (or already being the target
    user, in which case the only mismatches we can fix are dirs another user
    set our own uid on — uncommon)."""
    uid, gid, name, _ = target_owner()
    if os.getuid() != 0 and os.getuid() != uid:
        return {"error": f"ingenue isn't running as root or as {name} ({uid}) — "
                          f"can't chown other users' files"}
    fixed, errors = [], []
    try:
        entries = sorted(os.listdir(CODE))
    except OSError as e:
        return {"error": str(e)}
    for d in entries:
        if d == "ingenue" or d.startswith("."):
            continue
        full = os.path.join(CODE, d)
        try:
            st = os.lstat(full)
            if st.st_uid == uid and st.st_gid == gid:
                continue                  # already right; no walk needed
            try: cur_user = pwd.getpwuid(st.st_uid).pw_name
            except KeyError: cur_user = str(st.st_uid)
            n = chown_path(full, uid, gid)
            fixed.append({"name": d, "from": cur_user,
                          "to": name, "entries": n})
        except OSError as e:
            errors.append({"name": d, "error": str(e)})
    return {"ok": True, "target": {"uid": uid, "gid": gid, "name": name},
            "fixed": fixed, "fixed_count": len(fixed),
            "errors": errors}


def chown_path(path, uid, gid):
    """Recursively chown path to (uid, gid). Idempotent: leaves already-correct
    entries alone (so the walk is cheap on re-runs). Uses lchown (doesn't
    follow symlinks — important for git symlinks). Returns the number of
    entries touched (including ones that were already correct)."""
    n = 0
    try:
        st = os.lstat(path)
        if st.st_uid != uid or st.st_gid != gid:
            os.lchown(path, uid, gid)
        n = 1
    except OSError:
        return 0
    if os.path.isdir(path) and not os.path.islink(path):
        for root, dirs, files in os.walk(path, followlinks=False):
            for entry in dirs + files:
                p = os.path.join(root, entry)
                try:
                    st = os.lstat(p)
                    if st.st_uid != uid or st.st_gid != gid:
                        os.lchown(p, uid, gid)
                    n += 1
                except OSError:
                    continue
    return n


# Serializes /api/install, /api/heal, and /api/self-update against each other.
# Non-blocking acquire everywhere: collisions return 409 rather than queue. The
# race we're closing: self-update ends in `systemctl restart ingenue`, default
# KillMode=control-group, which SIGKILLs any in-flight clone/heal subprocess
# in this server's cgroup and leaves a half-installed dust/code/<name>/ behind.
# Self-update intentionally never releases on success — the restart kills us
# and the new process starts with a fresh lock.
_busy_lock = threading.Lock()
_busy_what = None   # "install" / "heal" / "self_update" — for the 409 message


def _busy_msg():
    what = _busy_what or "another operation"
    return f"{what} is in progress — try again in a moment"


def _release_busy():
    global _busy_what
    _busy_what = None
    try: _busy_lock.release()
    except RuntimeError: pass


# ---------------------------------------------------------------------------
# Background jobs: install/heal run in a worker thread and stream their output
# line-by-line into a buffer the UI polls (GET /api/job). The POST returns a job
# id immediately, so the install never looks "hung" — the client follows along
# and knows the moment it finishes. The worker (not the request thread) holds
# _busy_lock for its whole life, so concurrent installs/heals/self-updates still
# collide into a clean 409 the same way they did when these ran inline.
_jobs = {}
_jobs_lock = threading.Lock()
_job_seq = 0


class Job:
    def __init__(self, kind, name):
        self.kind, self.name = kind, name
        self.lines = []
        self.done = False
        self.ok = None
        self.error = None
        self._lk = threading.Lock()

    def emit(self, msg):
        with self._lk:
            for ln in (str(msg).splitlines() or [""]):
                self.lines.append(ln)

    def finish(self, ok, error=None):
        with self._lk:
            self.ok = ok
            self.error = error
            self.done = True

    def snapshot(self, frm):
        with self._lk:
            return {"name": self.name, "kind": self.kind, "lines": self.lines[frm:],
                    "next": len(self.lines), "done": self.done, "ok": self.ok,
                    "error": self.error}


def _new_job(kind, name):
    global _job_seq
    with _jobs_lock:
        _job_seq += 1
        jid = str(_job_seq)
        _jobs[jid] = Job(kind, name)
        if len(_jobs) > 40:                                  # bound memory: drop oldest finished
            for k in [k for k, v in list(_jobs.items()) if v.done][:-20]:
                _jobs.pop(k, None)
        return jid, _jobs[jid]


def get_job(jid):
    with _jobs_lock:
        return _jobs.get(jid)


def start_job(kind, name, what, fn):
    """Acquire the busy lock (non-blocking); on success spawn a worker that runs
    fn(emit) -> (ok, error|None), streaming into a new Job, and releases the lock
    when done. Returns (job_id, None) or (None, busy_message)."""
    global _busy_what
    if not _busy_lock.acquire(blocking=False):
        return None, _busy_msg()
    _busy_what = what
    jid, job = _new_job(kind, name)

    def work():
        global _engine_cache
        try:
            ok, err = fn(job.emit)
            job.finish(bool(ok), err)
        except Exception as e:  # noqa: BLE001
            job.emit(f"! {e}")
            job.finish(False, str(e))
        finally:
            _engine_cache = None        # a just-installed script may provide an engine — rescan next analyze
            _release_busy()
    threading.Thread(target=work, daemon=True).start()
    return jid, None


def stream_proc(cmd, cwd, emit, timeout=900, shell=False, run_as=None):
    """Run cmd, streaming stdout+stderr to emit() on every \\n or \\r boundary
    (so git --progress and build tools update live). Returns the exit code, or
    None if it was killed by the timeout.

    run_as=(preexec_fn, env_overlay) (typically from _run_as_target()) drops
    privileges to that user in the child before exec and merges env_overlay
    (HOME/USER/LOGNAME) so git, npm, etc. don't read the wrong dotfiles."""
    preexec = None
    child_env = None
    if run_as:
        preexec, overlay = run_as
        if overlay:
            child_env = dict(os.environ)
            child_env.update(overlay)
    p = subprocess.Popen(cmd, cwd=cwd, shell=shell,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0,
                         preexec_fn=preexec, env=child_env)
    killer = threading.Timer(timeout, p.kill)
    killer.daemon = True
    killer.start()
    buf = bytearray()
    try:
        while True:
            ch = p.stdout.read(1)
            if not ch:
                break
            if ch in (b"\n", b"\r"):
                s = bytes(buf).decode("utf-8", "replace").rstrip()
                if s:
                    emit(s)
                buf = bytearray()
            else:
                buf += ch
        s = bytes(buf).decode("utf-8", "replace").rstrip()
        if s:
            emit(s)
    finally:
        rc = p.wait()
        killer.cancel()
    return rc


# ---------------------------------------------------------------------------
# Maiden-parity install: full clone (history preserved → rollback possible),
# submodule recursion (scripts that vendor deps via submodule actually get them),
# .project metadata write (maiden-readable), and optional SHA pin (so a known-
# good commit can be installed when latest main is broken).
#
# Why this matters: the old `--depth 1` clone made it impossible to roll a
# script back to a working commit when upstream regressed, and the lack of
# submodule recursion silently produced incomplete installs for scripts that
# vendor deps via .gitmodules. Maiden does both correctly — ingenue now matches.
PROJECT_METADATA_FILENAME = ".project"

# Whitelist for git refs accepted by /api/install (sha=) and /api/rollback
# (target=). Permits SHAs, tags, branch names, HEAD~N — rejects anything starting
# with `-` (would be misread as a CLI flag by git checkout) and any character
# outside the git-ref-safe set. Defense-in-depth: even though we also pass
# `--end-of-options` to git, the regex stops malformed input at the API edge.
_SAFE_GIT_REF_RE = re.compile(r"^[A-Za-z0-9._/~^@][A-Za-z0-9._/~^@-]{0,249}$")


def _safe_git_ref(s):
    """True iff `s` is a git ref-shaped string we'll accept from user input.
    Used by /api/install (sha) and /api/rollback (target) to reject argv
    flag-smuggling attempts like `--upload-pack=/path/to/evil`."""
    return bool(s and isinstance(s, str) and _SAFE_GIT_REF_RE.match(s))


def do_clone(full, url, emit, sha=None, catalog_entry=None, recurse_submodules=True):
    """Stream a full `git clone` into `full`. Preserves history for rollback,
    recurses submodules so scripts that vendor deps via .gitmodules get them,
    and writes a maiden-compatible .project metadata file. Drops to the dust
    owner before exec. Returns (ok, error|None)."""
    uid, gid, name, _ = target_owner()
    run_as = _run_as_target()
    as_suffix = f"  (as {name})" if run_as[0] else ""
    args = ["git", "clone", "--progress"]
    if recurse_submodules:
        args.append("--recurse-submodules")
    args += [url, full]
    emit(f"$ {' '.join(args)}{as_suffix}")
    rc = stream_proc(args, None, emit, timeout=300, run_as=run_as)
    if rc != 0:
        return False, (f"git clone exited {rc}" if rc is not None else "git clone timed out")
    if sha:
        if not _safe_git_ref(sha):
            return False, f"refused unsafe ref {sha!r}"
        emit(f"$ git -C {os.path.basename(full)} checkout {sha}")
        # --end-of-options stops git treating a `-`-prefixed sha as a flag (belt
        # and suspenders with _safe_git_ref above).
        rc2 = stream_proc(["git", "-C", full, "checkout", "--end-of-options", sha],
                          None, emit, timeout=60, run_as=run_as)
        if rc2 != 0:
            return False, f"git checkout {sha} failed (rc={rc2})"
    # Backstop chown — primary guarantee is the preexec_fn in stream_proc, but
    # if drop-privs didn't apply (e.g. dust is root-owned -> target == root),
    # this is a no-op.
    if os.getuid() == 0 and uid != 0:
        n = chown_path(full, uid, gid)
        if n:
            emit(f"chown {name}:{name} ({n} entries)")
    write_project_metadata(full, url, catalog_entry=catalog_entry, emit=emit)
    emit("✓ cloned — run SYSTEM > RESTART to load it")
    return True, None


def do_update(full, emit):
    """Update an existing managed git repo without destroying it: `git fetch`
    then `git reset --hard origin/<default-branch>`. Preserves untracked files
    (like .project metadata or user-added files), and crucially preserves the
    .git directory so rollback remains possible. Returns (ok, error|None).

    Use this instead of `rmtree + clone` when the user wants the latest version
    of a script they already have — matches maiden's `Update` semantics."""
    if not os.path.isdir(os.path.join(full, ".git")):
        return False, "not a managed git repo (no .git directory) — reinstall instead"
    uid, gid, name, _ = target_owner()
    run_as = _run_as_target()
    emit("$ git fetch origin --recurse-submodules")
    rc = stream_proc(["git", "-C", full, "fetch", "origin", "--recurse-submodules"],
                     None, emit, timeout=180, run_as=run_as)
    if rc != 0:
        return False, f"git fetch exited {rc}"
    # discover the default branch from origin's HEAD ref; fall back to origin/main
    default_ref = "origin/main"
    try:
        r = subprocess.run(["git", "-C", full, "symbolic-ref", "refs/remotes/origin/HEAD"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0 and r.stdout.strip():
            default_ref = r.stdout.strip().replace("refs/remotes/", "")
    except (OSError, subprocess.TimeoutExpired):
        pass
    emit(f"$ git reset --hard {default_ref}")
    rc = stream_proc(["git", "-C", full, "reset", "--hard", default_ref],
                     None, emit, timeout=60, run_as=run_as)
    if rc != 0:
        return False, f"git reset --hard exited {rc}"
    # bring submodules up-to-date too
    if os.path.isfile(os.path.join(full, ".gitmodules")):
        emit("$ git submodule update --init --recursive")
        stream_proc(["git", "-C", full, "submodule", "update", "--init", "--recursive"],
                    None, emit, timeout=180, run_as=run_as)
    if os.getuid() == 0 and uid != 0:
        chown_path(full, uid, gid)
    update_project_metadata(full, emit=emit)
    emit("✓ updated — run SYSTEM > RESTART to reload")
    return True, None


def do_rollback(full, target, emit):
    """Check out an arbitrary git ref (SHA, tag, or relative ref like HEAD~1)
    in an installed script. Lets the user undo an upgrade that regressed,
    pin to a known-good commit, etc. Requires the script to have been
    installed via do_clone (i.e., has full history)."""
    if not os.path.isdir(os.path.join(full, ".git")):
        return False, "not a managed git repo (no .git) — rollback unavailable"
    if not _safe_git_ref(target):
        return False, f"refused unsafe ref {target!r}"
    uid, gid, _, _ = target_owner()
    run_as = _run_as_target()
    emit(f"$ git -C {os.path.basename(full)} checkout {target}")
    # --end-of-options prevents a `-`-prefixed target from being parsed as a
    # flag; the regex above rejects the same case at the API edge.
    rc = stream_proc(["git", "-C", full, "checkout", "--end-of-options", target],
                     None, emit, timeout=60, run_as=run_as)
    if rc != 0:
        return False, f"git checkout {target} exited {rc}"
    # update submodule pinning to the rolled-back commit
    if os.path.isfile(os.path.join(full, ".gitmodules")):
        stream_proc(["git", "-C", full, "submodule", "update", "--init", "--recursive"],
                    None, emit, timeout=180, run_as=run_as)
    if os.getuid() == 0 and uid != 0:
        chown_path(full, uid, gid)
    emit(f"✓ rolled back to {target} — run SYSTEM > RESTART to reload")
    return True, None


def write_project_metadata(full, source_url, catalog_entry=None, emit=None):
    """Write maiden-compatible .project JSON. Preserves a prior file's
    installed_on if present (we only set it on FIRST install). Makes ingenue-
    installed scripts indistinguishable to maiden, and gives the UI a place
    to read provenance from."""
    path = os.path.join(full, PROJECT_METADATA_FILENAME)
    now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    existing = read_project_metadata(full)
    md = {
        "file_info": {"version": 1, "kind": "project_metadata"},
        "installed_on": (existing or {}).get("installed_on") or now,
        "updated_on": now if existing else "0001-01-01T00:00:00Z",
        "project_url": source_url,
    }
    if catalog_entry:
        md["catalog_entry"] = catalog_entry
    elif existing and "catalog_entry" in existing:
        md["catalog_entry"] = existing["catalog_entry"]
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(md, f, indent=2)
        if emit:
            emit(f"wrote {PROJECT_METADATA_FILENAME}")
        uid, gid, _, _ = target_owner()
        if os.getuid() == 0 and uid != 0:
            try: os.lchown(path, uid, gid)
            except OSError: pass
    except OSError as e:
        if emit:
            emit(f"! couldn't write .project: {e}")


def update_project_metadata(full, emit=None):
    """Bump only the updated_on timestamp; preserve everything else. Used by
    do_update after a successful fetch+reset."""
    md = read_project_metadata(full)
    if not md:
        # script wasn't managed via .project metadata — write a fresh one from git remote
        url = git_remote(full)
        if url:
            write_project_metadata(full, url, emit=emit)
        return
    md["updated_on"] = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    path = os.path.join(full, PROJECT_METADATA_FILENAME)
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(md, f, indent=2)
        if emit:
            emit(f"updated {PROJECT_METADATA_FILENAME} timestamp")
    except OSError as e:
        if emit:
            emit(f"! couldn't update .project: {e}")


def read_project_metadata(full):
    """Read .project if present, else None. Tolerant of malformed JSON."""
    path = os.path.join(full, PROJECT_METADATA_FILENAME)
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def git_history(full, n=10):
    """Recent commits for the UI rollback picker. Returns
    [{sha, short, date, msg}], newest first."""
    if not os.path.isdir(os.path.join(full, ".git")):
        return []
    try:
        r = subprocess.run(
            ["git", "-C", full, "log", f"-{int(n)}",
             "--format=%H%x09%h%x09%cI%x09%s"],
            capture_output=True, text=True, timeout=15)
        if r.returncode != 0:
            return []
        out = []
        for ln in r.stdout.splitlines():
            parts = ln.split("\t", 3)
            if len(parts) == 4:
                out.append({"sha": parts[0], "short": parts[1],
                            "date": parts[2], "msg": parts[3]})
        return out
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return []


def git_current_sha(full):
    """The currently checked-out SHA (or '' if not a git repo / detached)."""
    try:
        r = subprocess.run(["git", "-C", full, "rev-parse", "HEAD"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        pass
    return ""


# ---------------------------------------------------------------------------
# Mod-bang detection (a.k.a. the hs010-breaks-dreamsequence pattern)
# ---------------------------------------------------------------------------
# Norns nb voice mods register a `player` object whose `add_params()` is called
# during another script's nb:add_player_params loop. If that add_params does a
# bare `params:bang()`, it fires every param action across the *host script's*
# params set — before the host script's init has finished defining the globals
# its own param-action callbacks reference. The host script then crashes with a
# nil-global error. hs010 does this and silently breaks dreamsequence (and any
# script with the same init shape). The detector and the auto-heal below catch
# this class of bug at install time.
def _scan_mod_bang_in_add_params(full):
    """Return [{file, line, function}] for every `params:bang()` (no-arg) call
    found inside an `add_params`-named function body in the script's mod files.
    Empty list = clean. Heuristic Lua parse (function/end stack), works for the
    typical norns mod shape; deliberately conservative."""
    hits = []
    candidates = []
    for rel in ("lib/mod.lua", "mod.lua"):
        if os.path.isfile(os.path.join(full, rel)):
            candidates.append(rel)
    # also pick up any top-level *_mod.lua a script might use (rare)
    try:
        for f in os.listdir(full):
            if f.endswith("_mod.lua") and f not in candidates:
                candidates.append(f)
    except OSError:
        return hits
    fn_open_re = re.compile(r"^\s*(?:local\s+)?function\s+([A-Za-z0-9_:.]+)\s*\(")
    end_re = re.compile(r"^\s*end\s*$")
    bang_re = re.compile(r"\bparams\s*:\s*bang\s*\(\s*\)")
    for rel in candidates:
        path = os.path.join(full, rel)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                lines = fh.readlines()
        except OSError:
            continue
        stack = []
        for i, raw in enumerate(lines, 1):
            if fn_open_re.match(raw):
                stack.append((fn_open_re.match(raw).group(1), i))
                continue
            if end_re.match(raw):
                if stack:
                    stack.pop()
                continue
            stripped = raw.strip()
            if stripped.startswith("--"):
                continue
            if bang_re.search(stripped):
                if any("add_params" in name for name, _ in stack):
                    fn = next((n for n, _ in reversed(stack) if "add_params" in n), "add_params")
                    hits.append({"file": rel, "line": i, "function": fn})
    return hits


def heal_mod_bang(full, emit=None):
    """EXPERIMENTAL: comment out every `params:bang()` (no-arg) call found
    inside an add_params function body. Reversible — the lines are commented,
    not deleted, with an annotation explaining what ingenue did. Idempotent
    (skips already-commented lines). Returns the list of changes.

    Caveat: a mod that relied on the bang to apply initial param state may
    now ship slightly different defaults. Reverting is `git checkout -- <file>`."""
    hits = _scan_mod_bang_in_add_params(full)
    if not hits:
        if emit: emit("no bang-in-add_params calls to heal")
        return {"ok": True, "changes": [], "message": "no bang-in-add_params calls to heal"}
    by_file = {}
    for h in hits:
        by_file.setdefault(h["file"], []).append(h["line"])
    changes = []
    for rel, line_nos in by_file.items():
        path = os.path.join(full, rel)
        try:
            with open(path, "r", encoding="utf-8", errors="ignore") as fh:
                content = fh.readlines()
        except OSError as e:
            if emit: emit(f"! {rel}: {e}")
            continue
        for line_no in line_nos:
            i = line_no - 1
            if i < 0 or i >= len(content):
                continue
            old = content[i]
            stripped = old.lstrip()
            if stripped.startswith("--"):
                continue
            indent = old[:len(old) - len(stripped)]
            trail = stripped.rstrip("\n")
            new = (f"{indent}-- {trail}  "
                   f"-- DISABLED by ingenue: bang() in add_params crashes "
                   f"scripts with later-defined globals\n")
            content[i] = new
            changes.append({"file": rel, "line": line_no,
                            "old": old.rstrip("\n"), "new": new.rstrip("\n")})
        try:
            with open(path, "w", encoding="utf-8") as fh:
                fh.writelines(content)
        except OSError as e:
            if emit: emit(f"! couldn't write {rel}: {e}")
            continue
        uid, gid, _, _ = target_owner()
        if os.getuid() == 0 and uid != 0:
            try: os.lchown(path, uid, gid)
            except OSError: pass
        if emit:
            emit(f"patched {rel} ({len(line_nos)} line(s) commented)")
    return {"ok": True, "changes": changes,
            "message": f"commented {len(changes)} bang call(s); reboot to apply"}


# ---------------------------------------------------------------------------
# Multi-check health overview
# ---------------------------------------------------------------------------
# Single endpoint that aggregates every health check ingenue knows about, so
# the configuration sheet can show a unified "health checks" panel instead of
# scattered banners. Each check is self-describing (name, status, summary,
# detail, heal action) so the UI renders them generically — adding a new
# check means appending to the aggregator, no UI work.
def health_mod_bangs():
    """Scan every installed script for params:bang() inside add_params (the
    dreamsequence-class bug). Cross-references with system.mods so we know
    which hits are actually loaded at boot — disabled mods with bangs are
    flagged informationally but don't count as active issues."""
    enabled = set(read_enabled_mods())
    issues = []
    try:
        names = sorted(os.listdir(CODE))
    except OSError:
        return {"issues": [], "active_issues": [], "scanned": 0,
                "enabled_mods": sorted(enabled)}
    for name in names:
        if name.startswith(".") or name == "ingenue":
            continue
        full = os.path.join(CODE, name)
        if not os.path.isdir(full):
            continue
        for h in _scan_mod_bang_in_add_params(full):
            issues.append({"script": name, **h, "enabled": name in enabled})
    return {
        "issues": issues,
        "active_issues": [i for i in issues if i["enabled"]],
        "scanned": len(names),
        "enabled_mods": sorted(enabled),
    }


def heal_all_mod_bangs(only_enabled=True):
    """Run heal_mod_bang on every installed dir that has bang-in-add_params
    hits. Defaults to only-enabled (those that load at boot — disabled mods
    can stay broken since they don't run). Returns per-script result list."""
    enabled = set(read_enabled_mods()) if only_enabled else None
    results = []
    try:
        names = sorted(os.listdir(CODE))
    except OSError as e:
        return {"ok": False, "error": str(e), "results": []}
    for name in names:
        if name.startswith(".") or name == "ingenue":
            continue
        full = os.path.join(CODE, name)
        if not os.path.isdir(full):
            continue
        if enabled is not None and name not in enabled:
            continue
        hits = _scan_mod_bang_in_add_params(full)
        if not hits:
            continue
        r = heal_mod_bang(full)
        results.append({"script": name, **r})
    return {"ok": True, "results": results,
            "patched_scripts": [r["script"] for r in results if r.get("changes")],
            "total_lines_patched": sum(len(r.get("changes", [])) for r in results)}


def health_overview():
    """Multi-check aggregator. Each entry is a self-describing row the UI
    renders generically. New checks slot in by appending here — the UI
    doesn't need per-check code.

    Currently includes: script ownership, mod params:bang() compatibility.
    Candidates to add next: stale .deleted backups, missing data dirs for
    scripts whose install.sh would have created them, partial-clone scripts
    that can't roll back."""
    checks = []

    # 1) script ownership
    own = ownership_status()
    target = own["target"]["name"]
    if own["ok"]:
        summary = f"every script in dust/code owned by {target}"
        detail = ""
    else:
        n = own["mismatch_count"]
        summary = f"{n} script{'' if n==1 else 's'} own-mismatch — should be {target}"
        detail = ", ".join(f"{m['name']} (currently {m['current']})" for m in own["mismatches"])
    checks.append({
        "id": "ownership",
        "name": "script ownership",
        "ok": own["ok"],
        "issue_count": own["mismatch_count"],
        "summary": summary,
        "detail": detail,
        "can_heal": own["can_heal"],
        "heal_endpoint": "/api/heal-ownership",
        "heal_method": "POST",
        "heal_label": "heal ownership",
    })

    # 2) mod compatibility — bang in add_params (dreamsequence-class crashes)
    bangs = health_mod_bangs()
    active = bangs["active_issues"]
    dormant = [i for i in bangs["issues"] if not i["enabled"]]
    if not active:
        if dormant:
            summary = f"all enabled mods clean ({len(dormant)} disabled mod{'s' if len(dormant)!=1 else ''} also has bang-in-add_params but isn't loaded)"
        else:
            summary = "no mod calls params:bang() in add_params"
        detail = ""
    else:
        scripts = sorted({i["script"] for i in active})
        summary = (f"{len(scripts)} enabled mod{'s' if len(scripts)!=1 else ''} "
                   f"call params:bang() in add_params — crashes scripts that "
                   f"define globals after their param setup (e.g. dreamsequence)")
        detail = ", ".join(f"{i['script']}:{i['file']}:{i['line']}" for i in active)
    checks.append({
        "id": "mod_bangs",
        "name": "mod compatibility",
        "ok": not active,
        "issue_count": len(active),
        "summary": summary,
        "detail": detail,
        "can_heal": bool(active),
        "heal_endpoint": "/api/health/bangs/heal",
        "heal_method": "POST",
        "heal_label": "auto-heal",
        "experimental": True,
    })

    # 3) SuperCollider plugin architecture — wrong-arch .so files (the
    # tapedeck-installer-on-64-bit-host class). Surfaces both the count and
    # whether ingenue's bundle can supply correct-arch replacements.
    wrong = wrong_arch_so_files()
    if not wrong:
        summary = "every SuperCollider plugin matches host arch"
        detail = ""
    else:
        machine, _ = host_arch()
        want = ARCH_ELF.get(machine, "?")
        by_dir = {}
        for w in wrong:
            by_dir.setdefault(os.path.dirname(w["path"]), []).append(w["basename"])
        sample = "; ".join(f"{d}: {', '.join(sorted(set(bs))[:3])}" for d, bs in list(by_dir.items())[:3])
        n = len(wrong)
        verb = "is" if n == 1 else "are"
        plural = "" if n == 1 else "s"
        summary = (f"{n} SuperCollider plugin .so file{plural} {verb} wrong arch for this "
                   f"host ({want}) — scsynth silently can't load {'it' if n==1 else 'them'}, "
                   f"engines that depend on {'it' if n==1 else 'them'} won't work")
        detail = sample
    checks.append({
        "id": "sc_plugin_arch",
        "name": "SuperCollider plugin arch",
        "ok": not wrong,
        "issue_count": len(wrong),
        "summary": summary,
        "detail": detail,
        "can_heal": bool(wrong),
        "heal_endpoint": "/api/scplugins/heal-wrong-arch",
        "heal_method": "POST",
        "heal_label": "heal wrong-arch SC plugins",
        "experimental": True,                                 # touches system Extensions dirs
    })

    return {
        "checks": checks,
        "overall_ok": all(c["ok"] for c in checks),
        "issue_count": sum(c["issue_count"] for c in checks),
    }


# ---------------------------------------------------------------------------
# Cross-script download hint
# ---------------------------------------------------------------------------
# When a script's downloads point at https://github.com/<author>/<repo>/releases/...,
# the artifact is hosted by another norns script's repo (e.g. amenbreak fetches
# PortedPlugins from tapedeck/releases). The UI can surface this so the user
# can choose to install the origin script too — a hint, not an automatic dep.
def _extract_download_origins(downloads):
    """Return [{author, repo, url, installed}] for every download URL that
    points at another script's github releases. Deduplicated by (author, repo)."""
    out = []
    seen = set()
    for url in downloads:
        m = re.match(r"https?://github\.com/([^/]+)/([^/]+)/releases/", url)
        if not m:
            continue
        author = m.group(1)
        repo = re.sub(r"\.git$", "", m.group(2))
        key = (author.lower(), repo.lower())
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "author": author,
            "repo": repo,
            "url": url,
            "installed": os.path.isdir(os.path.join(CODE, repo)),
        })
    return out


def backup_script_dir(full, name, emit=None):
    """Move an existing script dir out of the way (instead of rmtree) when
    force-reinstalling. Stored under <dust-owner-home>/.ingenue-backups/<name>.<ts>/.

    Critical placement note: norns's sclang scans the ENTIRE dust tree
    recursively for class files (sclang_conf.yaml's includePaths typically
    list /home/we/dust, not /home/we/dust/code). So any backup stored anywhere
    under dust — even hidden — leaves Engine_X.sc files visible to scsynth's
    class compiler and produces 'DUPLICATE ENGINES' against the fresh install.
    Found 2026-06-06 the hard way: dust/code/.deleted/ broke amenbreak load,
    then dust/.ingenue-deleted/ broke it again. Anywhere outside dust is fine
    — the dust owner's home dir is the natural choice (persistent, owned by
    the right user, not on the installed list).

    Returns the backup path."""
    _, _, _, home = target_owner()
    backups_root = os.path.join(home or "/tmp", ".ingenue-backups")
    os.makedirs(backups_root, exist_ok=True)
    ts = time.strftime("%Y%m%dT%H%M%S")
    bak = os.path.join(backups_root, f"{name}.{ts}")
    os.rename(full, bak)
    if emit:
        emit(f"backed up prior {name} → ~/.ingenue-backups/{name}.{ts}")
    # match dust owner so future cleanup doesn't need root
    uid, gid, _, _ = target_owner()
    if os.getuid() == 0 and uid != 0:
        try:
            os.lchown(backups_root, uid, gid)
            chown_path(bak, uid, gid)
        except OSError:
            pass
    return bak


def self_update():
    """Re-run install.sh to pull the latest ingenue and restart the service.
    install.sh restarts ingenue.service at the end — which, on a default
    KillMode=control-group unit, would kill any child we spawn mid-update.
    So we launch it via systemd-run as its own transient unit (outside our
    cgroup) when available; otherwise fall back to a detached process.

    Lock is acquired non-blocking and held until the service restart kills us
    (or released on every error path). While held, /api/install and /api/heal
    return 409 — so no fresh clone/heal can start in the window between
    'systemd-run fired' and 'systemctl restart ingenue SIGKILLs us'."""
    global _busy_what
    if not _busy_lock.acquire(blocking=False):
        return {"error": _busy_msg()}
    _busy_what = "self_update"
    script = os.path.join(HERE, "install.sh")
    if not os.path.isfile(script):
        alt = os.path.join(HERE, "..", "install.sh")     # web/ subdir layout
        if os.path.isfile(alt):
            script = alt
    if not os.path.isfile(script):
        _release_busy(); return {"error": "install.sh not found next to ingenue"}
    env = ["--setenv=INGENUE_DUST=%s" % DUST, "--setenv=INGENUE_PORT=%s" % PORT]
    if shutil.which("systemd-run"):
        for extra in (["--unit", "ingenue-selfupdate"], []):   # try a stable name, then auto-named
            cmd = ["systemd-run", "--collect"] + extra + env + ["bash", script]
            try:
                r = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
            except Exception as e:  # noqa: BLE001
                _release_busy(); return {"error": str(e)}
            if r.returncode == 0:
                return {"ok": True, "method": "systemd-run"}    # keep lock held — restart kills us
        _release_busy(); return {"error": "systemd-run failed", "log": (r.stderr or r.stdout)[-400:]}
    try:   # no systemd-run — detached best effort (survives if KillMode!=control-group)
        subprocess.Popen(
            ["bash", script], start_new_session=True,
            env={**os.environ, "INGENUE_DUST": DUST, "INGENUE_PORT": str(PORT)},
            stdout=open(os.path.join(HERE, "update.log"), "ab"), stderr=subprocess.STDOUT)
        return {"ok": True, "method": "background"}     # keep lock held — restart kills us
    except Exception as e:  # noqa: BLE001
        _release_busy(); return {"error": str(e)}


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


def git_remote(full):
    """The origin URL a script was cloned from, read from its own .git. Lets us
    reinstall/update scripts that came from GitHub (or anywhere) without the
    catalog — the clone url is always inferable from the clone itself."""
    if not os.path.isdir(os.path.join(full, ".git")):
        return ""
    try:
        r = subprocess.run(["git", "-C", full, "remote", "get-url", "origin"],
                           capture_output=True, text=True, timeout=10)
        if r.returncode == 0:
            return r.stdout.strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


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


def find_installer(full):
    """The script's installer, by norns convention: lib/install.sh, or a top-level
    install.sh. An install.sh buried in a subdir (viewer/, docs/, examples/) is unrelated
    tooling — flagging it as 'needs setup' produces spurious prompts and 'no lib/install.sh
    to run' failures (e.g. synth-quest's viewer/install.sh). Returns the relative path or None."""
    for rel in ("lib/install.sh", "install.sh"):
        if os.path.isfile(os.path.join(full, rel)):
            return rel
    return None


def run_install(full, emit=None):
    """Interpret a script's installer ourselves so it works on ANY port:
    downloads + tar extracts run in Python (native gzip/xz, no BusyBox-tar / GNU-tar
    differences), /home/we/dust is translated to the real dust, and other commands
    (builds, etc.) fall back to the shell. `emit(line)` (optional) receives each log
    line live so the UI can follow along; shell builds stream their output too.

    Shell subcommands drop privileges to the dust owner (typically `we`) when
    ingenue is running as root — so anything the installer creates lands owned
    by the right user. Python-native steps (urlretrieve, makedirs, tar extract)
    run in ingenue's own process and are chowned after the fact via fixown()."""
    import shlex, tarfile, zipfile
    emit = emit or (lambda *_: None)
    log = []

    uid, gid, name, _ = target_owner()
    run_as = _run_as_target()
    needs_chown = os.getuid() == 0 and uid != 0

    def add(msg):
        log.append(msg)
        emit(msg)

    def fixown(p):
        """Match the target owner for paths we created in-process (not in a child)."""
        if needs_chown:
            try: os.lchown(p, uid, gid)
            except OSError: pass

    rel = find_installer(full)
    if not rel:
        return False, "no install.sh found (looked in lib/install.sh and ./install.sh)"
    inst = os.path.join(full, rel)
    pp = ensure_home_dust().strip()
    if pp:
        add(pp)
    cwd = full
    ok = True
    for raw in open(inst, "r", errors="ignore"):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        line = line.replace("/home/we/dust", DUST)
        try:
            if line.startswith("echo "):
                add(line[5:].strip().strip('"').strip("'"))
            elif line.startswith("cd "):
                d = line[3:].strip()
                cwd = d if os.path.isabs(d) else os.path.normpath(os.path.join(cwd, d))
                os.makedirs(cwd, exist_ok=True)
                fixown(cwd)
            elif re.search(r"\b(wget|curl)\b", line) and re.search(r"https?://", line):
                url = re.search(r"(https?://\S+)", line).group(1).rstrip("\"'")
                om = re.search(r"-[oO]\s+(\S+)", line)
                out = om.group(1) if om else os.path.basename(url.split("?")[0])
                dest = os.path.join(cwd, out)
                emit(f"↓ downloading {out} …")
                urllib.request.urlretrieve(url, dest)
                fixown(dest)
                add(f"downloaded {out} ({os.path.getsize(dest)} bytes)")
            elif line.startswith("tar "):
                fm = re.search(r"(\S+\.(?:tar\.gz|tgz|tar\.xz|tar|zip))\b", line)
                if fm:
                    p = fm.group(1)
                    p = p if os.path.isabs(p) else os.path.join(cwd, p)
                    if p.endswith(".zip"):
                        with zipfile.ZipFile(p) as z: z.extractall(cwd)
                    else:
                        with tarfile.open(p) as t: t.extractall(cwd)
                    if needs_chown:
                        chown_path(cwd, uid, gid)   # extracted files inherited our uid; fix
                    add(f"extracted {os.path.basename(p)}")
            elif line.startswith("rm "):
                for f in shlex.split(line)[1:]:
                    if not f.startswith("-"):
                        try: os.remove(f if os.path.isabs(f) else os.path.join(cwd, f))
                        except OSError: pass
            elif line.startswith("mkdir"):
                for d in shlex.split(line)[1:]:
                    if not d.startswith("-"):
                        p = d if os.path.isabs(d) else os.path.join(cwd, d)
                        os.makedirs(p, exist_ok=True)
                        fixown(p)
            else:
                emit(f"$ {line}")
                # build output streams live; drops privs to dust-owner so any
                # files this command creates aren't root-owned
                rc = stream_proc(line, cwd, emit, timeout=900, shell=True, run_as=run_as)
                if rc != 0:
                    ok = False
                    log.append(f"$ {line} -> exit {rc}")
                else:
                    log.append(f"$ {line}")
        except Exception as e:  # noqa: BLE001
            ok = False
            add(f"! {line[:60]} -> {e}")
    # Belt-and-suspenders: chown the whole tree once at the end so anything
    # the installer created that escaped our per-step ownership fixups still
    # ends up owned correctly. Idempotent — already-correct entries are no-ops.
    if needs_chown:
        try:
            n = chown_path(full, uid, gid)
            add(f"chown {name}:{name} ({n} entries)")
        except OSError as e:
            add(f"! chown {name}:{name} -> {e}")
    return ok, "\n".join(log)


def analyze_script(name):
    """Scan an INSTALLED script for its dependency surface."""
    full, name = safe_script_dir(name)
    if not os.path.isdir(full):
        raise ValueError("not installed")
    return analyze_dir(full, name)


_engine_cache = None


def available_engines():
    """Lowercased names of every SuperCollider engine present on this device:
    norns CORE engines (PolyPerc, PolySub, …) plus any Engine_<X>.sc bundled in an
    installed script. Lets us tell when a script's `engine.name = "Foo"` points at
    an engine that isn't installed — the silent 'error: missing Foo' at launch.
    Cached; invalidated after any install/heal (see start_job)."""
    global _engine_cache
    if _engine_cache is not None:
        return _engine_cache
    names = set()
    roots = [CODE]
    for rel in ("../norns/sc/engines", "../../norns/sc/engines",   # PanicOS / norns data layout
                "norns/sc/engines", "../../we/norns/sc/engines"):
        roots.append(os.path.normpath(os.path.join(DUST, rel)))
    for d in roots:
        if not os.path.isdir(d):
            continue
        for r, _ds, fs in os.walk(d):
            if ".git" in r:
                continue
            for f in fs:
                m = re.match(r"Engine_(.+)\.sc$", f)
                if m:
                    names.add(m.group(1).lower())
    _engine_cache = names
    return names


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
    # First pass: catalogue which support libraries this script *bundles* under
    # its own lib/<X>/ tree. A bundled lib is a dir at lib/<X>/ that contains
    # at least one .lua (or .sc/.sh) file — i.e. the script ships its own copy.
    # Bundled libs are NOT a missing dep (the script's own require's resolve
    # locally), AND their internal source must be excluded from the blob — the
    # bundled copy's own self-references would otherwise trip the dep regex
    # below (e.g. dreamsequence bundles lib/nb/lib/nb.lua, whose own `require
    # "nb/..."` calls used to falsely flag dreamsequence as needing nb).
    bundled = set()
    lib_root = os.path.join(full, "lib")
    if os.path.isdir(lib_root):
        try:
            for d in os.listdir(lib_root):
                sub = os.path.join(lib_root, d)
                if not os.path.isdir(sub) or d.startswith("."):
                    continue
                has_code = False
                for r, _ds, fs in os.walk(sub):
                    if ".git" in r:
                        continue
                    if any(f.endswith((".lua", ".sc", ".sh")) for f in fs):
                        has_code = True; break
                if has_code:
                    bundled.add(d.lower())
        except OSError:
            pass
    bundled_prefixes = tuple(os.path.join("lib", b) + os.sep for b in bundled)

    texts, files = [], []
    for root, dirs, fs in os.walk(full):
        if ".git" in root:
            continue
        for f in fs:
            rel = os.path.relpath(os.path.join(root, f), full)
            files.append(rel)
            if rel.startswith(bundled_prefixes):     # don't read bundled lib code into the blob
                continue
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
    # library names can contain dots/hyphens (mx.samples, mx.synths, 4-big-knobs) — the old
    # [A-Za-z0-9_]+ class silently dropped those, so dotted deps never flagged for heal.
    # Also filter out anything the script bundles under its own lib/<X>/ — those require's
    # resolve locally and are not missing.
    reqs = sorted(set(r for r in re.findall(r"require[\s(]+['\"]([A-Za-z0-9_.\-]+)/lib", blob)
                      if r not in (name, "core") and r.strip(".") and r.lower() not in bundled))
    native = []
    if any(f.endswith("go.mod") for f in files): native.append("go")
    if any(f.endswith("Makefile") for f in files): native.append("make")
    if re.search(r"\baubio|aubiogo", blob): native.append("aubio")
    if re.search(r"soxgo|\bsox\b", blob): native.append("sox")
    if re.search(r"audiowaveform", blob): native.append("audiowaveform")
    # engine.name = "Foo" -> the script needs the Foo SuperCollider engine. If Foo
    # isn't a norns built-in, isn't bundled in this script, and isn't installed by
    # another script, the engine is MISSING -> launch fails with "error: missing Foo".
    engines = sorted(set(re.findall(r"engine\.name\s*=\s*['\"]([A-Za-z0-9_]+)['\"]", blob)))
    avail = available_engines()
    self_engines = {re.match(r"Engine_(.+)\.sc$", os.path.basename(f)).group(1).lower()
                    for f in files if re.match(r"Engine_.+\.sc$", os.path.basename(f))}
    missing_engines = sorted(e for e in engines
                             if e.lower() not in avail and e.lower() not in self_engines)
    # nb is flagged ONLY if the script references it externally AND doesn't ship
    # its own bundled copy under lib/nb/. Scripts that vendor nb (dreamsequence,
    # at_sea, etc.) self-resolve their require's and don't need the standalone
    # nb script installed — flagging them as needing nb was a recurring false
    # positive that drove agents to re-install nb-voice onto already-working setups.
    nb_referenced = bool(re.search(r"require[\s(]+['\"]nb/|/nb/lib|nb_voice|nb:add", blob))
    rep = {
        "name": name,
        "git_url": git_remote(full),                     # inferred clone url — enables reinstall/update off-catalog
        "install_script": bool(find_installer(full)),
        "downloads": downloads[:12],
        "sc_extensions": sc_ext,
        "needs_sc_ext": bool(sc_ext) or "Extensions/" in blob,
        "requires_scripts": reqs,
        "engines": engines,
        "missing_engines": missing_engines,              # engine.name targets not installed on device
        "nb": nb_referenced and "nb" not in bundled,
        "bundled_libs": sorted(bundled),                 # for transparency in the UI/debug
        "native": sorted(set(native)),
        # Hint: download URLs that point at another script's github releases.
        # The UI surfaces this so the user can choose to install the origin
        # script too (e.g. amenbreak's PortedPlugins.tar.gz from tapedeck/releases).
        # Self-references are filtered (a script's own releases don't count).
        "download_origins": [o for o in _extract_download_origins(downloads)
                             if o["repo"].lower() != name.lower()],
        # Warning: this script (when loaded as a mod) does `params:bang()`
        # inside its add_params — fires every param action of the HOST script
        # mid-init, crashing scripts that define globals later. dreamsequence
        # vs hs010 is the canonical case. UI offers an experimental auto-heal.
        "mod_bangs": _scan_mod_bang_in_add_params(full),
    }
    rep["needs_setup"] = bool(rep["install_script"] or rep["downloads"] or rep["needs_sc_ext"]
                              or rep["nb"] or rep["requires_scripts"] or rep["missing_engines"])
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
# host arch (uname) -> the ELF e_machine that scsynth here can actually load.
# 32-bit ARM variants (armv7l on real norns, armhf etc on some ports) were
# missing here — the gap caused scplugins_status to false-flag every present .so
# as "wrong arch" on 32-bit hosts. Added 2026-06-06 alongside the wrong-arch heal.
ARCH_ELF = {"aarch64": "aarch64", "arm64": "aarch64",
            "x86_64": "x86_64", "amd64": "x86_64",
            "armv7l": "arm", "armv6l": "arm", "armhf": "arm"}


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
    """Existing SuperCollider Extensions dirs scsynth may scan (system first).

    On ports (panicos etc.) HOME is set to a port-specific path like
    /storage/roms/ports/norns/data, so os.path.expanduser('~') doesn't find
    /home/we — BUT norns scripts (tapedeck's scinstaller, amenbreak's runtime
    install button) hardcode '/home/we/.local/share/SuperCollider/Extensions'
    and scsynth on panicos DOES scan that path (proven via manual swap test
    2026-06-06 — fixing wrong-arch .so files at /home/we/... resolved the
    silent engine load failure). So we always probe /home/we/... explicitly
    in addition to the HOME-derived path. Dedup via realpath."""
    cands = ["/usr/share/SuperCollider/Extensions",
             "/usr/local/share/SuperCollider/Extensions",
             os.path.expanduser("~/.local/share/SuperCollider/Extensions"),
             "/home/we/.local/share/SuperCollider/Extensions",  # hardcoded by norns scripts
             "/root/.local/share/SuperCollider/Extensions"]      # panicos ingenue runs as root
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
# Wrong-arch UGen detect + heal (F+G+I)
# ---------------------------------------------------------------------------
# Distinct from scplugins_status/heal above: this catches the case where a SCRIPT
# (e.g. tapedeck's scinstaller, amenbreak's runtime "install tapedeck" button)
# DROPS arch-mismatched .so files into a SC Extensions dir at runtime. scsynth
# silently fails to load them; scripts run but their engines are dead.
#
# Validated manually 2026-06-06 on panicos (aarch64): 6 32-bit PortedPlugins .so
# files at ~/.local/share/SuperCollider/Extensions/supercollider-plugins/ were
# downloaded by tapedeck's scinstaller (PortedPlugins-RaspberryPi.zip is 32-bit).
# Moving them out + dropping ingenue's bundled 64-bit copies in the same path
# fixed tapedeck loads (scinstaller's :ready() check is filename-only, no arch
# verify) and eliminated the silent-engine class of lfos OSC noise.
def wrong_arch_so_files():
    """Walk every SC Extensions dir, classify each .so by ELF arch, return list
    of arch-mismatches against the host's scsynth ELF arch. Returns
    [{path, basename, found_arch, want_arch}].

    Used by the Health panel + the heal endpoint below."""
    machine, _ = host_arch()
    want = ARCH_ELF.get(machine)
    if not want:
        return []                                            # unknown host — can't classify
    out = []
    for d in sc_ext_dirs():
        for root, _dirs, files in os.walk(d):
            for f in files:
                if not f.endswith(".so"):
                    continue
                path = os.path.join(root, f)
                a = elf_arch(path)
                if not a:
                    continue                                 # not an ELF
                if a[1] != want:
                    out.append({"path": path, "basename": f,
                                "found_arch": a[1], "want_arch": want})
    return out


def heal_wrong_arch_sc():
    """For every wrong-arch .so found by wrong_arch_so_files():
      1. Move it to <home>/.ingenue-backups/wrong-arch-sc/<ts>/<basename> (reversible)
      2. If ingenue's bundled .tar.gz has a correct-arch counterpart with the
         same basename, copy it into the SAME dir the wrong-arch was in (so
         scripts whose installer is filename-only — like tapedeck's scinstaller
         — find what they expect, and the user doesn't get re-prompted to
         install the same broken zip again).

    Returns {fixed_count, replaced_count, fixed:[{basename, from_dir, found_arch, replaced:bool}], backup_dir, log[]}.
    Idempotent: re-running with no wrong-arch .so on disk is a no-op."""
    import tarfile
    mismatches = wrong_arch_so_files()
    if not mismatches:
        return {"ok": True, "fixed_count": 0, "replaced_count": 0,
                "fixed": [], "log": ["no wrong-arch .so files found"]}

    machine, _ = host_arch()
    want = ARCH_ELF.get(machine)
    _, _, _, home = target_owner()
    backups_root = os.path.join(home or "/tmp", ".ingenue-backups", "wrong-arch-sc")
    ts = time.strftime("%Y%m%dT%H%M%S")
    backup_dir = os.path.join(backups_root, ts)
    os.makedirs(backup_dir, exist_ok=True)

    # Pre-index the bundle: basename -> tar-member-name, so we know which wrong-
    # arch .so files we CAN swap with a correct-arch counterpart vs only move out.
    bundle_index = {}
    bp = bundle_path()
    bundle_temp = None
    if bp:
        try:
            with tarfile.open(bp, "r:gz") as tf:
                for n in tf.getnames():
                    if n.endswith(".so"):
                        bundle_index[os.path.basename(n)] = n
        except Exception:  # noqa: BLE001
            pass

    log = [f"backup dir: {backup_dir}"]
    fixed = []
    replaced_count = 0
    extracted = {}                                           # basename -> extracted-path, to avoid re-extract
    try:
        for m in mismatches:
            src = m["path"]
            dst = os.path.join(backup_dir, m["basename"])
            try:
                # avoid name collisions in the backup dir for duplicate basenames
                if os.path.exists(dst):
                    dst = os.path.join(backup_dir, m["basename"] + "." + os.path.basename(os.path.dirname(src)))
                os.rename(src, dst)
                log.append(f"backed up {m['basename']} ({m['found_arch']}) → backup_dir")
            except OSError as e:
                log.append(f"! couldn't move {src}: {e}")
                continue
            # Try to drop a correct-arch counterpart from the bundle into the
            # same dir the wrong-arch was in (preserves the path scripts check).
            replaced = False
            if m["basename"] in bundle_index:
                try:
                    if bundle_temp is None:
                        import tempfile
                        bundle_temp = tempfile.mkdtemp(prefix="ing_arch_heal_")
                        with tarfile.open(bp, "r:gz") as tf:
                            tf.extractall(bundle_temp)       # nosec: our own bundle
                    src_in_bundle = os.path.join(bundle_temp, bundle_index[m["basename"]])
                    dst_in_dir = os.path.join(os.path.dirname(src), m["basename"])
                    shutil.copy2(src_in_bundle, dst_in_dir)
                    replaced = True
                    replaced_count += 1
                    log.append(f"  replaced with correct-arch ({want}) copy from bundle")
                    # match dust owner
                    uid, gid, _, _ = target_owner()
                    if os.getuid() == 0 and uid != 0:
                        try: os.lchown(dst_in_dir, uid, gid)
                        except OSError: pass
                except Exception as e:  # noqa: BLE001
                    log.append(f"  ! couldn't extract replacement: {e}")
            else:
                log.append(f"  no {want} replacement in bundle — wrong-arch removed, leave .so missing")
            fixed.append({"basename": m["basename"],
                          "from_dir": os.path.dirname(src),
                          "found_arch": m["found_arch"],
                          "replaced": replaced})
    finally:
        if bundle_temp:
            shutil.rmtree(bundle_temp, ignore_errors=True)
        uid, gid, _, _ = target_owner()
        if os.getuid() == 0 and uid != 0:
            try: chown_path(backups_root, uid, gid)
            except OSError: pass
    return {"ok": True, "fixed_count": len(fixed),
            "replaced_count": replaced_count,
            "fixed": fixed, "backup_dir": backup_dir,
            "reboot_required": bool(fixed),
            "log": "\n".join(log)}


# ---------------------------------------------------------------------------
# sclang class-library config health (the "duplicate Class aborts everything" /
# "langPort drift mutes every nb voice" class)
# ---------------------------------------------------------------------------
# Distinct from scplugins_* above (which is about UGen *binary* arch). This is
# about sclang's *class library* config: norns generates sclang_conf.yaml with
# include/exclude paths. Two failure modes silently break scripts wholesale:
#   1. A plugin shipped a double-nested duplicate class tree (<ext>/<name>/<name>/
#      Classes/) that the active excludePaths does NOT suppress -> sclang aborts
#      the WHOLE class library with "duplicate Class" -> every script dies.
#   2. sclang lost the langPort race and bound 57121+ instead of 57120 -> nb mods
#      and matron OSC (all hardcoded to 57120) talk to nothing, no error.
# We also warn (3) when an excluded path hides real .sc classes a script needs.

def sclang_conf_path():
    """Locate the active norns sclang_conf.yaml (port HOME first, then DUST-relative)."""
    cands = []
    h = os.environ.get("HOME")
    if h:
        cands.append(os.path.join(h, "norns", "sclang_conf.yaml"))
    cands += [os.path.join(DUST, "..", "norns", "sclang_conf.yaml"),
              os.path.join(DUST, "..", "sclang_conf.yaml"),
              os.path.expanduser("~/.local/share/SuperCollider/sclang_conf.yaml")]
    for p in cands:
        rp = os.path.realpath(p)
        if os.path.isfile(rp):
            return rp
    return None


def _parse_sclang_conf(path):
    """Read the include/exclude path lists. The file is machine-generated with a
    fixed, flat shape, so a line scanner is safe and keeps the server stdlib-only
    (no PyYAML dependency)."""
    section, inc, exc = None, [], []
    try:
        with open(path) as f:
            for line in f:
                t = line.strip()
                if not t or t.startswith("#"):
                    continue
                if t.endswith(":") and not t.startswith("-"):
                    section = t[:-1].strip()
                elif t.startswith("- "):
                    (inc if section == "includePaths" else
                     exc if section == "excludePaths" else []).append(t[2:].strip())
    except OSError:
        return None
    return {"includePaths": inc, "excludePaths": exc}


def _nested_dup_dirs():
    """Collections shipping the packaging-bug double-nested tree <ext>/<name>/<name>/,
    whose inner copy duplicates the flat top-level classes. -> [(collection, inner)]."""
    out = []
    for d in sc_ext_dirs():
        try:
            for name in os.listdir(d):
                coll = os.path.join(d, name)
                inner = os.path.join(coll, name)
                if os.path.isdir(coll) and os.path.isdir(inner):
                    out.append((coll, inner))
        except OSError:
            continue
    return out


def _count_sc(path):
    n = 0
    for _root, _dirs, files in os.walk(path):
        n += sum(1 for f in files if f.endswith(".sc"))
    return n


def _excluded(real_path, excl_real):
    """True if real_path is one of, or sits under, an excluded path."""
    return any(real_path == e or real_path.startswith(e + os.sep) for e in excl_real)


def _langport_state(port=57120):
    """Is `port` bound as a UDP socket, while sclang is running? If sclang is up
    but 57120 is unbound, it drifted to 57121+ (the race)."""
    sclang = proc_pid("sclang")
    hexport = f"{port:04X}"
    bound = False
    for pf in ("/proc/net/udp", "/proc/net/udp6"):
        try:
            with open(pf) as f:
                next(f, None)                       # skip header
                for line in f:
                    cols = line.split()
                    if len(cols) > 1 and cols[1].split(":")[-1].upper() == hexport:
                        bound = True
                        break
        except OSError:
            continue
        if bound:
            break
    return {"sclang_up": bool(sclang), "sclang_pid": sclang, "port": port,
            "bound": bound}


def _localhost_resolution(port=57120):
    """How getaddrinfo orders 'localhost'. Kept as a diagnostic in the
    sclang_config_check report; no longer drives a heal (the IPv4-precedence
    fix this enabled produced a misleading persistent banner and could not be
    verified to actually change nb-voice behaviour on the affected device)."""
    import socket
    try:
        res = socket.getaddrinfo("localhost", port, proto=socket.IPPROTO_UDP)
    except Exception:  # noqa: BLE001
        return None
    fams = [r[0] for r in res]
    return {
        "addrs": [r[4][0] for r in res],
        "has_v4": socket.AF_INET in fams,
        "has_v6": socket.AF_INET6 in fams,
        "ipv6_first": bool(fams) and fams[0] == socket.AF_INET6,
    }


def sclang_config_check():
    """Diagnose sclang class-library config. Mirrors scplugins_status() shape."""
    machine, is64 = host_arch()
    conf = sclang_conf_path()
    parsed = _parse_sclang_conf(conf) if conf else None
    excl = parsed["excludePaths"] if parsed else []
    excl_real = {os.path.realpath(p) for p in excl}
    nested = _nested_dup_dirs()
    issues = []

    # 1 (critical, fixable): nested duplicate trees not covered by excludePaths.
    uncovered = [inner for _c, inner in nested
                 if not _excluded(os.path.realpath(inner), excl_real)]
    if uncovered:
        issues.append({
            "code": "duplicate_classes", "severity": "critical", "fixable": True,
            "detail": (f"{len(uncovered)} plugin collection(s) ship a double-nested duplicate "
                       "class tree the active sclang_conf does NOT exclude; sclang aborts the "
                       "entire class library with 'duplicate Class' and every script breaks"),
            "paths": uncovered[:12]})

    # 2 (warning, manual): an excluded path hides real .sc classes a script needs.
    # A nested-dup inner dir legitimately holds .sc (excluding it is the point) — skip those.
    nested_inner_real = {os.path.realpath(inner) for _c, inner in nested}
    hidden = []
    for e in excl_real:
        if os.path.isdir(e) and not _excluded(e, nested_inner_real):
            n = _count_sc(e)
            if n:
                hidden.append({"path": e, "sc_count": n})
    if hidden:
        issues.append({
            "code": "excluded_classes", "severity": "warning", "fixable": False,
            "detail": ("an excluded path contains .sc class files that will NOT compile — a "
                       "script-installed engine there fails to load; confirm the exclusion is intended"),
            "paths": hidden[:12]})

    # 3 (critical, reboot): sclang up but langPort 57120 unbound -> drifted to 57121+.
    lp = _langport_state()
    if lp["sclang_up"] and not lp["bound"]:
        issues.append({
            "code": "langport_drift", "severity": "critical", "fixable": False,
            "detail": ("sclang is running but langPort 57120 is unbound — it drifted to 57121+; "
                       "nb mods and matron OSC (hardcoded to 57120) silently miss. Reboot so the "
                       "launcher frees 57120 before sclang starts"),
            "info": lp})

    # NOTE: a "localhost resolves IPv6-first" check used to live here (with a
    # /etc/gai.conf-based heal). Removed 2026-06-06 — the detector had a
    # substring-match bug (matched the commented-out documentation line in the
    # default gai.conf, so it would falsely report "already_staged"), the heal
    # could not be verified to actually change nb-voice behaviour on the
    # affected device, and the persistent "reboot to apply" banner misled users
    # into thinking they had a real problem. If nb-voice silence ever turns
    # out to be a real localhost-resolution issue on some setup, reintroduce
    # this with a runtime UDP-probe test (send to "localhost":57120 from
    # python, verify sclang received it) rather than a getaddrinfo guess.
    lr = _localhost_resolution()                                          # kept for diagnostics

    return {
        "host_arch": machine, "is_64bit": is64,
        "sclang_conf": conf, "conf_found": bool(conf),
        "nested_dup_collections": len(nested),
        "excludePaths": excl, "langport": lp, "localhost": lr,
        "issues": issues, "ok": not issues,
        "can_fix": any(i["fixable"] for i in issues),
        "reboot_required": any(i["code"] == "langport_drift" for i in issues),
        "hint": ("sclang / nb-voice config looks healthy" if not issues
                 else f"{len(issues)} sclang / nb-voice issue(s) detected"),
    }


def sclang_config_heal():
    """Repair the silently-fatal sclang/nb config conditions, idempotent and
    backed up first, taking effect on the next boot:
      (a) double-nested duplicate class trees -> exclude them in sclang_conf.yaml
          so sclang stops aborting the whole class library with 'duplicate Class'.
    (The /etc/gai.conf IPv4-precedence heal that used to live here was removed —
    see the note in sclang_config_check for why.)"""
    log, changed, reboot = [], False, False

    # (a) duplicate class trees in sclang_conf.yaml
    conf = sclang_conf_path()
    added = []
    if conf:
        parsed = _parse_sclang_conf(conf)
        if parsed is None:
            log.append(f"could not read {conf}")
        else:
            excl = list(parsed["excludePaths"])
            excl_real = {os.path.realpath(p) for p in excl}
            for _c, inner in _nested_dup_dirs():
                if not _excluded(os.path.realpath(inner), excl_real):
                    excl.append(inner); excl_real.add(os.path.realpath(inner)); added.append(inner)
            if added:
                try:
                    shutil.copy2(conf, conf + ".ingenue.bak")
                    with open(conf, "w") as f:
                        f.write("includePaths:\n")
                        for p in parsed["includePaths"]:
                            f.write(f"    - {p}\n")
                        f.write("excludePaths:\n")
                        for p in excl:
                            f.write(f"    - {p}\n")
                        f.write("postInlinePaths: []\n")
                    changed = True; reboot = True
                    log.append(f"excluded {len(added)} duplicate class tree(s) in "
                               f"{os.path.basename(conf)} (backup .ingenue.bak); note the launcher "
                               "also regenerates this each boot")
                except OSError as e:
                    log.append(f"could not repair {os.path.basename(conf)}: {e}")

    # (b) the /etc/gai.conf IPv4-precedence heal that used to live here was
    # removed — see sclang_config_check for the rationale.

    if not log:
        log.append("sclang / nb-voice config already healthy; nothing to repair")
    return {"ok": True, "changed": changed, "added": added, "reboot_required": reboot,
            "log": "\n".join(log)}


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
    try:
        entries = os.listdir("/proc")
    except OSError:
        return None                      # no /proc (off-device) — degrade gracefully
    for d in entries:
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


def sysinfo():
    u = os.uname()
    ip = ""
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80)); ip = s.getsockname()[0]; s.close()
    except Exception:  # noqa: BLE001
        pass
    return {"hostname": u.nodename, "ip": ip, "arch": u.machine,
            "system": f"{u.sysname} {u.release}", "port": PORT,
            "dust": DUST, "python": sys.version.split()[0]}


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
        if name.startswith(".") or name == "ingenue":      # ingenue is always-on infra (systemd service), never a toggleable mod
            continue
        if os.path.isfile(os.path.join(CODE, name, "lib", "mod.lua")):
            out.append({"name": name, "enabled": name in enabled})
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


def _gh_default_branch(owner, repo):
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{owner}/{repo}",
                                     headers={"User-Agent": "ingenue"})
        with urllib.request.urlopen(req, timeout=6) as r:
            return json.loads(r.read()).get("default_branch") or "main"
    except Exception:  # noqa: BLE001
        return "main"


def fetch_readme(url):
    owner, repo = _gh_owner_repo(url)
    if not owner:
        return {"error": "not a github url", "images": [], "text": "", "has_images": False}
    try:
        req = urllib.request.Request(
            f"https://api.github.com/repos/{owner}/{repo}/readme",
            headers={"User-Agent": "ingenue", "Accept": "application/vnd.github.raw"})
        with urllib.request.urlopen(req, timeout=8) as r:
            md = r.read().decode("utf-8", "replace")
    except Exception as e:  # noqa: BLE001
        return {"error": f"no README ({e.__class__.__name__})", "images": [], "text": "", "has_images": False}
    branch = _gh_default_branch(owner, repo)            # resolve master-vs-main so relative images load
    base = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/"
    raw = []
    for u in re.findall(r'!\[[^\]]*\]\(([^)\s]+)', md) + re.findall(r'<img[^>]+src=["\']([^"\']+)', md):
        u = u.strip()
        if u.startswith("data:"):
            continue
        if u.startswith("http"):
            # convert github blob/raw page URLs to raw content
            u = re.sub(r"https?://github\.com/([^/]+/[^/]+)/(?:blob|raw)/",
                       r"https://raw.githubusercontent.com/\1/", u)
        else:
            u = base + u.lstrip("./")
        raw.append(u)
    # description = first real prose paragraph
    desc = ""
    for para in re.split(r"\n\s*\n", md):
        s = re.sub(r"`{1,3}", "", para).strip()
        if s and not s.startswith(("#", "!", "<", "|", "-", "*", "[![")) and len(s) > 30:
            desc = re.sub(r"\s+", " ", s)[:600]
            break
    seen, imgs = set(), []
    for u in raw:
        if u in seen:
            continue
        if re.search(r"shields\.io|/badge/|badgen\.net|travis-ci|circleci|githubusercontent\.com/.*\b(badge)\b", u, re.I):
            continue                                    # drop CI/badges, not real screenshots
        if re.search(r"\.(png|jpe?g|gif|webp)(\?|$)", u, re.I):
            seen.add(u); imgs.append(u)
    return {"owner": owner, "repo": repo, "branch": branch, "text": desc,
            "images": imgs[:12], "has_images": bool(imgs), "has_readme": bool(md.strip())}


def fetch_community(name_or_url):
    """README description + images for a community script from norns.community — a static
    GitHub Pages site (no API rate limit, unlike api.github.com's 60/hr). The browser can't
    fetch it (no CORS headers), so the server does. Pass the exact comm URL when known,
    else we derive the slug from the catalog name."""
    # SSRF-safe: never fetch a caller-supplied URL. Accept either a bare name or a
    # norns.community URL, but always rebuild the request against the pinned host + a
    # sanitized slug, and refuse redirects so a 302 can't pivot to an internal address.
    s = (name_or_url or "").strip()
    if s.startswith("http"):
        pu = urllib.parse.urlparse(s)
        if (pu.hostname or "").lower().rstrip(".") != "norns.community":
            return {"error": "not a norns.community url", "images": [], "text": ""}
        slug = pu.path.strip("/").split("/")[0]
    else:
        slug = s
    slug = re.sub(r"\s+", "-", slug.lower())
    if not slug or not re.fullmatch(r"[a-z0-9._-]+", slug):
        return {"error": "bad name", "images": [], "text": ""}
    url = "https://norns.community/" + urllib.parse.quote(slug) + "/"
    try:
        class _NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):  # block redirect-pivot
                return None
        opener = urllib.request.build_opener(_NoRedirect)
        req = urllib.request.Request(url, headers={"User-Agent": "ingenue"})
        with opener.open(req, timeout=8) as r:
            html = r.read(2_000_000).decode("utf-8", "replace")   # cap body
    except Exception as e:  # noqa: BLE001
        return {"error": f"no community page ({e.__class__.__name__})", "images": [], "text": ""}
    desc = ""
    m = re.search(r'<meta name="description" content="([^"]*)"', html)
    if m:
        desc = re.sub(r"\s+", " ", m.group(1)).strip()
    seen, imgs = set(), []
    for u in re.findall(r'<img[^>]+src=["\']([^"\']+)', html):
        u = u.strip()
        if u.startswith("//"):
            u = "https:" + u
        elif u.startswith("/"):
            u = "https://norns.community" + u
        if not u.startswith("http") or u in seen:
            continue
        if re.search(r"shields\.io|/badge/|badgen\.net|avatars\.|/favicon", u, re.I):
            continue
        if re.search(r"\.(png|jpe?g|gif|webp)(\?|$)", u, re.I):
            seen.add(u)
            imgs.append(u)
    return {"text": desc, "images": imgs[:12], "source": "norns.community"}


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
            if path == "/api/job":
                q = self._q()
                job = get_job(q.get("id", [""])[0])
                if not job:
                    return self._json({"error": "no such job", "gone": True}, 404)
                try: frm = int(q.get("from", ["0"])[0] or 0)
                except ValueError: frm = 0
                return self._json(job.snapshot(frm))
            if path == "/api/giturl":
                full, name = safe_script_dir(self._q().get("name", [""])[0])
                if not os.path.isdir(full):
                    return self._json({"error": "not installed"}, 404)
                # Now also surfaces current SHA + maiden-style .project metadata
                # (installed_on / updated_on / catalog_entry) so the UI can
                # render install provenance and offer rollback.
                md = read_project_metadata(full)
                return self._json({"name": name, "url": git_remote(full),
                                   "sha": git_current_sha(full),
                                   "project": md})
            if path == "/api/history":
                # Last 10 commits for the UI rollback picker. Empty if the
                # script wasn't cloned with full history (older ingenue installs).
                full, name = safe_script_dir(self._q().get("name", [""])[0])
                if not os.path.isdir(full):
                    return self._json({"error": "not installed"}, 404)
                return self._json({"name": name,
                                   "current": git_current_sha(full),
                                   "history": git_history(full)})
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
            if path == "/api/sclang":
                return self._json(sclang_config_check())
            if path == "/api/version":
                return self._json({"sha": installed_sha(),
                                   "repo": "seajaysec/ingenue", "branch": "main"})
            if path == "/api/sysinfo":
                return self._json(sysinfo())
            if path == "/api/ownership":
                return self._json(ownership_status())
            if path == "/api/health":
                # Multi-check aggregator for the config Health panel.
                # Self-describing — see health_overview().
                return self._json(health_overview())
            if path == "/api/audio":
                return self._json(audio_status())
            if path == "/api/mods":
                return self._json(list_mods())
            if path == "/api/readme":
                return self._json(fetch_readme(self._q().get("url", [""])[0]))
            if path == "/api/community":
                q = self._q()
                return self._json(fetch_community(q.get("comm", q.get("name", [""]))[0]))
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
            n = int(self.headers.get("Content-Length", 0))      # raw body verbatim (don't json-parse — files may be JSON/binary)
            data = self.rfile.read(n) if n else b""
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
                # rmtree(onerror=...) lets us collect per-file errors instead of
                # aborting on the first one. Then verify nothing survived — that's
                # the only honest signal of "actually removed". The historical bug
                # we're closing: a root-owned script (from a prior buggy ingenue
                # install) couldn't be removed by a non-root ingenue, but the old
                # path either swallowed errors or surfaced a generic 500; the UI
                # showed "removed" but the dir was still on disk.
                errs = []
                def _rmerr(fn, p, einfo):
                    errs.append({"path": os.path.relpath(p, full) or ".",
                                 "error": str(einfo[1])})
                shutil.rmtree(full, onerror=_rmerr)
                if os.path.exists(full):
                    survivors = []
                    for root, dirs, files in os.walk(full):
                        for x in dirs + files:
                            survivors.append(os.path.relpath(os.path.join(root, x), full))
                            if len(survivors) >= 8: break
                        if len(survivors) >= 8: break
                    return self._json({
                        "error": f"{name} not fully removed — {len(survivors)} item(s) remain",
                        "survivors": survivors,
                        "first_errors": errs[:5],
                        "hint": "open Configuration > Heal Installations to fix ownership, then retry"
                    }, 500)
                return self._json({"ok": True, "removed": name})
            if path == "/api/scplugins/heal":
                return self._json(scplugins_heal(b.get("source", "bundled"), (b.get("url") or "").strip()))
            if path == "/api/scplugins/heal-wrong-arch":
                # Move every arch-mismatched .so under SC Extensions dirs to
                # backup, replace with bundled correct-arch where possible.
                # See heal_wrong_arch_sc() for the rationale (panicos tapedeck
                # silent-engine class).
                try:
                    return self._json(heal_wrong_arch_sc())
                except OSError as e:
                    return self._json({"error": str(e)}, 500)
            if path == "/api/sclang/heal":
                return self._json(sclang_config_heal())
            if path == "/api/heal-ownership":
                return self._json(heal_ownership())
            if path == "/api/health/bangs/heal":
                # Batch heal: scans all installed mods, patches every
                # bang-in-add_params line in enabled mods at once. Body may
                # set {only_enabled:false} to also patch disabled mods.
                only_enabled = True
                if isinstance(b, dict) and "only_enabled" in b:
                    only_enabled = bool(b["only_enabled"])
                try:
                    return self._json(heal_all_mod_bangs(only_enabled=only_enabled))
                except OSError as e:
                    return self._json({"error": str(e)}, 500)
            if path == "/api/heal-bang":
                # EXPERIMENTAL — comments out `params:bang()` (no-arg) calls
                # inside add_params functions in the named mod's lib/mod.lua.
                # Idempotent + reversible (git checkout reverts). See heal_mod_bang.
                full, name = safe_script_dir(b.get("name"))
                if not os.path.isdir(full):
                    return self._json({"error": f"{name} is not installed"}, 404)
                try:
                    return self._json(heal_mod_bang(full))
                except OSError as e:
                    return self._json({"error": str(e)}, 500)
            if path == "/api/self-update":
                return self._json(self_update())
            if path == "/api/audio/restart":
                return self._json(audio_restart())
            if path == "/api/mods/toggle":
                return self._json(toggle_mod(b.get("name"), bool(b.get("on"))))
            if path == "/api/mkdir":
                full = safe(b.get("path", ""))
                os.makedirs(full, exist_ok=True)
                return self._json({"ok": True})
            if path == "/api/rename":
                src = safe(b.get("from", "")); dst = safe(b.get("to", ""))
                if not os.path.exists(src):
                    return self._json({"error": "source not found"}, 404)
                if os.path.exists(dst):
                    return self._json({"error": "target already exists"}, 409)
                os.rename(src, dst)
                return self._json({"ok": True})
            if path == "/api/rm":
                full = safe(b.get("path", ""))
                if full == os.path.realpath(DUST):
                    return self._json({"error": "refusing to delete the dust root"}, 400)
                if os.path.isdir(full):
                    shutil.rmtree(full)
                elif os.path.isfile(full):
                    os.remove(full)
                else:
                    return self._json({"error": "not found"}, 404)
                return self._json({"ok": True})
            if path == "/api/heal":
                full, name = safe_script_dir(b.get("name"))
                if not find_installer(full):
                    return self._json({"error": f"{name} has no install.sh to run"}, 404)
                # Runs in a worker thread that holds the busy lock for its whole life —
                # serializes against self-update (which would SIGKILL the build) and
                # streams its output into a job the UI polls. 409 if already busy.
                jid, busy = start_job("heal", name, "heal",
                                      lambda emit: run_install(full, emit))
                if busy:
                    return self._json({"error": busy}, 409)
                return self._json({"ok": True, "job": jid, "name": name})
            if path == "/api/install":
                full, name = safe_script_dir(b.get("name"))
                url = (b.get("url") or "").strip()
                sha = (b.get("sha") or "").strip() or None
                catalog_entry = b.get("catalog_entry") if isinstance(b.get("catalog_entry"), dict) else None
                if not url.startswith(("http://", "https://", "git@")):
                    return self._json({"error": "no/invalid git url"}, 400)
                if os.path.isdir(full):
                    if b.get("force"):
                        # Non-destructive replace: move the prior tree to
                        # <CODE>/.deleted/<name>.<timestamp>/ instead of rmtree.
                        # Recoverable if the user (or another agent) realises
                        # the reinstall was a mistake; the .deleted dir is
                        # hidden so it doesn't pollute the installed list.
                        try:
                            backup_script_dir(full, name)
                        except OSError as e:
                            return self._json({"error": f"backup-rename failed: {e}"}, 500)
                    else:
                        return self._json({"error": f"{name} already installed"}, 409)
                # Same worker+lock model as heal: streams the clone, 409 if busy.
                jid, busy = start_job("install", name, "install",
                                      lambda emit: do_clone(full, url, emit,
                                                             sha=sha, catalog_entry=catalog_entry))
                if busy:
                    return self._json({"error": busy}, 409)
                return self._json({"ok": True, "job": jid, "name": name})
            if path == "/api/update":
                # git fetch + reset --hard, non-destructive — preserves .project,
                # untracked user files, and crucially the .git directory so
                # rollback remains possible. The maiden-equivalent of pull-on-update.
                full, name = safe_script_dir(b.get("name"))
                if not os.path.isdir(full):
                    return self._json({"error": f"{name} is not installed"}, 404)
                jid, busy = start_job("update", name, "update",
                                      lambda emit: do_update(full, emit))
                if busy:
                    return self._json({"error": busy}, 409)
                return self._json({"ok": True, "job": jid, "name": name})
            if path == "/api/rollback":
                # Roll a script back to an arbitrary git ref (SHA, tag, HEAD~1).
                # Requires the script to have been cloned with history (do_clone
                # since b62+). UI surfaces last 10 commits via /api/history.
                full, name = safe_script_dir(b.get("name"))
                target = (b.get("target") or "").strip()
                if not target:
                    return self._json({"error": "target SHA or ref required"}, 400)
                if not os.path.isdir(full):
                    return self._json({"error": f"{name} is not installed"}, 404)
                jid, busy = start_job("rollback", name, "rollback",
                                      lambda emit: do_rollback(full, target, emit))
                if busy:
                    return self._json({"error": busy}, 409)
                return self._json({"ok": True, "job": jid, "name": name})
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        except subprocess.TimeoutExpired:
            return self._json({"error": "git clone timed out"}, 504)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, 500)
        return self._json({"error": "not found"}, 404)

    def log_message(self, *a):
        pass


def main():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("0.0.0.0", PORT), H) as httpd:
        print(f"ingenue backend on 0.0.0.0:{PORT}  (dust={DUST}, exists={os.path.isdir(CODE)})", flush=True)
        httpd.serve_forever()


# Importable for tests/tooling; only binds the port when run as a script
# (the device launches it via `python3 server.py 7777`).
if __name__ == "__main__":
    main()
