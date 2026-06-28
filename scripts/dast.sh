#!/usr/bin/env bash
# On-demand DAST against a RUNNING ingenue instance (default: the device at norns.local:7777).
#
# SAFE BY DESIGN — passive / non-destructive only. ingenue's API exposes powerful endpoints
# (install, rm, write, matron REPL), so this scan never POSTs, fuzzes, or sends DoS/intrusive
# payloads. It only issues read-only GET/HEAD/OPTIONS requests and passively analyses the
# responses. It will not change anything on the device.
#
# Usage:
#   scripts/dast.sh                          # scan http://norns.local:7777
#   scripts/dast.sh http://norns.local:7777  # explicit target
#
# Reports land in dast-reports/<timestamp>/ (gitignored). Needs `nuclei` for the template
# scan (brew install nuclei); without it you still get the header/surface checks.
set -uo pipefail
TARGET="${1:-http://norns.local:7777}"
TARGET="${TARGET%/}"
STAMP="$(date +%Y%m%d-%H%M%S)"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/dast-reports/$STAMP"
mkdir -p "$OUT"
echo "▶ ingenue DAST (passive) → $TARGET"
echo "  report dir: $OUT"

code=$(curl -s -o /dev/null -w '%{http_code}' --connect-timeout 6 "$TARGET/" 2>/dev/null || echo 000)
if [ "$code" != "200" ]; then
  echo "✗ $TARGET not reachable (http $code) — is ingenue running on the device?"
  exit 1
fi

# ── 1. HTTP security headers + read-only surface probes ───────────────────────────────────
HDR="$OUT/headers.md"
{
  echo "# ingenue DAST — $TARGET — $STAMP"
  echo
  echo '## response headers (GET /)'
  echo '```'
  curl -sSI "$TARGET/" 2>&1
  echo '```'
  echo
  echo '## security headers'
  hdrs=$(curl -sSI "$TARGET/" 2>/dev/null)
  for h in Content-Security-Policy X-Frame-Options X-Content-Type-Options Referrer-Policy Strict-Transport-Security Permissions-Policy Cache-Control; do
    if printf '%s' "$hdrs" | grep -qi "^$h:"; then echo "- ✓ $h"; else echo "- ✗ $h MISSING"; fi
  done
  echo
  echo '## exposed-file / source-leak probe (read-only GET)'
  for p in .git/config .git/HEAD server.py requirements.txt gh.api yt.api vimeo.api .env demos.json; do
    c=$(curl -s -o /dev/null -w '%{http_code}' "$TARGET/$p" 2>/dev/null)
    flag=""; [ "$c" = "200" ] && flag="  ← reachable, review"
    echo "- $c  /$p$flag"
  done
  echo
  echo '## API auth check (are device endpoints open? read-only GETs only)'
  for p in api/version api/scripts api/favorites api/community; do
    c=$(curl -s -o /dev/null -w '%{http_code}' "$TARGET/$p" 2>/dev/null)
    echo "- $c  /$p"
  done
  echo
  echo '## allowed methods (OPTIONS /)'
  echo '```'
  curl -sS -X OPTIONS -D - -o /dev/null "$TARGET/" 2>&1 | grep -i '^allow:' || echo '(no Allow header)'
  echo '```'
} > "$HDR" 2>&1
echo "  · headers + surface  → ${HDR#$ROOT/}"

# ── 2. nuclei template scan (non-intrusive only) ──────────────────────────────────────────
if command -v nuclei >/dev/null 2>&1; then
  echo "  · nuclei scan (excluding dos/intrusive/fuzz)…"
  nuclei -target "$TARGET" \
    -exclude-tags dos,intrusive,fuzz,fuzzing,brute-force \
    -rate-limit 25 -timeout 8 -retries 1 -no-interactsh \
    -severity info,low,medium,high,critical \
    -jsonl -output "$OUT/nuclei.jsonl" >"$OUT/nuclei.log" 2>&1 || true
  n=$(wc -l <"$OUT/nuclei.jsonl" 2>/dev/null | tr -d ' ' || echo 0)
  echo "  · nuclei            → ${OUT#$ROOT/}/nuclei.jsonl ($n findings)"
else
  echo "  ! nuclei not found (brew install nuclei) — ran header/surface checks only"
fi

echo "✔ done. Review: $OUT"
