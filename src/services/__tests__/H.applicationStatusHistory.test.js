/**
 * applicationStatusHistory.js — write helpers (model mocked, no DB), readers, and the pure
 * backfill builder / undo selection.
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const APP = '00000000000000000000a001';
const USER = '00000000000000000000b001';

/** Fake JobApplication: an in-memory status per id, recording every call. */
const makeModel = (statuses, { raceOnce = false } = {}) => {
  const calls = { findOne: [], updateOne: [], find: [], bulkWrite: [] };
  let raced = !raceOnce;
  const model = {
    findOne: (filter, projection, opts) => {
      calls.findOne.push({ filter, projection, opts });
      return {
        lean: async () => {
          const id = String(filter._id);
          return id in statuses ? { _id: id, status: statuses[id] } : null;
        },
      };
    },
    updateOne: async (filter, update, opts) => {
      calls.updateOne.push({ filter, update, opts });
      const id = String(filter._id);
      if (!raced) {
        raced = true;
        statuses[id] = 'Screening';
        return { modifiedCount: 0 };
      }
      if (statuses[id] !== filter.status) return { modifiedCount: 0 };
      statuses[id] = update.$set.status;
      return { modifiedCount: 1 };
    },
    find: (filter, projection, opts) => {
      calls.find.push({ filter, projection, opts });
      const ids = filter.$and[0]._id.$in.map(String);
      const to = filter.$and[1].status.$ne;
      return { lean: async () => ids.filter((id) => statuses[id] !== to).map((id) => ({ _id: id, status: statuses[id] })) };
    },
    bulkWrite: async (ops, opts) => {
      calls.bulkWrite.push({ ops, opts });
      let modifiedCount = 0;
      for (const { updateOne: u } of ops) {
        const id = String(u.filter._id);
        if (statuses[id] === u.filter.status) {
          statuses[id] = u.update.$set.status;
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
  };
  return { model, calls };
};

const load = async (model) => {
  mock.reset();
  mock.module('../../models/jobApplication.model.js', { defaultExport: model });
  mock.module('../../config/logger.js', { defaultExport: { warn: () => {}, info: () => {}, error: () => {} } });
  return import(`../applicationStatusHistory.js?h=${Math.random()}`);
};

// ─── recordStatusChange ─────────────────────────────────────────────────────────────────────

test('recordStatusChange: sets status, statusChangedAt and pushes the entry in ONE plain update', async () => {
  const { model, calls } = makeModel({ [APP]: 'Interview' });
  const h = await load(model);
  const at = new Date('2026-09-01T10:00:00Z');
  const out = await h.recordStatusChange({ applicationId: APP }, 'Offered', { by: USER, source: 'offer_created', at });
  assert.deepEqual(out, { changed: true, from: 'Interview' });
  assert.equal(calls.updateOne.length, 1);
  const { filter, update } = calls.updateOne[0];
  assert.deepEqual(filter, { _id: APP, status: 'Interview' });
  assert.ok(!Array.isArray(update), 'never an aggregation-pipeline update');
  assert.deepEqual(update.$set, { status: 'Offered', statusChangedAt: at });
  assert.deepEqual(update.$push.statusHistory, {
    from: 'Interview', to: 'Offered', at, by: USER, source: 'offer_created', approximate: false,
  });
});

test('recordStatusChange: no-op (no update) when the status is already the target', async () => {
  const { model, calls } = makeModel({ [APP]: 'Hired' });
  const h = await load(model);
  const out = await h.recordStatusChange({ applicationId: APP }, 'Hired', { source: 'offer_accepted' });
  assert.deepEqual(out, { changed: false, from: 'Hired' });
  assert.equal(calls.updateOne.length, 0);
});

test('recordStatusChange: missing application (or null id) is a no-op', async () => {
  const { model, calls } = makeModel({});
  const h = await load(model);
  assert.deepEqual(await h.recordStatusChange({ applicationId: null }, 'Rejected', { source: 'offer_rejected' }), {
    changed: false, from: null,
  });
  assert.equal(calls.updateOne.length, 0);
});

test('recordStatusChange: passes the session to both the read and the write', async () => {
  const { model, calls } = makeModel({ [APP]: 'Offered' });
  const h = await load(model);
  const session = { id: 'txn' };
  await h.recordStatusChange({ applicationId: APP }, 'Hired', { source: 'offer_accepted', session });
  assert.equal(calls.findOne[0].opts.session, session);
  assert.equal(calls.updateOne[0].opts.session, session);
});

test('recordStatusChange: a lost race re-reads and records the real `from`', async () => {
  const { model, calls } = makeModel({ [APP]: 'Applied' }, { raceOnce: true });
  const h = await load(model);
  const out = await h.recordStatusChange({ applicationId: APP }, 'Rejected', { source: 'interview_rejected' });
  assert.deepEqual(out, { changed: true, from: 'Screening' });
  assert.equal(calls.updateOne.length, 2);
  assert.equal(calls.updateOne[1].update.$push.statusHistory.from, 'Screening');
});

test('recordStatusChange: accepts a populated document as applicationId', async () => {
  const { model, calls } = makeModel({ [APP]: 'Interview' });
  const h = await load(model);
  await h.recordStatusChange({ applicationId: { _id: APP, status: 'Interview' } }, 'Offered', { source: 'offer_created' });
  assert.equal(String(calls.findOne[0].filter._id), APP);
});

// ─── recordStatusChangeMany ─────────────────────────────────────────────────────────────────

test('recordStatusChangeMany: each row records its own from; rows already at target are skipped', async () => {
  const B = '00000000000000000000a002';
  const C = '00000000000000000000a003';
  const { model, calls } = makeModel({ [APP]: 'Offered', [B]: 'Interview', [C]: 'Rejected' });
  const h = await load(model);
  const out = await h.recordStatusChangeMany({ _id: { $in: [APP, B, C] } }, 'Rejected', { source: 'bulk_reject' });
  assert.deepEqual(out, { modified: 2 });
  const pushed = calls.bulkWrite[0].ops.map((o) => o.updateOne.update.$push.statusHistory);
  assert.deepEqual(pushed.map((e) => [e.from, e.to, e.source]), [
    ['Offered', 'Rejected', 'bulk_reject'],
    ['Interview', 'Rejected', 'bulk_reject'],
  ]);
  assert.deepEqual(calls.bulkWrite[0].ops[0].updateOne.filter, { _id: APP, status: 'Offered' });
});

test('recordStatusChangeMany: session is passed through; nothing to do → no bulkWrite', async () => {
  const { model, calls } = makeModel({ [APP]: 'Rejected' });
  const h = await load(model);
  const session = { id: 'txn' };
  assert.deepEqual(await h.recordStatusChangeMany({ _id: { $in: [APP] } }, 'Rejected', { source: 'bulk_reject', session }), {
    modified: 0,
  });
  assert.equal(calls.find[0].opts.session, session);
  assert.equal(calls.bulkWrite.length, 0);
});

// ─── applyStatusChange / initialStatusFields ────────────────────────────────────────────────

test('applyStatusChange: mutates status, statusChangedAt and appends (creating the array when absent)', async () => {
  const h = await load(makeModel({}).model);
  const at = new Date('2026-09-02T00:00:00Z');
  const doc = { status: 'Applied' };
  assert.equal(h.applyStatusChange(doc, 'Screening', { by: USER, source: 'manual', at }), true);
  assert.equal(doc.status, 'Screening');
  assert.equal(doc.statusChangedAt, at);
  assert.deepEqual(doc.statusHistory, [{ from: 'Applied', to: 'Screening', at, by: USER, source: 'manual', approximate: false }]);
  h.applyStatusChange(doc, 'Rejected', { source: 'manual', at });
  assert.equal(doc.statusHistory.length, 2);
  assert.equal(doc.statusHistory[1].from, 'Screening');
});

test('applyStatusChange: unchanged status → false, nothing touched', async () => {
  const h = await load(makeModel({}).model);
  const doc = { status: 'Interview', statusChangedAt: 'old' };
  assert.equal(h.applyStatusChange(doc, 'Interview', { source: 'interview_scheduled' }), false);
  assert.equal(doc.statusChangedAt, 'old');
  assert.equal(doc.statusHistory, undefined);
});

test('initialStatusFields: status + created entry with from null', async () => {
  const h = await load(makeModel({}).model);
  const at = new Date('2026-09-03T00:00:00Z');
  assert.deepEqual(h.initialStatusFields('Interview', { by: USER, at }), {
    status: 'Interview',
    statusChangedAt: at,
    statusHistory: [{ from: null, to: 'Interview', at, by: USER, source: 'created', approximate: false }],
  });
  assert.equal(h.initialStatusFields().status, 'Applied');
});

// ─── Readers ────────────────────────────────────────────────────────────────────────────────

const d = (s) => new Date(`2026-08-${s}T00:00:00Z`);

test('stageEntryDates: full history → basis history, first entry per status, approximate flagged', async () => {
  const h = await load(makeModel({}).model);
  const app = {
    createdAt: d('01'),
    statusHistory: [
      { from: null, to: 'Applied', at: d('01') },
      { from: 'Applied', to: 'Interview', at: d('05') },
      { from: 'Interview', to: 'Rejected', at: d('06') },
      { from: 'Rejected', to: 'Interview', at: d('07') },
      { from: 'Interview', to: 'Offered', at: d('10'), approximate: true },
    ],
  };
  const r = h.stageEntryDates(app, { Interview: d('02') });
  assert.equal(r.basis, 'history');
  assert.equal(r.approximate, true);
  assert.deepEqual(r.stages.Interview, d('05'), 'history wins over derived dates');
  assert.deepEqual(r.stages.Offered, d('10'));
});

test('stageEntryDates: no history → derived dates; nothing → none; partial live-only history → derived', async () => {
  const h = await load(makeModel({}).model);
  const derived = h.stageEntryDates({ createdAt: d('01') }, { Interview: d('04'), Offered: null });
  assert.deepEqual(derived, { basis: 'derived', approximate: false, stages: { Interview: d('04'), Applied: d('01') } });
  assert.equal(h.stageEntryDates({ createdAt: d('01') }).basis, 'none');
  const partial = { createdAt: d('01'), statusHistory: [{ from: 'Interview', to: 'Offered', at: d('09') }] };
  assert.equal(h.stageEntryDates(partial, { Interview: d('04') }).basis, 'derived');
  assert.deepEqual(
    h.tallyBasis([{ basis: 'history', approximate: true }, { basis: 'derived' }, { basis: 'none' }, { basis: 'history' }]),
    { history: 2, derived: 1, none: 1, approximate: 1 }
  );
});

test('lastStatusChangeAt / unchangedSinceFilter: statusChangedAt when present, else updatedAt', async () => {
  const h = await load(makeModel({}).model);
  assert.deepEqual(h.lastStatusChangeAt({ statusChangedAt: d('03'), updatedAt: d('20') }), { at: d('03'), basis: 'statusChangedAt' });
  assert.deepEqual(h.lastStatusChangeAt({ updatedAt: d('20') }), { at: d('20'), basis: 'updatedAt' });
  assert.deepEqual(h.unchangedSinceFilter(d('10')), {
    $or: [{ statusChangedAt: { $lte: d('10') } }, { statusChangedAt: null, updatedAt: { $lte: d('10') } }],
  });
});

// ─── Backfill builder ───────────────────────────────────────────────────────────────────────

const log = (before, after, at, actor = USER) => ({ actor, createdAt: at, metadata: { statusBefore: before, statusAfter: after } });
const steps = (r) => r.statusHistory.map((e) => `${e.from ?? '∅'}>${e.to}@${e.source}${e.approximate ? '~' : ''}`);

test('backfill: manual changes only — exact from/to/at/by, reaches current status', async () => {
  const h = await load(makeModel({}).model);
  const r = h.buildBackfillHistory({
    application: { status: 'Shortlisted', createdAt: d('01'), updatedAt: d('09') },
    activityLogs: [log('Applied', 'Screening', d('03')), log('Screening', 'Shortlisted', d('05')), log('Screening', 'Screening', d('06'))],
  });
  assert.deepEqual(steps(r), [
    '∅>Applied@backfill:created',
    'Applied>Screening@backfill:activity_log',
    'Screening>Shortlisted@backfill:activity_log',
  ]);
  assert.equal(r.statusHistory[1].by, USER);
  assert.equal(r.approximate, false);
  assert.deepEqual(r.statusChangedAt, d('05'));
});

test('backfill: interview + offer accepted — earliest meeting, offer dates, no approximation', async () => {
  const h = await load(makeModel({}).model);
  const r = h.buildBackfillHistory({
    application: { status: 'Hired', createdAt: d('01'), updatedAt: d('20') },
    meetings: [{ createdAt: d('08') }, { createdAt: d('04') }],
    offer: { createdAt: d('10'), acceptedAt: d('15') },
  });
  assert.deepEqual(steps(r), [
    '∅>Applied@backfill:created',
    'Applied>Interview@backfill:meeting',
    'Interview>Offered@backfill:offer',
    'Offered>Hired@backfill:offer',
  ]);
  assert.equal(r.approximate, false);
  assert.deepEqual(r.statusChangedAt, d('15'));
});

test('backfill prefix: live-only history gets the timeline before its first live entry', async () => {
  const h = await load(makeModel({}).model);
  // Live entry Offered→Hired on day 15; offer created day 10, accepted day 15 (not before cutoff).
  const r = h.buildBackfillHistory({
    application: { status: 'Offered', createdAt: d('01'), updatedAt: d('15') },
    meetings: [{ createdAt: d('04') }],
    offer: { createdAt: d('10'), acceptedAt: d('15') },
    before: d('15'),
  });
  assert.deepEqual(steps(r), [
    '∅>Applied@backfill:created',
    'Applied>Interview@backfill:meeting',
    'Interview>Offered@backfill:offer',
  ]);
  assert.equal(r.approximate, false);
  // Nothing reaches the live `from` → approximate bridge at the live entry's time.
  const gap = h.buildBackfillHistory({
    application: { status: 'Interview', createdAt: d('01'), updatedAt: d('09') },
    before: d('09'),
  });
  assert.deepEqual(steps(gap), ['∅>Applied@backfill:created', 'Applied>Interview@backfill:updated_at~']);
  assert.equal(gap.approximate, true);
});

test('backfill: rejected with no offer and no log → approximate final entry at updatedAt', async () => {
  const h = await load(makeModel({}).model);
  const r = h.buildBackfillHistory({
    application: { status: 'Rejected', createdAt: d('01'), updatedAt: d('12') },
    meetings: [{ createdAt: d('03') }],
  });
  assert.deepEqual(steps(r), [
    '∅>Applied@backfill:created',
    'Applied>Interview@backfill:meeting',
    'Interview>Rejected@backfill:updated_at~',
  ]);
  assert.equal(r.approximate, true);
  assert.deepEqual(r.statusChangedAt, d('12'));
});

test('backfill: current status not reachable from records → approximate, never before the last event', async () => {
  const h = await load(makeModel({}).model);
  const r = h.buildBackfillHistory({
    application: { status: 'Screening', createdAt: d('05'), updatedAt: d('02') },
  });
  assert.deepEqual(steps(r), ['∅>Applied@backfill:created', 'Applied>Screening@backfill:updated_at~']);
  assert.deepEqual(r.statusHistory[1].at, d('05'));
});

test('backfill: duplicates collapsed (system log + meeting both say Interview)', async () => {
  const h = await load(makeModel({}).model);
  const r = h.buildBackfillHistory({
    application: { status: 'Interview', createdAt: d('01'), updatedAt: d('04') },
    activityLogs: [log('Applied', 'Interview', d('03'))],
    meetings: [{ createdAt: d('03') }],
  });
  assert.deepEqual(steps(r), ['∅>Applied@backfill:created', 'Applied>Interview@backfill:activity_log']);
});

test('backfill: application created at Applied with nothing else → single created entry', async () => {
  const h = await load(makeModel({}).model);
  const r = h.buildBackfillHistory({ application: { status: 'Applied', createdAt: d('01'), updatedAt: d('09') } });
  assert.deepEqual(steps(r), ['∅>Applied@backfill:created']);
  assert.deepEqual(r.statusChangedAt, d('01'));
});

// ─── Undo selection / needs-backfill selection ──────────────────────────────────────────────

test('undo: only histories made entirely by the backfill are selected', async () => {
  const h = await load(makeModel({}).model);
  assert.equal(h.isBackfillOnlyHistory([{ source: 'backfill:created' }, { source: 'backfill:updated_at' }]), true);
  assert.equal(h.isBackfillOnlyHistory([{ source: 'backfill:created' }, { source: 'manual' }]), false);
  assert.equal(h.isBackfillOnlyHistory([{ source: 'created' }]), false);
  assert.equal(h.isBackfillOnlyHistory([]), false);
  assert.equal(h.isBackfillOnlyHistory(undefined), false);
  const f = h.BACKFILL_UNDO_FILTER;
  assert.deepEqual(f['statusHistory.0'], { $exists: true });
  assert.ok(f.statusHistory.$not.$elemMatch.source.$not.test('manual') === false);
  assert.ok(f.statusHistory.$not.$elemMatch.source.$not.test('backfill:meeting'));
});

test('needs-backfill filter: missing/null or empty history only', async () => {
  const h = await load(makeModel({}).model);
  assert.deepEqual(h.NEEDS_BACKFILL_FILTER, { $or: [{ statusHistory: null }, { statusHistory: { $size: 0 } }] });
});
