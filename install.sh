#!/bin/sh
#
# HEARTH one-line installer for Linux, macOS, and Windows (inside WSL2):
#
#   curl -fsSL https://raw.githubusercontent.com/Jacobsonradical/HEARTH/master/install.sh | sh
#
# What it does, in order:
#   1. checks Docker + Docker Compose are available (with per-OS install hints)
#   2. fetches the app into ~/hearth (git clone if git exists, tarball otherwise)
#   3. runs setup.sh to write a .env with your LAN IP / timezone / user
#   4. starts the app with docker compose
#   5. prints the address to open — account creation happens in the app itself
#
# Options via environment:
#   HEARTH_DIR=/somewhere      install location   (default: ~/hearth)
#   HEARTH_BIND_IP=192.168...  force the LAN IP   (default: auto-detected)
#   HEARTH_PORT=3000           port to serve on   (default: 3000)

set -eu

REPO="Jacobsonradical/HEARTH"
BRANCH="master"
DIR="${HEARTH_DIR:-$HOME/hearth}"

say()  { printf '\033[1;35mhearth |\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mhearth | %s\033[0m\n' "$*" >&2; exit 1; }

OS="$(uname -s)"

# --- 1. Docker checks --------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  case "$OS" in
    Darwin) fail "Docker is not installed. Get Docker Desktop for Mac (works on both Apple Silicon and Intel): https://docs.docker.com/desktop/setup/install/mac-install/  — then re-run this installer." ;;
    Linux)
      if grep -qi microsoft /proc/version 2>/dev/null; then
        fail "Docker is not reachable from WSL. Install Docker Desktop for Windows with the WSL2 backend and enable it for this distro (Settings > Resources > WSL integration): https://docs.docker.com/desktop/setup/install/windows-install/"
      fi
      fail "Docker is not installed. See https://docs.docker.com/engine/install/ — then re-run this installer." ;;
    *) fail "Docker is not installed." ;;
  esac
fi
if ! docker compose version >/dev/null 2>&1; then
  fail "The 'docker compose' plugin is missing (Docker Desktop includes it; on Linux install docker-compose-plugin)."
fi

# --- 2. Fetch the app --------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "Existing install found at $DIR - updating it."
  git -C "$DIR" pull --ff-only || fail "Could not update $DIR (local changes?). Resolve manually and re-run."
elif [ -e "$DIR" ]; then
  fail "$DIR already exists but is not a HEARTH checkout. Move it away or set HEARTH_DIR=/other/path."
elif command -v git >/dev/null 2>&1; then
  say "Cloning into $DIR ..."
  git clone --depth 1 "https://github.com/$REPO.git" "$DIR"
else
  say "git not found - downloading a snapshot into $DIR ..."
  mkdir -p "$DIR"
  curl -fsSL "https://github.com/$REPO/archive/refs/heads/$BRANCH.tar.gz" \
    | tar xz -C "$DIR" --strip-components=1
fi

cd "$DIR"

# --- 3. Configure ---------------------------------------------------------------
say "Detecting your LAN IP and timezone ..."
bash ./setup.sh ${HEARTH_BIND_IP:-}

# Testing hook: stop before actually launching containers.
[ -n "${HEARTH_SKIP_START:-}" ] && { say "(skip-start set - stopping here)"; exit 0; }

# --- 4. Build and start ---------------------------------------------------------
# Can we talk to the daemon without sudo? (Docker Desktop: yes; Linux: depends.)
SUDO=""
if ! docker info >/dev/null 2>&1; then
  if command -v sudo >/dev/null 2>&1; then
    say "Docker needs elevated rights here - using sudo (you may be asked for your password)."
    SUDO="sudo"
    $SUDO docker info >/dev/null 2>&1 || fail "Docker daemon is not running. Start Docker (Desktop) and re-run this installer."
  else
    fail "Cannot reach the Docker daemon and sudo is unavailable. Is Docker running?"
  fi
fi

say "Building and starting (the first build takes a few minutes) ..."
$SUDO docker compose up -d --build

# --- 5. Where to go -------------------------------------------------------------
BIND_IP="$(grep -E '^HEARTH_BIND_IP=' .env | cut -d= -f2)"
PORT="$(grep -E '^HEARTH_PORT=' .env | cut -d= -f2)"
say ""
say "HEARTH is up!  Open:   http://$BIND_IP:${PORT:-3000}"
say "The app will greet you with a one-time screen to create both accounts."
say "Bookmark that address on every device on your wifi. Enjoy your hearth."
