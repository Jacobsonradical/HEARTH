#!/usr/bin/env bash
#
# First-run helper. Creates .env from the template (if needed) and fills in the
# machine-specific bits automatically so you don't have to look them up:
#   - HEARTH_BIND_IP : this machine's LAN IP (so other devices can reach the app)
#   - TZ             : your system timezone (auto-detected in-app if unknown)
#   - HEARTH_UID/GID : your user, so files in ./data stay owned by you
#
# Works on Linux, macOS, and Windows via WSL2 (where it asks Windows for the
# real LAN IP). It never touches accounts — those are created in the app the
# first time you open it.
#
# Usage:
#   ./setup.sh                 # auto-detect everything
#   ./setup.sh 192.168.50.148  # force a specific LAN IP (if auto-detect picks wrong)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
EXAMPLE="$SCRIPT_DIR/.env.example"

OS="$(uname -s)"
IS_WSL=0
if [ "$OS" = "Linux" ] && grep -qi microsoft /proc/version 2>/dev/null; then
  IS_WSL=1
fi

# --- Pick the LAN IP ---------------------------------------------------------
# A machine can have several addresses (wifi, ethernet, VPN, Docker's own
# bridge). We prefer the usual home ranges and skip virtual/VPN interfaces.

prefer_private() {
  # Reads candidate IPs on stdin, prints the best one (home ranges first).
  local candidates pat match
  candidates="$(cat)"
  for pat in '^192\.168\.' '^10\.' '^172\.(1[6-9]|2[0-9]|3[01])\.'; do
    match="$(echo "$candidates" | grep -E "$pat" | head -1 || true)"
    [ -n "$match" ] && { echo "$match"; return; }
  done
  echo "$candidates" | head -1
}

detect_ip() {
  if [ "$IS_WSL" = 1 ]; then
    # Inside WSL the Linux interfaces are virtual; the address other devices
    # can reach is WINDOWS' LAN IP. Ask Windows itself via PowerShell interop.
    powershell.exe -NoProfile -Command \
      "(Get-NetIPConfiguration | Where-Object { \$_.IPv4DefaultGateway -ne \$null -and \$_.NetAdapter.Status -eq 'Up' }).IPv4Address.IPAddress" \
      2>/dev/null | tr -d '\r' | grep -E '^[0-9.]+$' | prefer_private
  elif [ "$OS" = "Darwin" ]; then
    # macOS: ask each real network service port; this skips VPN utun devices.
    { for i in 0 1 2 3 4 5 6 7 8; do
        ipconfig getifaddr "en$i" 2>/dev/null || true
      done; } | prefer_private
  else
    ip -4 -o addr show scope global 2>/dev/null \
      | awk '{print $2" "$4}' \
      | grep -vE '^(docker|veth|br-|tun|tap|nordlynx|nordvpn|wg|tailscale|zt)' \
      | awk '{print $2}' | cut -d/ -f1 | prefer_private
  fi
}

# --- Detect the timezone -------------------------------------------------------
# Best effort only: if we can't tell, we leave it empty and the app finds the
# timezone itself from your internet connection.
detect_tz() {
  if command -v timedatectl >/dev/null 2>&1; then
    timedatectl show -p Timezone --value 2>/dev/null && return
  fi
  if [ -f /etc/timezone ]; then
    cat /etc/timezone && return
  fi
  if [ -L /etc/localtime ]; then
    # e.g. /usr/share/zoneinfo/Europe/London  or  /var/db/timezone/zoneinfo/... (macOS)
    readlink /etc/localtime | sed 's|.*/zoneinfo/||' && return
  fi
  echo ""
}

# --- Small helper: set or add KEY=VALUE in .env --------------------------------
# Portable across GNU and BSD tools (macOS sed differs, so avoid sed -i).
set_kv() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS=""} $0 ~ "^"k"=" {print k"="v; next} {print}' \
      "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
  else
    rm -f "$tmp"
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

# --- Do the work ---------------------------------------------------------------
if [ ! -f "$ENV_FILE" ]; then
  cp "$EXAMPLE" "$ENV_FILE"
  echo "Created .env from .env.example"
fi

# Create the data folder as the real user BEFORE Docker ever runs. If Docker
# creates it for the bind mount instead, it belongs to root and the app (which
# runs as your user) cannot write to it and dies on startup.
mkdir -p "$SCRIPT_DIR/data"

IP="${1:-${HEARTH_BIND_IP:-$(detect_ip)}}"
TZ_VALUE="$(detect_tz)"
UID_VALUE="$(id -u)"
GID_VALUE="$(id -g)"

if [ -z "$IP" ]; then
  echo "Could not detect a LAN IP automatically." >&2
  echo "Find it yourself (Linux: hostname -I / macOS: System Settings > Network)" >&2
  echo "and run:  ./setup.sh <that-ip>" >&2
  exit 1
fi

set_kv "HEARTH_BIND_IP" "$IP"
set_kv "TZ" "$TZ_VALUE"
set_kv "HEARTH_UID" "$UID_VALUE"
set_kv "HEARTH_GID" "$GID_VALUE"
# Allow a port override from the environment (rarely needed).
[ -n "${HEARTH_PORT:-}" ] && set_kv "HEARTH_PORT" "$HEARTH_PORT"

echo
echo "Configured .env:"
echo "  HEARTH_BIND_IP = $IP"
echo "  TZ             = ${TZ_VALUE:-(auto-detected by the app)}"
echo "  HEARTH_UID/GID = $UID_VALUE/$GID_VALUE"
echo
echo "Next:  docker compose up -d --build"
echo "Then open  http://$IP:${HEARTH_PORT:-3000}  from any device on your wifi -"
echo "the app will walk you through creating your two accounts."
