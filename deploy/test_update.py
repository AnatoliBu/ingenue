#!/usr/bin/env python3
"""Hermetic test for do_update() branch resolution (the per-script Update fix).

Builds throwaway local git "remotes" (no network, no device) and verifies that
do_update() advances a working copy to upstream's latest commit for:
  - default branch `master`, origin/HEAD UNSET   <- the case the old code broke
  - default branch `main`,   origin/HEAD UNSET
  - default branch `master`, with a NEW upstream commit, detached HEAD checkout

The old do_update hardcoded a fallback to origin/main, so the master cases
failed with "git reset --hard exited 128". This test would fail against that.

Run:  python3 deploy/test_update.py
"""
import os, sys, subprocess, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "web"))
import server  # noqa: E402


def git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   capture_output=True, text=True)


def head_sha(cwd):
    return subprocess.run(["git", "-C", cwd, "rev-parse", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()


def make_remote(root, branch):
    """Create a bare 'remote' on the given default branch with commit #1.
    Returns (remote_path, seed_workdir) so the caller can add more commits."""
    remote = os.path.join(root, "remote.git")
    seed = os.path.join(root, "seed")
    git(root, "init", "--bare", "--initial-branch", branch, "remote.git")
    subprocess.run(["git", "clone", remote, seed], check=True,
                   capture_output=True, text=True)
    git(seed, "config", "user.email", "t@t"); git(seed, "config", "user.name", "t")
    git(seed, "checkout", "-B", branch)
    with open(os.path.join(seed, "f.txt"), "w") as f:
        f.write("v1\n")
    git(seed, "add", "."); git(seed, "commit", "-m", "v1")
    git(seed, "push", "-u", "origin", branch)
    return remote, seed


def push_new_commit(seed, branch, text):
    git(seed, "checkout", branch)
    with open(os.path.join(seed, "f.txt"), "w") as f:
        f.write(text)
    git(seed, "commit", "-am", text)
    git(seed, "push", "origin", branch)
    return head_sha(seed)


def clone_with_unset_head(remote, dest):
    """Clone, then delete refs/remotes/origin/HEAD to reproduce the real-device
    state (maiden / old-ingenue installs have no origin/HEAD)."""
    subprocess.run(["git", "clone", remote, dest], check=True,
                   capture_output=True, text=True)
    git(dest, "config", "user.email", "t@t"); git(dest, "config", "user.name", "t")
    subprocess.run(["git", "-C", dest, "remote", "set-head", "origin", "-d"],
                   capture_output=True, text=True)  # ignore if already unset
    assert server._git_out(dest, ["symbolic-ref", "refs/remotes/origin/HEAD"]) == "", \
        "precondition failed: origin/HEAD should be unset"


def case(root, branch, detach=False):
    sub = os.path.join(root, branch + ("_det" if detach else ""))
    os.makedirs(sub)
    remote, seed = make_remote(sub, branch)
    work = os.path.join(sub, "work")
    clone_with_unset_head(remote, work)
    if detach:
        git(work, "checkout", "--detach", "HEAD")
    want = push_new_commit(seed, branch, "v2-on-" + branch)
    before = head_sha(work)
    assert before != want, "setup: work should be behind remote"
    ok, err = server.do_update(work, lambda _l: None)
    after = head_sha(work)
    label = f"{branch}{' (detached)' if detach else ''}, origin/HEAD unset"
    if not ok:
        return False, f"{label}: do_update failed: {err}"
    if after != want:
        return False, f"{label}: HEAD not advanced (got {after[:7]}, want {want[:7]})"
    return True, f"{label}: updated {before[:7]} -> {after[:7]} OK"


def main():
    root = tempfile.mkdtemp(prefix="ingenue-upd-")
    try:
        results = [
            case(root, "master"),            # the case the old code broke
            case(root, "main"),              # worked before, must still work
            case(root, "master", detach=True),  # rolled-back then update
        ]
        ok = all(r[0] for r in results)
        for good, msg in results:
            print(("PASS: " if good else "FAIL: ") + msg)
        return 0 if ok else 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
