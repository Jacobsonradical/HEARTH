#!/usr/bin/env bash
#
# First-run helper. Creates .env from the template (if needed) and fills in the
# machine-specific bits automatically so you don't have to look them up:
#   - HEARTH_BIND_IP : this machine's LAN IP (so other devices can reach the app)
#   - TZ             : your system timezone (for daily streaks / seasons)
#   - HEARTH_UID/GID : your user, so files in ./data stay owned by you
#
# It never touches your usernames or passwords — set those yourself in .env.
#
# Usage:
#   ./setup.sh                 # auto-detect everything
#   ./setup.sh 192.168.50.148  # force a specific LAN IP (if auto-detect picks wrong)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
EXAMPLE="$SCRIPT_DIR/.env.example"

# --- Pick the LAN IP -------------------------------------------------------
# A machine can have several addresses (wifi, ethernet, VPN, Docker's own
# bridge). We list the real, globally-scoped IPv4 addresses, drop the virtual
# and VPN interfaces, then prefer the usual home ranges.
detect_ip() {
  local candidates pat match
  candidates=$(ip -4 -o addr show scope global 2>/dev/null \
    | awk '{print $2" "$4}' \
    | grep -vE '^(docker|veth|br-|tun|tap|nordlynx|nordvpn|wg|tailscale|zt)' \
    | awk '{print $2}' | cut -d/ -f1)

  for pat in '^192\.168\.' '^10\.' '^172\.(1[6-9]|2[0-9]|3[01])\.'; do
    match=$(echo "$candidates" | grep -E "$pat" | head -1 || true)
    [ -n "$match" ] && { echo "$match"; return; }
  done
  # Fall back to whatever we found first (may be empty).
  echo "$candidates" | head -1
}

# --- Detect the timezone ---------------------------------------------------
detect_tz() {
  if command -v timedatectl >/dev/null 2>&1; then
    timedatectl show -p Timezone --value 2>/dev/null && return
  fi
  if [ -f /etc/timezone ]; then
    cat /etc/timezone && return
  fi
  if [ -L /etc/localtime ]; then
    # e.g. /usr/share/zoneinfo/Europe/London -> Europe/London
    readlink /etc/localtime | sed 's|.*/zoneinfo/||' && return
  fi
  echo "UTC"
}

# --- Small helper: set or add KEY=VALUE in .env ----------------------------
set_kv() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # Use | as the sed delimiter so timezone values with / are fine.
    sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# --- Do the work -----------------------------------------------------------
FRESH=0
if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE" "$ENV_FILE"
  FRESH=1
  echo "Created .env from .env.example"
fi

IP="${1:-$(detect_ip)}"
TZ_VALUE="$(detect_tz)"
UID_VALUE="$(id -u)"
GID_VALUE="$(id -g)"

if [ -z "$IP" ]; then
  echo "Could not detect a LAN IP automatically." >&2
  echo "Find it with 'hostname -I' and run: ./setup.sh <that-ip>" >&2
  exit 1
fi

set_kv "HEARTH_BIND_IP" "$IP"
set_kv "TZ" "$TZ_VALUE"
set_kv "HEARTH_UID" "$UID_VALUE"
set_kv "HEARTH_GID" "$GID_VALUE"

echo
echo "Configured .env:"
echo "  HEARTH_BIND_IP = $IP    (open http://$IP:3000 from other devices)"
echo "  TZ             = $TZ_VALUE"
echo "  HEARTH_UID/GID = $UID_VALUE/$GID_VALUE"
echo

if [ "$FRESH" -eq 1 ]; then
  echo "Accounts are created in the app itself: open the address above after"
  echo "starting and it will walk you through it."
fi
echo "Now run:  docker compose up -d --build"
