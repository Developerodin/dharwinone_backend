import test from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import ReferralAttribution from '../referralAttribution.model.js';

const TEST_URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27017/dharwin_test';

test('partial-unique allows multiple revoked rows for same (cand, job)', async () => {
  await mongoose.connect(TEST_URI);
  await ReferralAttribution.deleteMany({});
  const base = {
    tenantId: new mongoose.Types.ObjectId(),
    subjectProfileId: new mongoose.Types.ObjectId(),
    jobId: new mongoose.Types.ObjectId(),
    salesAgentUserId: new mongoose.Types.ObjectId(),
    salesAgentSnapshot: { name: 'A', email: 'a@x' },
    lifecycleStageAtAssignment: 'hired',
    attributionEventId: 'evt-1',
    assignedByUserId: new mongoose.Types.ObjectId(),
    assignedAt: new Date(),
  };
  await ReferralAttribution.create({ ...base, isCurrent: false, isRevoked: true, attributionEventId: 'evt-2' });
  await ReferralAttribution.create({ ...base, isCurrent: false, isRevoked: true, attributionEventId: 'evt-3' });
  await ReferralAttribution.create({ ...base, isCurrent: true, isRevoked: false });
  await assert.rejects(
    ReferralAttribution.create({ ...base, isCurrent: true, isRevoked: false, attributionEventId: 'evt-dup' }),
    /E11000/
  );
  await mongoose.disconnect();
});

test('null jobId treated as distinct value', async () => {
  await mongoose.connect(TEST_URI);
  await ReferralAttribution.deleteMany({});
  const base = {
    tenantId: new mongoose.Types.ObjectId(),
    subjectProfileId: new mongoose.Types.ObjectId(),
    jobId: null,
    salesAgentUserId: new mongoose.Types.ObjectId(),
    salesAgentSnapshot: { name: 'A', email: 'a@x' },
    lifecycleStageAtAssignment: 'applied',
    attributionEventId: 'evt-null-1',
    assignedByUserId: new mongoose.Types.ObjectId(),
    assignedAt: new Date(),
  };
  await ReferralAttribution.create({ ...base, isCurrent: true, isRevoked: false });
  await assert.rejects(
    ReferralAttribution.create({ ...base, isCurrent: true, isRevoked: false, attributionEventId: 'evt-null-dup' }),
    /E11000/
  );
  await mongoose.disconnect();
});
