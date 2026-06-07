#!/usr/bin/env python3
"""Hermetic test for the update-detection scan (_check_one_update).

Uses local bare git "remotes" (ls-remote works on file:// paths) and asserts:
  - up-to-date repo (master)        -> behind == False
  - behind repo (master, unset HEAD)-> behind == True
  - up-to-date repo (main)          -> behind == False
  - behind repo (main)              -> behind == True
  - non-git directory               -> error, behind == False

Run:  python3 deploy/test_check_updates.py
"""
import os, sys, subprocess, tempfile, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "web"))
import server  # noqa: E402


def git(cwd, *a):
    subprocess.run(["git", "-C", cwd, *a], check=True, capture_output=True, text=True)


def make_repo(root, branch, behind, unset_head):
    """Create bare remote + a working clone. If behind, push an extra commit to
    the remote that the clone doesn't have. Returns the clone path."""
    os.makedirs(root, exist_ok=True)
    remote = os.path.join(root, "r.git")
    seed = os.path.join(root, "seed")
    git(root, "init", "--bare", "--initial-branch", branch, "r.git")
    subprocess.run(["git", "clone", remote, seed], check=True, capture_output=True, text=True)
    git(seed, "config", "user.email", "t@t"); git(seed, "config", "user.name", "t")
    git(seed, "checkout", "-B", branch)
    open(os.path.join(seed, "f.txt"), "w").write("1\n")
    git(seed, "add", "."); git(seed, "commit", "-m", "1"); git(seed, "push", "-u", "origin", branch)
    work = os.path.join(root, "work")
    subprocess.run(["git", "clone", remote, work], check=True, capture_output=True, text=True)
    git(work, "config", "user.email", "t@t"); git(work, "config", "user.name", "t")
    if unset_head:
        subprocess.run(["git", "-C", work, "remote", "set-head", "origin", "-d"],
                       capture_output=True, text=True)
    if behind:                                  # advance the remote past the clone
        open(os.path.join(seed, "f.txt"), "w").write("2\n")
        git(seed, "commit", "-am", "2"); git(seed, "push", "origin", branch)
    return work


def main():
    root = tempfile.mkdtemp(prefix="ingenue-chk-")
    run_as = (None, None)   # tests run as the current (non-root) user
    try:
        fails = []

        def check(label, work, want_behind, want_error=False):
            r = server._check_one_update(work, os.path.basename(work), run_as)
            if want_error:
                if not r.get("error"):
                    fails.append(f"{label}: expected an error, got {r}")
                return
            if r.get("error"):
                fails.append(f"{label}: unexpected error: {r['error']}")
            elif bool(r.get("behind")) != want_behind:
                fails.append(f"{label}: behind={r.get('behind')} want {want_behind} ({r})")
            else:
                print(f"PASS: {label}: behind={r.get('behind')} branch={r.get('branch')}")

        check("master up-to-date", make_repo(os.path.join(root, "a"), "master", False, True), False)
        check("master behind (unset HEAD)", make_repo(os.path.join(root, "b"), "master", True, True), True)
        check("main up-to-date", make_repo(os.path.join(root, "c"), "main", False, False), False)
        check("main behind", make_repo(os.path.join(root, "d"), "main", True, False), True)

        nogit = os.path.join(root, "nogit"); os.makedirs(nogit)
        check("non-git dir", nogit, False, want_error=True)
        if not server._check_one_update(nogit, "nogit", run_as).get("error"):
            pass  # already covered

        if fails:
            print("\nFAIL:")
            for f in fails:
                print("  -", f)
            return 1
        print("\nall scan cases passed")
        return 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
