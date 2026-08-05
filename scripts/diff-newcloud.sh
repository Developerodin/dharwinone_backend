#!/usr/bin/env bash
# diff-newcloud.sh — on the new Atlas cluster, compare old-cloud copy (<db>)
# vs EC2-latest copy (<db>_ec2local): counts, newest-write ts, per-_id ticket diff.
# Run on EC2 from repo root: bash scripts/diff-newcloud.sh
# Needs in .env:  MONGODB_URL (dbname)  +  NEW_CLOUD_URI (Atlas URI, no db path)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$REPO_DIR/.env"

DB=$(grep '^MONGODB_URL' "$ENV_FILE" | sed -e 's/.*\///' -e 's/[?].*//' | tr -d '\r')
URI=$(grep '^NEW_CLOUD_URI' "$ENV_FILE" | cut -d= -f2- | tr -d '\r')
[ -n "$DB" ] || { echo "FAIL: could not read db name from MONGODB_URL in $ENV_FILE"; exit 1; }
[ -n "$URI" ] || { echo "FAIL: add NEW_CLOUD_URI=mongodb+srv://user:pass@host/ to $ENV_FILE"; exit 1; }

mongosh "$URI" --quiet --eval '
const A = db.getSiblingDB("'"$DB"'");            // old cloud
const B = db.getSiblingDB("'"$DB"'_ec2local");   // EC2 latest

const names = [...new Set([...A.getCollectionNames(), ...B.getCollectionNames()])]
  .filter(n => !n.startsWith("system.")).sort();

const newest = (d, n) => {
  const x = d.getCollection(n).find({}, {createdAt:1, updatedAt:1}).sort({_id:-1}).limit(1).toArray()[0];
  return x ? String(x.updatedAt || x.createdAt || x._id.getTimestamp()).slice(0,24) : "-";
};

print("collection | oldCloud count/newest | ec2local count/newest | verdict");
print("-".repeat(100));
for (const n of names) {
  const ca = A.getCollection(n).countDocuments({});
  const cb = B.getCollection(n).countDocuments({});
  const ta = ca ? newest(A, n) : "-";
  const tb = cb ? newest(B, n) : "-";
  let verdict = "same";
  if (ca !== cb) verdict = cb > ca ? "EC2 HAS MORE (new local writes)" : "OLD CLOUD HAS MORE (cloud-only writes!)";
  else if (ta !== tb) verdict = "same count, different newest ts";
  print(`${n} | ${ca} / ${ta} | ${cb} / ${tb} | ${verdict}`);
}

for (const col of ["supporttickets", "devtickets"]) {
  if (!names.includes(col)) continue;
  const idsA = new Set(A.getCollection(col).find({}, {_id:1}).toArray().map(d=>String(d._id)));
  const idsB = new Set(B.getCollection(col).find({}, {_id:1}).toArray().map(d=>String(d._id)));
  const onlyA = [...idsA].filter(i=>!idsB.has(i));
  const onlyB = [...idsB].filter(i=>!idsA.has(i));
  print(`\n== ${col} ==  onlyOldCloud: ${onlyA.length}   onlyEc2Local: ${onlyB.length}`);
  const show = (d, ids, label) => ids.slice(0,10).forEach(i => {
    const t = d.getCollection(col).findOne({_id: new ObjectId(i)}, {title:1, createdAt:1, createdBy:1});
    print(`  [${label}] ${i} "${t?.title}" created=${t?.createdAt}`);
  });
  show(A, onlyA, "old-cloud-only"); show(B, onlyB, "ec2-only");
}'
