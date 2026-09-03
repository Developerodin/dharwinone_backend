/**
 * Guards the compensation snapshot against incidental writes.
 *
 * `Employee.compensationType` is derived from the accepted offer's jobType and is meant to be a
 * frozen snapshot. The employee edit form PATCHes its whole body — 23 fields including
 * compensationType — on every save, so any form instance loaded before an offer-driven change and
 * saved after it silently reverted the snapshot. In production this mislabelled every accepted
 * unpaid-internship hire as `compensationSource: 'manual'` and reverted three of them to `paid`.
 *
 * Permission alone cannot tell "I intend to override compensation" apart from "I saved a form that
 * happened to carry the field". Intent has to be explicit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import config from '../../config/config.js';
import Employee from '../../models/employee.model.js';
import Offer from '../../models/offer.model.js';
import { updateCandidateById } from '../employee.service.js';

const TEST_URI =
  process.env.TEST_MONGODB_URL || 'mongodb://127.0.0.1:27017/dharwin_test_compensation';
const MARKER = 'COMPENSATION_WRITE_FIXTURE';

const adminId = new mongoose.Types.ObjectId();

/** Admin: full edit rights AND compensation override rights. The riskiest caller. */
const admin = {
  _id: adminId,
  id: String(adminId),
  canManageCandidates: true,
  canEditEmployees: true,
  canOverrideCompensation: true,
};

/**
 * The employee edit form's real payload shape: every field it renders, on every save,
 * regardless of what the user actually touched.
 */
const bulkFormBody = (compensationType) => ({
  fullName: 'Unpaid Intern Fixture',
  shortBio: 'edited something unrelated',
  compensationType,
});

/** Candidate with an Accepted unpaid offer — i.e. a locked, offer-derived snapshot. */
const seedLockedUnpaidCandidate = async () => {
  const candidate = await Employee.create({
    fullName: 'Unpaid Intern Fixture',
    email: `comp-fixture-${new mongoose.Types.ObjectId()}@fixture.local`,
    phoneNumber: '0000000000',
    owner: new mongoose.Types.ObjectId(),
    adminId,
    shortBio: MARKER,
    compensationType: 'unpaid',
    compensationSource: 'jobTypeDerived',
  });
  await Offer.create({
    candidate: candidate._id,
    job: new mongoose.Types.ObjectId(),
    jobApplication: new mongoose.Types.ObjectId(),
    createdBy: adminId,
    offerCode: `FIXTURE-${new mongoose.Types.ObjectId()}`,
    jobType: 'INTERN_UNPAID',
    compensationType: 'unpaid',
    compensationSource: 'jobTypeDerived',
    status: 'Accepted',
    notes: MARKER,
  });
  return candidate;
};

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
  await Employee.collection.deleteMany({ fullName: 'Unpaid Intern Fixture' });
  await Offer.collection.deleteMany({ notes: MARKER });
  await mongoose.disconnect();
});

test('a bulk form save that re-sends the same compensation does not claim it was set manually', async () => {
  const candidate = await seedLockedUnpaidCandidate();

  await updateCandidateById(String(candidate._id), bulkFormBody('unpaid'), admin);

  const after = await Employee.findById(candidate._id).lean();
  assert.equal(after.compensationType, 'unpaid');
  assert.equal(
    after.compensationSource,
    'jobTypeDerived',
    'resending an unchanged value must not rewrite provenance to "manual"'
  );
});

test('a stale bulk form save cannot revert a locked compensation snapshot', async () => {
  const candidate = await seedLockedUnpaidCandidate();

  // The form was loaded before the offer was accepted, so it still holds 'paid'.
  await updateCandidateById(String(candidate._id), bulkFormBody('paid'), admin);

  const after = await Employee.findById(candidate._id).lean();
  assert.equal(
    after.compensationType,
    'unpaid',
    'an incidental bulk PATCH must not overwrite the offer-derived snapshot, even for an admin'
  );
});

test('an unrelated field in the same stale save still persists', async () => {
  const candidate = await seedLockedUnpaidCandidate();

  await updateCandidateById(String(candidate._id), bulkFormBody('paid'), admin);

  const after = await Employee.findById(candidate._id).lean();
  assert.equal(
    after.shortBio,
    'edited something unrelated',
    'dropping compensationType must not discard the rest of the payload'
  );
});

test('an admin who explicitly intends to override still can', async () => {
  const candidate = await seedLockedUnpaidCandidate();

  await updateCandidateById(
    String(candidate._id),
    { ...bulkFormBody('paid'), compensationOverride: true },
    admin
  );

  const after = await Employee.findById(candidate._id).lean();
  assert.equal(after.compensationType, 'paid');
  assert.equal(after.compensationSource, 'manual', 'a deliberate override is genuinely manual');
});

test('explicit intent does not let a non-admin override a locked snapshot', async () => {
  const candidate = await seedLockedUnpaidCandidate();
  const nonAdmin = { ...admin, canOverrideCompensation: false };

  await updateCandidateById(
    String(candidate._id),
    { ...bulkFormBody('paid'), compensationOverride: true },
    nonAdmin
  );

  const after = await Employee.findById(candidate._id).lean();
  assert.equal(after.compensationType, 'unpaid', 'intent does not substitute for permission');
});
