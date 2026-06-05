# Deploying ingenue (as a portable norns mod)

ingenue is a **norns mod** — it lives in `dust/code/ingenue/` on any norns, discovers
the dust tree relative to itself, and runs its web service on **:7777** alongside maiden
(:5000). No device-specific paths, no maiden replacement.

## Install on a device
```bash
DEST=<dust>/code/ingenue          # e.g. /storage/roms/ports/norns/data/dust/code/ingenue (PanicOS)
ssh <host> "mkdir -p $DEST/lib $DEST/vendor"
scp web/index.html web/community.json web/enriched.json web/server.py <host>:$DEST/
scp web/lib/mod.lua <host>:$DEST/lib/
scp web/vendor/sc-plugins-arm64-*.tar.gz <host>:$DEST/vendor/   # bundled 64-bit SC UGen binaries
# VERIFY transfer (this device's link corrupts files — see gotcha):
ssh <host> "cd $DEST && python3 -c 'import json;json.load(open(\"community.json\"));json.load(open(\"enriched.json\"));compile(open(\"server.py\").read(),\"s\",\"exec\");print(\"OK\")'"
```

## Autostart (persistent systemd service — always on, like matron)
ingenue is **not** a toggleable mod (that path was unreliable — `setsid` launches got
reaped, and it showed up confusingly in SYSTEM > MODS). It runs as a persistent service
that survives reboots and auto-restarts on crash:
```bash
ssh <host> "cat > /etc/systemd/system/ingenue.service <<EOF
[Unit]
Description=ingenue web editor for norns
After=network.target
[Service]
Type=simple
WorkingDirectory=$DEST
# reclaim :7777 from any orphaned/stale instance BEFORE binding — kill by PORT,
# not by process name (pkill -f 'server.py 7777' self-matches and is unreliable;
# a unit with NO reclaim crash-loops forever on 'Address already in use' if an
# orphan survives a deploy). - = ignore when the port is already free.
ExecStartPre=-/bin/sh -c 'fuser -k 7777/tcp 2>/dev/null; sleep 1'
ExecStart=/usr/bin/python3 server.py 7777
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now ingenue"
```
After updating `server.py`: `ssh <host> "systemctl restart ingenue"`.

Then open `http://<device-ip>:7777/`.

## Backend API (real, over the dust tree)
- `GET /api/installed` — script dirs in dust/code (ingenue + dotfiles excluded)
- `GET /api/ls?path=` · `GET /api/read?path=` · `PUT /api/write?path=`
- `POST /api/install {name,url,force}` — **git clone** into dust/code/name
- `POST /api/remove {name}` — **delete** dust/code/name
- Dust is auto-discovered (`../..` from the mod); override with `INGENUE_DUST`.

## Gotchas
- **This device's link corrupts scp transfers with null bytes** — always verify
  `server.py` compiles and the JSONs parse *on the device* after copying.
- **Kill by `pkill -f 'server.py 7777'`** (the process cmdline has no path).
- Reboot-persistence relies on the mod being enabled in SYSTEM > MODS (the norns way),
  not on any OS-level service.

## Token / privacy
The GitHub token is stored **only** in the browser's localStorage and sent **only** to
api.github.com (HTTPS) for search — never to ingenue's server.
