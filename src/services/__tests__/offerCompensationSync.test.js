/**
 * `syncCompensationFromOfferToEmployee` used to return `undefined` down every path, so a sync that
 * never happened was indistinguishable from one that succeeded.
 *
 * That mattered: production holds offers whose `candidate` points at a document that no longer
 * exists. `Employee.findByIdAndUpdate` against a dangling ref is a no-op — no error, no log — so
 * those candidates could never receive their compensation snapshot and nothing said so.
 *
 * The outcome is now a return value, which is real behaviour a test can assert on rather than a
 * logger call a test can only spy on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import Employee from '../../models/employee.model.js';
import { syncCompensationFromOfferToEmployee } from '../offer.service.js';

const TEST_URI =
  process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_compensation';
const MARKER = 'SYNC_FIXTURE';

/** The sync reads plain fields, so an offer-shaped object is enough — nothing is persisted. */
const offerLike = (over = {}) => ({
  jobType: 'INTERN_UNPAID',
  status: 'Accepted',
  compensationType: 'unpaid',
  compensationSource: 'jobTypeDerived',
  candidate: new mongoose.Types.ObjectId(),
  ...over,
});

const seedCandidate = async () =>
  Employee.create({
    fullName: MARKER,
    email: `sync-fixture-${new mongoose.Types.ObjectId()}@fixture.local`,
    phoneNumber: '0000000000',
    owner: new mongoose.Types.ObjectId(),
    adminId: new mongoose.Types.ObjectId(),
    compensationType: 'paid',
    compensationSource: 'jobTypeDerived',
  });

test.before(async () => {
  assert.notEqual(
    TEST_URI,
    config.mongoose.url,
    'Refusing to run: the test URI equals the app database URI. Local dev and staging share one ' +
      'MongoDB, so this suite must never point at it. Set TEST_MONGODB_URL to a dedicated database.'
  );
  if (mongoose.connection.readyState === 0) {
    await mongoose.connect(TEST_URI);
  }
});

test.after(async () => {
  await Employee.collection.deleteMany({ fullName: MARKER });
  await mongoose.disconnect();
});

test('reports a successful sync and writes the snapshot', async () => {
  const candidate = await seedCandidate();

  const outcome = await syncCompensationFromOfferToEmployee(offerLike({ candidate: candidate._id }));

  assert.equal(outcome, 'synced');
  const after = await Employee.findById(candidate._id).lean();
  assert.equal(after.compensationType, 'unpaid');
});

test('a legacy offer whose stored compensation contradicts its job type syncs from the job type', async () => {
  const candidate = await seedCandidate();

  // Offers written before compensationType existed carry the schema default 'paid' while their
  // jobType says otherwise. jobType is the contract; the stored value is only a cache of it, so
  // the derivation has to win.
  const outcome = await syncCompensationFromOfferToEmployee(
    offerLike({ candidate: candidate._id, jobType: 'INTERN_UNPAID', compensationType: 'paid' })
  );

  assert.equal(outcome, 'synced');
  const after = await Employee.findById(candidate._id).lean();
  assert.equal(after.compensationType, 'unpaid');
});

test('reports a dangling candidate reference instead of silently doing nothing', async () => {
  // Production has offers in exactly this state. Before, this returned undefined and so looked
  // identical to success.
  const outcome = await syncCompensationFromOfferToEmployee(
    offerLike({ candidate: new mongoose.Types.ObjectId() })
  );

  assert.equal(outcome, 'missed:candidate-not-found');
});

test('reports a missing job type rather than skipping quietly', async () => {
  const outcome = await syncCompensationFromOfferToEmployee(offerLike({ jobType: undefined }));

  assert.equal(outcome, 'skipped:no-job-type');
});

test('reports an unresolvable candidate', async () => {
  const outcome = await syncCompensationFromOfferToEmployee(offerLike({ candidate: null }));

  assert.equal(outcome, 'skipped:no-candidate');
});

test('a Draft offer is a normal skip, not a fault', async () => {
  // Draft and Rejected offers are deliberately not mirrored. This must stay distinguishable from
  // the failure outcomes above so monitoring does not cry wolf.
  const outcome = await syncCompensationFromOfferToEmployee(offerLike({ status: 'Draft' }));

  assert.equal(outcome, 'skipped:status');
});
