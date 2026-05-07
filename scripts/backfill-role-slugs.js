/**
 * One-shot migration: backfill `slug` and seed `aliases` on existing Role rows.
 *
 * Idempotent — re-runs are safe.
 *
 * Usage:
 *   node scripts/backfill-role-slugs.js          # dry run
 *   node scripts/backfill-role-slugs.js --apply  # write
 */

import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import path from 'path';

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const MONGO_URL = process.env.MONGODB_URL || process.env.MONGO_URI || process.env.DATABASE_URL;
if (!MONGO_URL) {
  console.error('No MongoDB URL found in env. Set MONGODB_URL.');
  process.exit(1);
}

const APPLY = process.argv.includes('--apply');

const slugify = (s) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '')
    .replace(/[^a-z0-9]/g, '');

const ALIAS_SEEDS = {
  Employee:      ['employees'],
  Candidate:     ['candidate', 'candidates', 'applicant', 'applicants'],
  Agent:         ['agent', 'agents'],
  agent:         ['Agent'],
  SalesAgent:    ['sales agent', 'sales_agent', 'sales agents'],
  'Sales Agent': ['sales_agent', 'salesagent'],
  sales_agent:   ['Sales Agent', 'salesagent', 'sales agent'],
  Recruiter:     ['recruiters'],
  Administrator: ['admin', 'admins', 'administrators'],
  Student:       ['students'],
  Manager:       ['managers'],
  Mentor:        ['mentors'],
};

async function main() {
  await mongoose.connect(MONGO_URL);

  const Role = mongoose.connection.collection('roles');

  let scanned = 0;
  let needsSlug = 0;
  let needsAliases = 0;
  let updated = 0;
  const collisions = [];
  const seenSlugs = new Map();

  const docs = await Role.find({}).toArray();
  for (const d of docs) {
    scanned += 1;
    const slug = d.slug || slugify(d.name);
    if (!slug) continue;
    if (seenSlugs.has(slug)) {
      collisions.push({ slug, names: [seenSlugs.get(slug), d.name] });
    } else {
      seenSlugs.set(slug, d.name);
    }
  }

  if (collisions.length) {
    console.warn('Slug collisions (multiple Role docs would map to the same slug):');
    for (const c of collisions) console.warn('  ', c.slug, '->', c.names.join(' + '));
    console.warn('Second occurrence will be left without a slug. Resolve manually.');
  }

  for (const d of docs) {
    const ops = {};
    const slug = d.slug || slugify(d.name);

    if (!d.slug && slug) {
      const taken = collisions.some((c) => c.slug === slug && c.names[0] !== d.name);
      if (!taken) {
        ops.slug = slug;
        needsSlug += 1;
      }
    }

    const seed = ALIAS_SEEDS[d.name] || [];
    const current = Array.isArray(d.aliases) ? d.aliases : [];
    const merged = [...new Set([...current, ...seed].filter(Boolean))];
    if (merged.length !== current.length) {
      ops.aliases = merged;
      needsAliases += 1;
    }

    if (Object.keys(ops).length === 0) continue;

    if (APPLY) {
      await Role.updateOne({ _id: d._id }, { $set: ops });
    }
    updated += 1;
  }

  console.log(`Scanned:       ${scanned}`);
  console.log(`Needs slug:    ${needsSlug}`);
  console.log(`Needs aliases: ${needsAliases}`);
  console.log(`Will update:   ${updated} ${APPLY ? '(written)' : '(dry run -- pass --apply)'}`);
  console.log(`Collisions:    ${collisions.length}`);

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
