#!/usr/bin/env bash
#
# Back up Hearth's entire state (messages, uploads, garden) by archiving the
# single data folder. Because everything lives in one place, this tar file IS a
# complete backup — restore by extracting it back over ./data.
#
# Usage:
#   ./scripts/backup.sh                 # writes to ./backups
#   BACKUP_DIR=/mnt/usb ./scripts/backup.sh
#   KEEP=30 ./scripts/backup.sh         # keep the newest 30 archives
#
# Cron example (every night at 02:30):
#   30 2 * * * /media/rabbitlord/ssd2/github-project/HEARTH/scripts/backup.sh >> /var/log/hearth-backup.log 2>&1
#
# SQLite runs in WAL mode, so copying the folder while the app is live is
# normally consistent. For a guaranteed-quiet snapshot you may stop the app
# first (docker compose stop) and start it again after — not required for
# routine backups.

set -euo pipefail

# Resolve paths relative to this script so cron can call it from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
DATA_DIR="$PROJECT_DIR/data"
BACKUP_DIR="${BACKUP_DIR:-$PROJECT_DIR/backups}"
KEEP="${KEEP:-14}"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "backup: data folder not found at $DATA_DIR" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$BACKUP_DIR/hearth-$STAMP.tar.gz"

# Archive the data folder (stored as "data/..." inside the tar).
tar -czf "$ARCHIVE" -C "$PROJECT_DIR" data
echo "backup: wrote $ARCHIVE"

# Prune old archives, keeping the newest $KEEP.
mapfile -t OLD < <(ls -1t "$BACKUP_DIR"/hearth-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))")
for f in "${OLD[@]:-}"; do
  [[ -n "$f" ]] && rm -f "$f" && echo "backup: pruned $f"
done
