/* eslint-disable no-console */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Role from '../../src/models/role.model.js';
import { bustRoleRegistry } from '../../src/services/chatAssistant/roleRegistry.js';

dotenv.config();

export const MIGRATION_VERSION = '2026-07-01-contacts-permission-row';
export const BATCH_SIZE = 500;

const CONTACTS_ROW = 'communication.contacts:view,create,edit,delete';

export function migrateRole(permissions) {
  const perms = Array.isArray(permissions) ? [...permissions] : [];
  const hasCalling = perms.some((p) => typeof p === 'string' && p.startsWith('communication.calling:'));
  if (!hasCalling) return perms;
  if (perms.includes(CONTACTS_ROW)) return perms;
  return [...perms, CONTACTS_ROW];
}

export async function main() {
  if (!process.env.MONGODB_URL) {
    console.error('MONGODB_URL not set in env');
    process.exit(2);
  }
  await mongoose.connect(process.env.MONGODB_URL);
  try {
    let scanned = 0;
    let mutated = 0;
    let batchCounter = 0;

    for await (const role of Role.find({}).cursor()) {
      scanned += 1;
      const original = role.permissions || [];
      const next = migrateRole(original);
      if (next.length !== original.length || next.some((p, i) => p !== original[i])) {
        await Role.updateOne({ _id: role._id }, { $set: { permissions: next } });
        mutated += 1;
      }
      if (++batchCounter >= BATCH_SIZE) {
        await bustRoleRegistry();
        batchCounter = 0;
      }
    }

    await bustRoleRegistry();
    console.log('[Migration]', MIGRATION_VERSION, 'summary:', JSON.stringify({ scanned, mutated }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (process.argv[1] && process.argv[1].endsWith('2026-07-01-contacts-permission-row.js')) {
  main();
}
