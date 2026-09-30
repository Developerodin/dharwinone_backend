/**
 * Each rewired status write still sets the same status, now with a history entry.
 *   - jobApplication.service (manual PATCH + create): run for real with mocked deps.
 *   - schema: the new fields cast and validate; an unrelated save never persists an empty history.
 *   - meeting / offer sites: each function calls the helper with its original target status
 *     (their modules need a live DB / dozens of mocks, so this is checked per function body).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = '00000000000000000000a001';
const USER = '00000000000000000000b001';

const loadJobApplicationService = async ({ appDoc, created }) => {
  mock.reset();
  mock.module('../../models/jobApplication.model.js', {
    defaultExport: {
      findById: async () => appDoc,
      findOne: async () => null,
      create: async (fields) => {
        created.push(fields);
        return { ...fields, populate: async () => {} };
      },
    },
  });
  mock.module('../../models/employee.model.js', { defaultExport: { findById: async () => ({ _id: 'cand' }) } });
  mock.module('../job.service.js', {
    namedExports: { getJobById: async () => ({ _id: 'job' }), isOwnerOrAdmin: async () => true },
  });
  mock.module('../referralLeads.service.js', {
    namedExports: {
      syncReferralPipelineStatusForCandidate: async () => {},
      syncReferralPipelineAfterApplicationWithdrawal: async () => {},
    },
  });
  mock.module('../applicantQuery.service.js', { namedExports: { queryApplicants: async () => ({}) } });
  return import(`../jobApplication.service.js?h=${Math.random()}`);
};

const fakeAppDoc = (status) => ({
  _id: APP,
  job: 'job',
  candidate: 'cand',
  status,
  saved: 0,
  async save() {
    this.saved += 1;
  },
  async populate() {
    return this;
  },
});

test('manual PATCH: same status set, one `manual` entry with the acting user', async () => {
  const appDoc = fakeAppDoc('Applied');
  const svc = await loadJobApplicationService({ appDoc, created: [] });
  await svc.updateJobApplicationStatus(APP, { status: 'Screening' }, { id: USER });
  assert.equal(appDoc.status, 'Screening');
  assert.equal(appDoc.saved, 1);
  assert.ok(appDoc.statusChangedAt instanceof Date);
  assert.equal(appDoc.statusHistory.length, 1);
  assert.deepEqual(
    { ...appDoc.statusHistory[0], at: undefined },
    { from: 'Applied', to: 'Screening', at: undefined, by: USER, source: 'manual', approximate: false }
  );
});

test('manual PATCH with an unchanged status (notes edit) records nothing', async () => {
  const appDoc = fakeAppDoc('Screening');
  const svc = await loadJobApplicationService({ appDoc, created: [] });
  await svc.updateJobApplicationStatus(APP, { status: 'Screening', notes: 'n' }, { id: USER });
  assert.equal(appDoc.status, 'Screening');
  assert.equal(appDoc.statusHistory, undefined);
  assert.equal(appDoc.notes, 'n');
});

test('create: starts with a `created` entry at the requested status', async () => {
  const created = [];
  const svc = await loadJobApplicationService({ appDoc: null, created });
  await svc.createJobApplication({ job: 'job', candidate: 'cand', status: 'Interview' }, { id: USER });
  await svc.createJobApplication({ job: 'job', candidate: 'cand' }, { id: USER });
  assert.equal(created[0].status, 'Interview');
  assert.deepEqual(
    created.map((c) => c.statusHistory.map((e) => [e.from, e.to, e.source, e.by])),
    [[[null, 'Interview', 'created', USER]], [[null, 'Applied', 'created', USER]]]
  );
});

// ─── Schema ─────────────────────────────────────────────────────────────────────────────────

test('schema: history entries cast (by → ObjectId), validate, and statusChangedAt is indexed', async () => {
  mock.reset();
  const { default: JobApplication } = await import('../../models/jobApplication.model.js');
  const { initialStatusFields } = await import('../applicationStatusHistory.js');
  const doc = new JobApplication({
    job: new mongoose.Types.ObjectId(),
    candidate: new mongoose.Types.ObjectId(),
    ...initialStatusFields('Applied', { by: USER }),
  });
  assert.equal(doc.validateSync(), undefined);
  assert.ok(doc.statusHistory[0].by instanceof mongoose.Types.ObjectId);
  assert.equal(doc.statusHistory[0]._id, undefined, 'entries have no _id');
  assert.ok(JobApplication.schema.indexes().some(([fields]) => fields.statusChangedAt === 1));
});

test('schema: an old application saved for an unrelated edit does not gain an empty statusHistory', async () => {
  mock.reset();
  const { default: JobApplication } = await import('../../models/jobApplication.model.js');
  const doc = JobApplication.hydrate({
    _id: new mongoose.Types.ObjectId(),
    job: new mongoose.Types.ObjectId(),
    candidate: new mongoose.Types.ObjectId(),
    status: 'Applied',
  });
  assert.equal(doc.statusHistory, undefined);
  doc.notes = 'edited';
  const changes = doc.getChanges();
  assert.equal(changes.$set?.statusHistory, undefined);
  assert.equal(changes.$set?.notes, 'edited');
});

test('schema: the helper $push casts through Mongoose (plain update, no pipeline)', async () => {
  mock.reset();
  const { default: JobApplication } = await import('../../models/jobApplication.model.js');
  const { statusEntry } = await import('../applicationStatusHistory.js');
  const q = JobApplication.updateOne(
    { _id: APP, status: 'Interview' },
    { $set: { status: 'Offered', statusChangedAt: new Date() }, $push: { statusHistory: statusEntry({ from: 'Interview', to: 'Offered', by: USER, source: 'offer_created' }) } }
  );
  const cast = q._castUpdate(q.getUpdate());
  assert.ok(cast.$push.statusHistory.by instanceof mongoose.Types.ObjectId);
});

// ─── meeting / offer sites ──────────────────────────────────────────────────────────────────

/** Body of a top-level function declared as `const name = async (...` or `async function name(`. */
const functionBody = (src, name) => {
  const start = src.search(new RegExp(`(?:const ${name} = async|async function ${name}\\s*\\()`));
  assert.ok(start >= 0, `function ${name} not found`);
  const rest = src.slice(start + 1);
  const next = rest.search(/\n(?:const \w+ = |async function |function |export )/);
  return next < 0 ? rest : rest.slice(0, next);
};

