/**
 * Guard: JobApplication.status is written ONLY through services/applicationStatusHistory.js.
 * Any other write leaves a silent gap in statusHistory / statusChangedAt, so this fails and
 * lists file:line.
 *
 * Static scan (no DB). What it catches, per file under src/ (tests and the helper excluded):
 *   - <Model>[.collection].updateOne / updateMany / findOneAndUpdate / findByIdAndUpdate /
 *     replaceOne / findOneAndReplace / findByIdAndReplace with a `status` key in the update arg
 *   - <Model>[.collection].bulkWrite with a `status` key anywhere
 *   - <Model>.create / insertMany / new <Model>( without initialStatusFields(
 *   - <app-ish var>.status = …, <app-ish var>.updateOne({ status … }), .set('status', …)
 *   - mongoose.model('JobApplication') (an untracked handle)
 * <Model> = whatever name the file imports jobApplication.model.js as (static or dynamic import).
 *
 * Ceiling: an update object built in a variable elsewhere (`updateOne(f, update)`), or a doc
 * held in a variable whose name has no "app" in it, is invisible to a text scan. Keep status
 * writes literal at the call site; if that stops being true, move to a Mongoose pre-hook guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const HELPER = path.join(SRC, 'services', 'applicationStatusHistory.js');

const UPDATE_METHODS =
  'updateOne|updateMany|findOneAndUpdate|findByIdAndUpdate|replaceOne|findOneAndReplace|findByIdAndReplace';
const STATUS_KEY = /(^|[\s{,$])['"]?status['"]?\s*:|[{,]\s*status\s*[,}]|['"]status['"]\s*,/;

const listFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((ent) => {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) return ent.name === '__tests__' || ent.name === 'node_modules' ? [] : listFiles(full);
    return /\.(m?js)$/.test(ent.name) && !/\.test\.m?js$/.test(ent.name) ? [full] : [];
  });

/** Text inside the parentheses that open at `open` (index of '('), skipping string contents. */
const callBody = (src, open) => {
  let depth = 0;
  let quote = null;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return src.slice(open + 1);
};

/** Split call arguments on top-level commas. */
const topLevelArgs = (body) => {
  const out = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if ('({['.includes(ch)) depth += 1;
    else if (')}]'.includes(ch)) depth -= 1;
    else if (ch === ',' && depth === 0) {
      out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  out.push(body.slice(start));
  return out;
};

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

const modelNames = (src) => {
  const names = new Set();
  const patterns = [
    /import\s+(\w+)\s+from\s+['"][^'"]*jobApplication\.model(?:\.js)?['"]/g,
    /(?:const|let|var)\s+(\w+)\s*=\s*\(\s*await\s+import\(\s*['"][^'"]*jobApplication\.model(?:\.js)?['"]\s*\)\s*\)\.default/g,
    /\{\s*default\s*:\s*(\w+)\s*\}\s*=\s*await\s+import\(\s*['"][^'"]*jobApplication\.model(?:\.js)?['"]/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) names.add(m[1]);
  return [...names];
};

/**
 * @param {string} src file contents
 * @returns {{ line: number, reason: string }[]}
 */
export const findStatusWrites = (src) => {
  const hits = [];
  const add = (idx, reason) => hits.push({ line: lineOf(src, idx), reason });

  for (const M of modelNames(src)) {
    const m = M.replace(/\$/g, '\\$');
    for (const hit of src.matchAll(new RegExp(`\\b${m}(?:\\.collection)?\\.(${UPDATE_METHODS})\\s*\\(`, 'g'))) {
      const args = topLevelArgs(callBody(src, hit.index + hit[0].length - 1));
      if (args[1] && STATUS_KEY.test(args[1])) add(hit.index, `${M}.${hit[1]} writes status`);
    }
    for (const hit of src.matchAll(new RegExp(`\\b${m}(?:\\.collection)?\\.bulkWrite\\s*\\(`, 'g'))) {
      if (STATUS_KEY.test(callBody(src, hit.index + hit[0].length - 1))) add(hit.index, `${M}.bulkWrite writes status`);
    }
    for (const hit of src.matchAll(new RegExp(`(?:\\b${m}\\.(create|insertMany)|\\bnew\\s+${m})\\s*\\(`, 'g'))) {
      if (!callBody(src, hit.index + hit[0].length - 1).includes('initialStatusFields(')) {
        add(hit.index, `${hit[1] ? `${M}.${hit[1]}` : `new ${M}`} without initialStatusFields()`);
      }
    }
  }

  for (const hit of src.matchAll(/\b(\w*app\w*)\.status\s*=(?!=)/gi)) add(hit.index, `${hit[1]}.status assigned`);
  for (const hit of src.matchAll(/\b(\w*app\w*)\.(updateOne|update|replaceOne)\s*\(/gi)) {
    if (/^(JobApplication)$/.test(hit[1])) continue;
    const args = topLevelArgs(callBody(src, hit.index + hit[0].length - 1));
    if (STATUS_KEY.test(args[0] || '')) add(hit.index, `${hit[1]}.${hit[2]} writes status`);
  }
  for (const hit of src.matchAll(/\b(\w*app\w*)\.set\s*\(\s*['"]status['"]/gi)) add(hit.index, `${hit[1]}.set('status')`);
  for (const hit of src.matchAll(/mongoose\.model\(\s*['"]JobApplication['"]\s*\)/g)) {
    add(hit.index, "mongoose.model('JobApplication') handle — import the model instead");
  }
  return hits;
};

test('no code writes JobApplication.status outside applicationStatusHistory.js', () => {
  const offenders = [];
  for (const file of listFiles(SRC)) {
    if (path.resolve(file) === path.resolve(HELPER)) continue;
    const src = fs.readFileSync(file, 'utf8');
    for (const h of findStatusWrites(src)) offenders.push(`${path.relative(SRC, file)}:${h.line}  ${h.reason}`);
  }
  assert.deepEqual(offenders, [], `route these through applicationStatusHistory.js:\n${offenders.join('\n')}`);
});

test('the scan actually detects each write shape (positive controls)', () => {
  const src = `
import JobApplication from '../models/jobApplication.model.js';
await JobApplication.updateOne({ _id: id }, { $set: { status: 'Interview' } });
await JobApplication.findByIdAndUpdate(id, { status: 'Hired' }, opts);
await JobApplication.updateMany({ _id: { $in: ids } }, { $set: { status } });
await JobApplication.bulkWrite([{ updateOne: { filter: {}, update: { $set: { status: 'x' } } } }]);
await JobApplication.collection.updateOne({ _id }, { $set: { 'status': 'x' } });
await JobApplication.create({ job, candidate, status: 'Applied' });
application.status = 'Offered';
await application.updateOne({ status: 'Offered' });
app.set('status', 'Hired');
const Other = mongoose.model('JobApplication');
`;
  const reasons = findStatusWrites(src).map((h) => h.reason);
  assert.equal(reasons.length, 10, reasons.join('\n'));
});

test('the scan ignores non-status writes and status in filters', () => {
  const src = `
import JobApplication from '../models/jobApplication.model.js';
await JobApplication.updateOne({ _id, status: 'Interview' }, { $set: { verificationCallStatus: 'failed' } });
await JobApplication.findOneAndUpdate({ status: { $in: OPEN } }, { $inc: { roundCounter: 1 } });
await JobApplication.create({ job, candidate, ...initialStatusFields('Applied', { by }) });
if (application.status === 'Hired') {}
meeting.status = 'ended';
`;
  assert.deepEqual(findStatusWrites(src), []);
});
