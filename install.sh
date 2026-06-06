#!/usr/bin/env bash
# ingenue installer — adds the ingenue web editor to any norns, alongside maiden.
#
#   ssh into your norns, then:
#     curl -fsSL https://raw.githubusercontent.com/seajaysec/ingenue/main/install.sh | bash
#
# Or run it from a checkout:  bash install.sh
# (ingenue.lua, the maiden `;install` entry, runs this with INGENUE_NO_FETCH=1.)
#
# It discovers your dust tree, drops ingenue into dust/code/ingenue, makes sure python3
# is present (installing it if the device's OS lacks it), and runs it as a persistent
# service on :7777 — always up, like maiden. No maiden replacement.
set -euo pipefail

REPO="${INGENUE_REPO:-https://github.com/seajaysec/ingenue}"
BRANCH="${INGENUE_BRANCH:-main}"
PORT="${INGENUE_PORT:-7777}"

say(){ printf '\033[36m• %s\033[0m\n' "$*"; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }
# run privileged: as-is if already root, else via sudo (prefer non-interactive)
priv(){ if [ "$(id -u)" = 0 ]; then "$@"; elif sudo -n true 2>/dev/null; then sudo "$@"; else sudo "$@"; fi; }

# Refresh the root-level installer/entry next to ingenue so future self-updates carry their own
# fixes (the web/. copy alone wouldn't). Atomic mv (new inode) — safe even though this very
# script may be the one currently executing from $DEST.
refresh_self(){
  local src="$1" f
  for f in install.sh ingenue.lua; do
    [ -f "$src/$f" ] && cp "$src/$f" "$DEST/.$f.new" 2>/dev/null && mv -f "$DEST/.$f.new" "$DEST/$f" 2>/dev/null || true
  done
}

# --- 1. make sure python3 is available (any target has internet per the install flow) ---
ensure_python(){
  if command -v python3 >/dev/null 2>&1; then return 0; fi
  say "python3 not found — installing it for your OS"
  if   command -v apt-get >/dev/null 2>&1; then priv apt-get update -y && priv apt-get install -y python3
  elif command -v apk     >/dev/null 2>&1; then priv apk add --no-cache python3
  elif command -v opkg    >/dev/null 2>&1; then priv opkg update && { priv opkg install python3 || priv opkg install python3-light; }
  elif command -v pacman  >/dev/null 2>&1; then priv pacman -Sy --noconfirm python
  elif command -v dnf     >/dev/null 2>&1; then priv dnf install -y python3
  elif command -v yum     >/dev/null 2>&1; then priv yum install -y python3
  elif command -v zypper  >/dev/null 2>&1; then priv zypper -n install python3
  elif command -v emerge  >/dev/null 2>&1; then priv emerge -q dev-lang/python
  else die "no python3 and no recognized package manager — please install python3 and re-run"; fi
  command -v python3 >/dev/null 2>&1 || die "python3 install did not succeed (try installing it manually, then re-run)"
  say "python3 ready: $(python3 --version 2>&1)"
}

# --- 2. find the dust tree (dir with code/ AND audio/) ---
find_dust(){
  if [ -n "${INGENUE_DUST:-}" ] && [ -d "$INGENUE_DUST/code" ]; then realpath "$INGENUE_DUST"; return; fi
  for d in "$HOME/dust" /home/we/dust /storage/roms/ports/norns/data/dust "$HOME/.local/share/norns/dust"; do
    [ -d "$d/code" ] && [ -d "$d/audio" ] && { realpath "$d"; return; }
  done
  return 1
}
DUST="$(find_dust)" || die "couldn't find your norns dust tree — set INGENUE_DUST=/path/to/dust and re-run"
DEST="$DUST/code/ingenue"
say "dust: $DUST"

