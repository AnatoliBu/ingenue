# ingenue — notes for agents

ingenue is a responsive browser UI for [monome norns](https://monome.org/docs/norns/):
a Python web server (`web/server.py`) on **:7777** plus a single-file frontend
(`web/index.html`), served from the device alongside maiden (:5000).

## ⚠️ Launch model — do NOT add a systemd service on PanicOS

ingenue is launched **from within the norns session**, not as a standalone OS-level
service. On PanicOS the port launcher `/storage/roms/ports/Norns.sh` starts
`python3 server.py 7777` when norns launches and stops it on exit.

**Do NOT create or enable a systemd `ingenue.service` on a device that already
launches ingenue from norns.** Two launchers then fight over :7777 and the loser
crash-loops forever on `Address already in use`. A previous well-meaning agent did
exactly this and it cost real debugging time. `install.sh` now detects a norns
launcher and (a) skips systemd, (b) removes any stray `ingenue.service` — **keep
that guard.** If you find a stray unit, remove it; let the norns launcher own ingenue.

- **Restart on device:** relaunch norns, or
  `fuser -k 7777/tcp; (cd <dir> && setsid python3 server.py 7777 >server.log 2>&1 &)`
- **Kill by PORT** (`fuser -k 7777/tcp`) — never `pkill -f 'server.py 7777'`: that
  pattern self-matches the killing shell (and any command containing the string) and
  is unreliable.
- A *real* monome norns has no port launcher — there a systemd unit (or boot line)
  is fine. The "no systemd" rule is specifically for in-norns-launched devices.

## Deploy

Device is `panicos` in `~/.ssh/config` (root via id_ed25519). Its **IP is DHCP and
floats across reboots** — always use the `panicos` alias / hostname, never a
hardcoded IP. Deploy:

```
scp web/server.py web/index.html panicos:/storage/roms/ports/norns/data/dust/code/ingenue/
```

then **verify on the device** (`md5sum` + `python3 -c 'compile(open("server.py").read(),"s","exec")'`)
— the link can corrupt scp transfers with null bytes — then restart per the launch
model above. Full details: `deploy/DEPLOY.md`.

## Install / heal are serialized on purpose

`server.py` runs install/heal as background jobs behind a busy-lock (returns **409**
on collision) and streams output via `GET /api/job`. The frontend **queues** installs
and runs them one at a time. Do NOT "fix" a 409 by removing the lock — queue on the
client (parallel git clones thrash the device).

## Dependency / heal detection (`analyze_dir`)

ingenue detects, and offers to install: external `require "x/lib"` scripts, missing
SuperCollider engines (`engine.name = "Foo"` → the providing script, e.g. Glut→glut),
nb (note: scripts that *vendor* `lib/nb/` need nb *voices*, not nb-core), SC UGen
extensions, and downloads. Resolution is **not** catalog-gated: catalog/overlay →
GitHub search → paste-a-url, so a required dep is never an un-installable dead end.
nb is absent from norns.community and is seeded via `DEP_OVERLAY` in `index.html`.
