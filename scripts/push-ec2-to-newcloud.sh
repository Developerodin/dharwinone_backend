#!/usr/bin/env bash
# push-ec2-to-newcloud.sh — copy EC2 local mongod db -> new Atlas cluster,
# into "<db>_ec2local" so it can be diffed against the old-cloud copy.
# Run on EC2 from repo root: bash scripts/push-ec2-to-newcloud.sh
# Needs in .env:  MONGODB_URL (dbname source)  +  NEW_CLOUD_URI (target Atlas URI, no db path)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"

DB=$(grep '^MONGODB_URL' "$ENV_FILE" | sed -e 's/.*\///' -e 's/[?].*//' | tr -d '\r')
TARGET_URI=$(grep '^NEW_CLOUD_URI' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
[ -n "$DB" ] || { echo "FAIL: could not read db name from MONGODB_URL in $ENV_FILE"; exit 1; }
[ -n "$TARGET_URI" ] || { echo "FAIL: add NEW_CLOUD_URI=mongodb+srv://user:pass@host/ to $ENV_FILE"; exit 1; }

LOCAL_URI="mongodb://127.0.0.1:27017/$DB"
TARGET_DB="${DB}_ec2local"

echo "== streaming $DB (local) -> $TARGET_DB (new cloud) =="
mongodump --uri="$LOCAL_URI" --archive --gzip \
  | mongorestore --uri="$TARGET_URI" --archive --gzip --drop \
      --nsFrom="$DB.*" --nsTo="$TARGET_DB.*"

echo "== verifying counts =="
mongosh "$LOCAL_URI" --quiet --eval '
  db.getCollectionNames().filter(n=>!n.startsWith("system.")).sort()
    .forEach(n=>print(n+" "+db.getCollection(n).countDocuments({})))' > /tmp/src-counts.txt
mongosh "$TARGET_URI" --quiet --eval '
  const d = db.getSiblingDB("'"$TARGET_DB"'");
  d.getCollectionNames().filter(n=>!n.startsWith("system.")).sort()
    .forEach(n=>print(n+" "+d.getCollection(n).countDocuments({})))' > /tmp/dst-counts.txt

if diff /tmp/src-counts.txt /tmp/dst-counts.txt; then
  echo "OK: new cloud $TARGET_DB matches EC2 local, collection-for-collection."
else
  echo "MISMATCH above (left=EC2 local, right=new cloud)."
  exit 1
fi
