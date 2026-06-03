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

## Autostart (on at boot, the norns-native way)
- Enable **ingenue** in **SYSTEM > MODS** on the device, then restart norns. The mod's
  `system_post_startup` hook launches the server every boot — portable to any norns.
- To run it immediately without a restart:
  ```bash
  ssh <host> "pkill -f 'server.py 7777'; cd $DEST && nohup setsid python3 server.py 7777 >server.log 2>&1 </dev/null & disown"
  ```

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