# --- 3. fetch ingenue (unless the maiden ;install already placed the files) ---
SRC_SHA=""   # the exact commit we install, captured during fetch (most reliable)
if [ "${INGENUE_NO_FETCH:-0}" != "1" ]; then
  say "installing ingenue → $DEST"
  mkdir -p "$DEST"
  if command -v git >/dev/null 2>&1; then
    rm -rf /tmp/ingenue-src
    git clone --depth 1 -b "$BRANCH" "$REPO" /tmp/ingenue-src
    SRC_SHA="$(git -C /tmp/ingenue-src rev-parse HEAD 2>/dev/null)" || SRC_SHA=""
    cp -r /tmp/ingenue-src/web/. "$DEST/"
    refresh_self /tmp/ingenue-src
    rm -rf /tmp/ingenue-src
  else
    curl -fsSL "$REPO/archive/refs/heads/$BRANCH.tar.gz" -o /tmp/ingenue.tgz
    rm -rf /tmp/ingenue-x && mkdir -p /tmp/ingenue-x && tar xzf /tmp/ingenue.tgz -C /tmp/ingenue-x --strip-components=1
    cp -r /tmp/ingenue-x/web/. "$DEST/"
    refresh_self /tmp/ingenue-x
    rm -rf /tmp/ingenue.tgz /tmp/ingenue-x
  fi
fi

# --- 4. locate server.py (flat install vs repo web/ subdir) ---
if   [ -f "$DEST/server.py" ];     then WORK="$DEST"
elif [ -f "$DEST/web/server.py" ]; then WORK="$DEST/web"
else die "server.py not found under $DEST"; fi

# --- 4b. record the installed commit so the in-app update check can compare to main ---
# Prefer the SHA from the clone; else a local .git; else the GitHub API. Every assignment is
# guarded with `|| x=` so a SIGPIPE/curl failure under `set -e`+pipefail can't abort the install.
record_version(){
  local sha="$SRC_SHA"
  if [ -z "$sha" ] && [ -d "$DEST/.git" ]; then sha="$(git -C "$DEST" rev-parse HEAD 2>/dev/null)" || sha=""; fi
  if [ -z "$sha" ]; then
    local slug="${REPO#https://github.com/}"; slug="${slug%.git}"
    sha="$(curl -fsSL "https://api.github.com/repos/$slug/commits/$BRANCH" 2>/dev/null | grep -m1 -oE '[0-9a-f]{40}')" || sha=""
  fi
  if [ -n "$sha" ]; then printf '%s\n' "$sha" > "$WORK/.version" && say "version ${sha:0:7}"; fi
  return 0
}
record_version

ensure_python
PY="$(command -v python3)"

# --- 5. how ingenue stays running ---
# LAUNCH MODEL — read this before "helpfully" adding a service:
# On devices that launch ingenue FROM WITHIN the norns session (e.g. PanicOS, whose
# port launcher Norns.sh starts `server.py $PORT` on norns launch and stops it on
# exit), ingenue must NOT also be a systemd service. Two launchers then fight over
# :$PORT and the loser crash-loops forever on "Address already in use". A prior
# well-meaning install did exactly this. So: if a norns launcher already starts
# ingenue, leave it to that — and tear down any stray service a previous install left.
NORNS_LAUNCHER=""
for f in /storage/roms/ports/Norns.sh /roms/ports/Norns.sh; do
  [ -f "$f" ] && grep -qE "dust/code/ingenue|server\.py $PORT" "$f" && NORNS_LAUNCHER="$f" && break
done
start_detached() {   # kill by PORT (fuser), not by name (pkill -f self-matches), then relaunch
  { fuser -k "$PORT"/tcp 2>/dev/null || pkill -f "server.py $PORT" 2>/dev/null; } || true
  sleep 1
  (cd "$WORK" && setsid "$PY" server.py "$PORT" >server.log 2>&1 &) || true
}
if [ -n "$NORNS_LAUNCHER" ]; then
  say "ingenue is launched from norns ($NORNS_LAUNCHER) — NOT installing a systemd service (it would fight over :$PORT)"
  if command -v systemctl >/dev/null 2>&1 && [ -e /etc/systemd/system/ingenue.service ]; then
    say "removing a stale ingenue.service from a previous install — the norns launcher owns ingenue here"
    priv systemctl disable --now ingenue 2>/dev/null || true
    priv rm -f /etc/systemd/system/ingenue.service /etc/systemd/system/multi-user.target.wants/ingenue.service
    priv systemctl daemon-reload 2>/dev/null || true
  fi
  start_detached
