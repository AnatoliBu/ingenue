# Deploying ingenue to a PanicOS device

ingenue runs as an independent web service on **:7777**, alongside system maiden (:5000).
No mod, no maiden replacement — if installed, it's on at boot.

## Layout on device
- `/storage/ingenue/` — `index.html`, `community.json`, `enriched.json`, `server.py`
  (`/storage` is the persistent partition; dust lives under it).
- `/etc/systemd/system/ingenue.service` — the service (`deploy/ingenue.service`).

## Install
```bash
ssh panicos 'mkdir -p /storage/ingenue'
scp web/index.html web/community.json web/enriched.json web/server.py panicos:/storage/ingenue/
# VERIFY the JSON survived transfer (this link corrupts files — see gotcha):
ssh panicos 'cd /storage/ingenue && python3 -c "import json;json.load(open(\"enriched.json\"));json.load(open(\"community.json\"));print(\"json OK\")" && python3 -c "compile(open(\"server.py\").read(),\"s\",\"exec\");print(\"py OK\")"'
scp deploy/ingenue.service panicos:/etc/systemd/system/
ssh panicos 'systemctl daemon-reload && systemctl enable --now ingenue && systemctl is-active ingenue'
```

Then: `http://<device-ip>:7777/`

## Backend API (over the real dust tree)
`GET /api/installed` · `GET /api/ls?path=` · `GET /api/read?path=` · `PUT /api/write?path=`
Dust root defaults to `/storage/roms/ports/norns/data/dust` (override `INGENUE_DUST`).

## Gotchas
- **Flaky scp corrupts files with null bytes** over this device's link — ALWAYS verify
  `server.py` compiles and the JSONs parse *on the device* after copying. (Both `server.py`
  and `enriched.json` arrived null-filled the first time.)
- **`/` is an overlay filesystem.** `/etc` is writable, but whether the overlay upper layer
  (and thus the enabled service) survives a **reboot** depends on PanicOS's config — verify
  with a reboot. If it doesn't persist, move the autostart to a `/storage`-based hook.

## Token / privacy
The GitHub token is stored **only** in the browser's localStorage and sent **only** to
api.github.com (HTTPS) for search — never to ingenue's server.