const SITES = [
  ['meeting.service.js', 'rollbackInterviewSelectionPipeline', /recordStatusChange\([^;]*'Interview'[^;]*interview_result_reverted/],
  ['meeting.service.js', 'applyInterviewRejectionToApplication', /recordStatusChange\([^;]*'Rejected'[^;]*interview_rejected/],
  ['meeting.service.js', 'reopenApplicationAfterInterviewRejection', /recordStatusChange\([^;]*'Interview'[^;]*interview_reopened/],
  ['meeting.service.js', 'transitionApplicationToInterview', /applyStatusChange\(application, 'Interview'[^;]*interview_scheduled/],
  ['meeting.service.js', 'transferEmployeeInternally', /applyStatusChange\(application, 'Hired'[^;]*internal_transfer/],
  ['offer.service.js', 'createStandaloneApplicationForOfferLetter', /initialStatusFields\('Applied'/],
  ['offer.service.js', 'createOfferCore', /recordStatusChange\([^;]*'Offered'[^;]*offer_created/],
  ['offer.service.js', 'updateOfferById', /recordStatusChange\([^;]*'Hired'[^;]*offer_accepted[^;]*session/],
  ['offer.service.js', 'updateOfferById', /recordStatusChange\([^;]*'Rejected'[^;]*offer_rejected/],
  ['offer.service.js', 'deleteOfferById', /recordStatusChange\([^;]*'Interview'[^;]*offer_reverted/],
  ['offer.service.js', 'generateOfferLetter', /recordStatusChange\([^;]*'Hired'[^;]*offer_accepted/],
  ['offer.service.js', 'autoExpireOffers', /recordStatusChangeMany\(\{ _id: \{ \$in: appIds \} \}, 'Rejected'[^;]*bulk_reject/],
];

for (const [file, fn, re] of SITES) {
  test(`${file} ${fn}: same target status through the helper`, () => {
    const src = fs.readFileSync(path.join(HERE, '..', file), 'utf8');
    assert.match(functionBody(src, fn), re);
  });
}