elif command -v systemctl >/dev/null 2>&1 && [ -d /etc/systemd/system ]; then
  say "installing systemd service (persistent, auto-restart)"
  if command -v fuser >/dev/null 2>&1; then
    PRE="ExecStartPre=-/bin/sh -c 'fuser -k $PORT/tcp 2>/dev/null; sleep 1'"
  else
    PKILL="$(command -v pkill 2>/dev/null || echo /usr/bin/pkill)"
    PRE="ExecStartPre=-$PKILL -f \"server.py $PORT\""
  fi
  # Run as the user who owns the dust tree (typically `we` on norns) — NOT root.
  # If the service runs as root, every `git clone` and script install.sh creates
  # root-owned files in dust/code, and maiden (running as `we`) then can't
  # manage them: `unlinkat … permission denied`, silent remove failures, the
  # script becomes un-editable from maiden. We surface this in ingenue's
  # Configuration > Heal installations row too, but doing it right at install
  # time avoids creating the breakage in the first place.
  SVC_USER=""; SVC_GROUP=""
  if [ -d "$DUST/code" ]; then
    # `stat -c` (GNU coreutils, which norns has) — gives us the owner name+group
    SVC_USER="$(stat -c '%U' "$DUST/code" 2>/dev/null || true)"
    SVC_GROUP="$(stat -c '%G' "$DUST/code" 2>/dev/null || true)"
  fi
  # Reject root/UNKNOWN — those won't fix the bug. Prefer `we` if it exists as
  # a fallback (a real norns without dust would be unusual but possible).
  if [ -z "$SVC_USER" ] || [ "$SVC_USER" = "root" ] || [ "$SVC_USER" = "UNKNOWN" ]; then
    if id we >/dev/null 2>&1; then
      SVC_USER="we"; SVC_GROUP="$(id -gn we 2>/dev/null || echo we)"
    fi
  fi
  USER_LINES=""
  if [ -n "$SVC_USER" ] && [ "$SVC_USER" != "root" ]; then
    USER_LINES="User=$SVC_USER"$'\n'"Group=${SVC_GROUP:-$SVC_USER}"
    say "service will run as $SVC_USER:${SVC_GROUP:-$SVC_USER} (matches dust/code owner)"
    # Make sure WorkingDirectory and our writable artifacts (.version, server.log)
    # are owned by the service user, or systemd will fail to start the unit.
    priv chown -R "$SVC_USER:${SVC_GROUP:-$SVC_USER}" "$WORK" 2>/dev/null || true
  else
    say "warn: couldn't determine a non-root user for the service — running as root (scripts may be created root-owned; use Configuration > Heal installations after)"
  fi
  TMP="$(mktemp)"
  cat > "$TMP" <<EOF
[Unit]
Description=ingenue web editor for norns
After=network.target
[Service]
Type=simple
WorkingDirectory=$WORK
$USER_LINES
# Reclaim :$PORT from any stray/stale instance before binding — kill by PORT, not by
# process name ('pkill -f "server.py $PORT"' self-matches and is unreliable). '-' = ignore no-match.
$PRE
ExecStart=$PY server.py $PORT
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
EOF
  priv cp "$TMP" /etc/systemd/system/ingenue.service; rm -f "$TMP"
  priv systemctl daemon-reload
  priv systemctl enable --now ingenue
  priv systemctl restart ingenue
else
  say "no systemd — starting now; add this line to your norns boot for persistence:"
  echo "    (cd $WORK && setsid $PY server.py $PORT >server.log 2>&1 &)"
  start_detached
fi

IP="$(python3 - <<'PY' 2>/dev/null || true
import socket
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM); s.connect(("8.8.8.8",80)); print(s.getsockname()[0])
PY
)"
printf '\033[32m✓ ingenue is up — open http://%s:%s/ from any device on your network\033[0m\n' "${IP:-<norns-ip>}" "$PORT"
