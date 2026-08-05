#!/usr/bin/env bash
# backup-local-mongo.sh — timestamped gzip archive of ALL databases on local mongod.
# Run on EC2: bash scripts/backup-local-mongo.sh
# Restore: mongorestore --uri="mongodb://127.0.0.1:27017" --archive=<file> --gzip --drop
set -euo pipefail

BACKUP_DIR="$HOME/mongo-backups"
URI="mongodb://127.0.0.1:27017"
KEEP=7

mkdir -p "$BACKUP_DIR"
FILE="$BACKUP_DIR/local-$(date +%F-%H%M).archive.gz"

echo "== dumping to $FILE =="
mongodump --uri="$URI" --archive="$FILE" --gzip

SIZE=$(stat -c%s "$FILE")
[ "$SIZE" -gt 1024 ] || { echo "FAIL: archive suspiciously small ($SIZE bytes)"; exit 1; }
echo "OK: $(du -h "$FILE" | cut -f1) written."

ls -1t "$BACKUP_DIR"/local-*.archive.gz | tail -n +$((KEEP+1)) | xargs -r rm -v
echo "== current backups =="
ls -lh "$BACKUP_DIR"
