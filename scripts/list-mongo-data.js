/**
 * List databases, collections, and document counts in MongoDB.
 * Usage: node scripts/list-mongo-data.js
 */
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const mongoUrl = process.env.MONGODB_URL;
if (!mongoUrl) {
  console.error('MONGODB_URL is not set in .env');
  process.exit(1);
}

async function main() {
  await mongoose.connect(mongoUrl, {});
  const admin = mongoose.connection.db.admin();
  const { databases } = await admin.listDatabases();

  console.log('\n=== MongoDB databases ===\n');
  for (const db of databases) {
    console.log(`  ${db.name} (size: ${(db.sizeOnDisk / 1024).toFixed(1)} KB)`);
  }

  const dbName = mongoose.connection.db.databaseName;
  const cols = await mongoose.connection.db.listCollections().toArray();

  console.log(`\n=== Database: ${dbName} ===\n`);
  for (const col of cols) {
    const coll = mongoose.connection.db.collection(col.name);
    const count = await coll.countDocuments();
    console.log(`  ${col.name}: ${count} document(s)`);
    if (count > 0) {
      const one = await coll.findOne({});
      const safe = one && typeof one === 'object' ? { ...one } : one;
      if (safe && safe.password !== undefined) delete safe.password;
      console.log(
        '    Sample (first doc):',
        `${JSON.stringify(safe, null, 2).split('\n').slice(0, 12).join('\n')}\n    ...`
      );
    }
  }

  await mongoose.disconnect();
  console.log('\nDone.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
