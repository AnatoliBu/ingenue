#!/usr/bin/env bash
# ingenue installer — adds the ingenue web editor to any norns, alongside maiden.
#
#   ssh into your norns, then:
#     curl -fsSL https://raw.githubusercontent.com/seajaysec/ingenue/main/install.sh | bash
#
# Or run it from a checkout:  bash install.sh
#
# It discovers your dust tree, drops ingenue into dust/code/ingenue, and runs it as a
# persistent service on :7777 (so it's always up, like maiden). No maiden replacement.
set -euo pipefail

REPO="${INGENUE_REPO:-https://github.com/seajaysec/ingenue}"
BRANCH="${INGENUE_BRANCH:-main}"
PORT="${INGENUE_PORT:-7777}"

say(){ printf '\033[36m• %s\033[0m\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# 1. find the dust tree (the dir containing code/ and audio/)
find_dust(){
  for d in "${INGENUE_DUST:-}" "$HOME/dust" /home/we/dust \
           /storage/roms/ports/norns/data/dust ~/.local/share/norns/dust; do
    [ -n "$d" ] && [ -d "$d/code" ] && { realpath "$d"; return; }
  done
  return 1
}
DUST="$(find_dust)" || die "couldn't find your norns dust tree — set INGENUE_DUST=/path/to/dust and re-run"
DEST="$DUST/code/ingenue"
say "dust: $DUST"

# 2. fetch ingenue (git if available, else tarball)
say "installing ingenue → $DEST"
mkdir -p "$DEST"
if command -v git >/dev/null 2>&1; then
  if [ -d "$DEST/.git" ]; then git -C "$DEST" pull --ff-only || true
  else git clone --depth 1 -b "$BRANCH" "$REPO" /tmp/ingenue-src && cp -r /tmp/ingenue-src/web/. "$DEST/" && rm -rf /tmp/ingenue-src; fi
else
  curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" -o /tmp/ingenue.tgz
  mkdir -p /tmp/ingenue-x && tar xzf /tmp/ingenue.tgz -C /tmp/ingenue-x --strip-components=1
  cp -r /tmp/ingenue-x/web/. "$DEST/" && rm -rf /tmp/ingenue.tgz /tmp/ingenue-x
fi
[ -f "$DEST/server.py" ] || die "install looks incomplete (no server.py)"

# 3. always-on service (systemd if present, else a boot line)
if command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  say "installing systemd service (persistent, auto-restart)"
  cat > /etc/systemd/system/ingenue.service <<EOF
[Unit]
Description=ingenue web editor for norns
After=network.target
[Service]
Type=simple
WorkingDirectory=$DEST
ExecStart=/usr/bin/python3 server.py $PORT
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now ingenue
  systemctl restart ingenue
else
  say "no systemd — starting now; add this to your norns boot to make it persistent:"
  echo "    (cd $DEST && setsid python3 server.py $PORT >server.log 2>&1 &)"
  pkill -f "server.py $PORT" 2>/dev/null || true
  (cd "$DEST" && setsid python3 server.py "$PORT" >server.log 2>&1 &) || true
fi

IP="$(python3 - <<'PY' 2>/dev/null || true
import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(("8.8.8.8",80)); print(s.getsockname()[0])
PY
)"
printf '\033[32m✓ ingenue is up — open http://%s:%s/ from any device on your network\033[0m\n' "${IP:-<norns-ip>}" "$PORT"
