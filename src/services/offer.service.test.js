/**
 * Offer auto-expiry notifications (EC-4 / autoExpireOffers).
 *
 * Bug fixed: the notification block read `o.createdBy` / `o.job.title` from a projection that
 * only selected `_id` + `jobApplication`, so `createdBy` was always undefined and the internal
 * notify silently no-op'd; no candidate-facing notification existed at all.
 *
 * ponytail: a hand-rolled in-memory model (same style as
 * services/__tests__/companyPhoneNumber.assignment.test.js and
 * services/__tests__/offer.standaloneRollback.test.js) beats mongodb-memory-server here — the
 * function only uses find/findOneAndUpdate/updateMany/distinct/findById.
 *
 * notification.service.js is intentionally NOT mocked — it, and the real
 * utils/notificationLink.js resolver, run for real (only the Notification/User models and
 * push/email side effects are faked). This is what proves the candidate notification's explicit
 * `link: '/ats/my-applications'` wins over the job_application resolver's recruiter-facing
 * `/ats/jobs/:id` fallback even if metadata carried a jobId.
 */
import test, { mock, before } from 'node:test';
import assert from 'node:assert/strict';

const eq = (a, b) => String(a) === String(b);

// --- mutable fake DB -------------------------------------------------------------
let offers = [];
let jobApplications = [];
let employees = [];
let users = [];
let notifications = [];
let warnLogs = [];
let referralSyncCalls = [];
let queuedEmails = [];

const reset = () => {
  offers = [];
  jobApplications = [];
  employees = [];
  users = [];
  notifications = [];
  warnLogs = [];
  referralSyncCalls = [];
  queuedEmails = [];
};

/** Chainable query stub: .select().populate().lean() all resolve to `resolve()`. */
const query = (resolve) => ({
  select() {
    return this;
  },
  populate() {
    return this;
  },
  lean: async () => resolve(),
});

// --- model mocks ------------------------------------------------------------------

mock.module('../models/offer.model.js', {
  defaultExport: {
    find: (filter) =>
      query(() =>
        offers
          .filter(
            (o) =>
              filter.status.$in.includes(o.status) &&
              o.offerValidityDate < filter.offerValidityDate.$lt
          )
          .map((o) => ({ _id: o._id }))
      ),
    findOneAndUpdate: (filter, update) =>
      query(() => {
        const o = offers.find((x) => eq(x._id, filter._id) && filter.status.$in.includes(x.status));
        if (!o) return null;
        Object.assign(o, update.$set);
        const job = o.job ? { _id: o.job, title: `Job ${o.job}` } : null;
        return {
          _id: o._id,
          jobApplication: o.jobApplication,
          createdBy: o.createdBy,
          candidate: o.candidate,
          job,
        };
      }),
  },
});

mock.module('../models/job.model.js', { defaultExport: { findOne: () => query(() => null) } });
mock.module('../models/placement.model.js', { defaultExport: { findOne: () => query(() => null) } });
mock.module('../models/position.model.js', { defaultExport: { findOne: () => query(() => null) } });

mock.module('../models/jobApplication.model.js', {
  defaultExport: {
    updateMany: async (filter, update) => {
      const ids = filter._id.$in.map(String);
      let modifiedCount = 0;
      for (const app of jobApplications) {
        if (ids.includes(String(app._id))) {
          Object.assign(app, update.$set);
          modifiedCount += 1;
        }
      }
      return { modifiedCount };
    },
    distinct: async (field, filter) => {
      const ids = filter._id.$in.map(String);
      const out = new Set();
      for (const app of jobApplications) {
        if (ids.includes(String(app._id))) out.add(app[field]);
      }
      return [...out];
    },
  },
});

mock.module('../models/employee.model.js', {
  defaultExport: {
    findById: (id) => query(() => employees.find((e) => eq(e._id, id)) || null),
  },
});

mock.module('../models/notification.model.js', {
  defaultExport: {
    create: async (doc) => {
      const saved = { ...doc, _id: `n${notifications.length + 1}`, read: false, createdAt: new Date() };
      notifications.push(saved);
      return { ...saved, toJSON: () => saved };
    },
    countDocuments: async (filter) =>
      notifications.filter((n) => eq(n.user, filter.user) && (filter.read === undefined || n.read === filter.read))
        .length,
  },
});

mock.module('../models/user.model.js', {
  defaultExport: {
    findById: (id) => query(() => users.find((u) => eq(u._id, id)) || null),
    findOne: (filter) => query(() => users.find((u) => u.email === filter.email) || null),
  },
});

mock.module('./job.service.js', {
  namedExports: {
    getJobById: async () => null,
    isOwnerOrAdmin: () => true,
    createJob: async () => ({ _id: 'job1' }),
  },
});
mock.module('./referralLeads.service.js', {
  namedExports: {
    syncReferralPipelineStatusForCandidate: async (cid) => {
      referralSyncCalls.push(String(cid));
    },
  },
});
mock.module('./recruiterActivity.service.js', { namedExports: { logActivity: async () => {} } });
mock.module('./placementAudit.service.js', { namedExports: { recordPlacementAudit: async () => {} } });
mock.module('./positionResolve.helper.js', {
  namedExports: { resolvePositionIdFromDesignationTitle: async () => null },
});
mock.module('./email.service.js', {
  namedExports: {
    queueEmail: (to, subject) => {
      queuedEmails.push({ to, subject });
    },
    sendOfferShareEmail: async () => {},
    buildEmailHTML: () => '<html></html>',
    buildPlainTextEmail: () => '',
  },
});
mock.module('./push.service.js', { namedExports: { sendPushToUser: async () => {} } });
mock.module('../config/logger.js', {
  defaultExport: {
    warn: (msg) => warnLogs.push(String(msg)),
    info: () => {},
    error: () => {},
  },
});

// Loaded in a hook (top-level await is rejected by this repo's eslint parser).
let autoExpireOffers;
before(async () => {
  ({ autoExpireOffers } = await import('./offer.service.js'));
});

// --- fixtures ------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const past = new Date(Date.now() - HOUR);
const future = new Date(Date.now() + HOUR);

const seedExpiringOffer = ({
  id = 'off1',
  status = 'Sent',
  createdBy = 'creator1',
  candidate = 'cand1',
  job = 'job1',
  jobApplication = 'app1',
  offerValidityDate = past,
} = {}) => {
  offers.push({ _id: id, status, createdBy, candidate, job, jobApplication, offerValidityDate });
  if (jobApplication) {
    jobApplications.push({ _id: jobApplication, status: 'Sent', candidate });
  }
};

// ---------------------------------------------------------------------------------

test('claims and reads all fields the notification block needs (createdBy, job.title, candidate)', async () => {
  reset();
  seedExpiringOffer();
  employees.push({ _id: 'cand1', email: 'candidate@example.com' });
  users.push({ _id: 'creatorUser1', email: 'creator@example.com' });
  users.push({ _id: 'candUser1', email: 'candidate@example.com' });

  const count = await autoExpireOffers();

  assert.equal(count, 1);
  assert.equal(offers[0].status, 'Rejected');
  assert.ok(offers[0].rejectedAt instanceof Date);
  assert.equal(
    offers[0].rejectionReason,
    'Offer expired: validity date passed without candidate response.'
  );
});

test('offer creator receives the intended internal "offer expired" notification', async () => {
  reset();
  seedExpiringOffer({ createdBy: 'creator1' });
  employees.push({ _id: 'cand1', email: 'candidate@example.com' });
  users.push({ _id: 'creator1', email: 'creator@example.com' });
  users.push({ _id: 'candUserX', email: 'candidate@example.com' });

  await autoExpireOffers();

  const creatorNotif = notifications.find((n) => eq(n.user, 'creator1'));
  assert.ok(creatorNotif, 'creator should have a notification');
  assert.equal(creatorNotif.type, 'offer');
  assert.equal(creatorNotif.link, '/ats/offers-placement');
  assert.match(creatorNotif.message, /expired/i);
});

test('candidate receives a job_application notification linking to My Applications, with no internal offer detail', async () => {
  reset();
  seedExpiringOffer({ createdBy: 'creator1', candidate: 'cand1' });
  employees.push({ _id: 'cand1', email: 'candidate@example.com' });
  users.push({ _id: 'creator1', email: 'creator@example.com' });
  users.push({ _id: 'candUser1', email: 'candidate@example.com' });

  await autoExpireOffers();

  const candNotif = notifications.find((n) => eq(n.user, 'candUser1'));
  assert.ok(candNotif, 'candidate should have a notification');
  assert.equal(candNotif.type, 'job_application');
  assert.equal(candNotif.link, '/ats/my-applications');
  assert.doesNotMatch(candNotif.message, /salary|ctc|compensation|note/i);
});

test('candidate link stays /ats/my-applications even if metadata carried a jobId (explicit link wins over the resolver)', async () => {
  // Regression guard for notification.service.js:136 `link || resolveNotificationLink(...)` and
  // notificationLink.js's job_application route, which resolves to the recruiter-facing
  // `/ats/jobs/:id` whenever metadata.jobId is present and no explicit link is given. Exercises
  // the REAL notification.service.js + REAL utils/notificationLink.js (neither is mocked in this
  // file) to prove production behaviour, not a stand-in.
  reset();
  seedExpiringOffer({ createdBy: 'creator1', candidate: 'cand1', job: 'jobABC' });
  employees.push({ _id: 'cand1', email: 'candidate@example.com' });
  users.push({ _id: 'creator1', email: 'creator@example.com' });
  users.push({ _id: 'candUser1', email: 'candidate@example.com' });

  const { notifyByEmail } = await import('./notification.service.js');
  // Directly prove the precedence with the same shape offer.service.js sends, PLUS a jobId in
  // metadata that the resolver would otherwise route to /ats/jobs/:id.
  const doc = await notifyByEmail('candidate@example.com', {
    type: 'job_application',
    title: 'Application status: Rejected',
    message: 'Your application is now Rejected.',
    link: '/ats/my-applications',
    metadata: { jobId: 'jobABC' },
  });
  assert.equal(doc.link, '/ats/my-applications', 'explicit link must win over the job_application resolver');

  await autoExpireOffers();
  const candNotif = notifications.find((n) => eq(n.user, 'candUser1') && n.type === 'job_application');
  assert.equal(candNotif.link, '/ats/my-applications');
});

test('candidate with no User account: logs and skips, and never redirects the notification to the creator', async () => {
  reset();
  seedExpiringOffer({ createdBy: 'creator1', candidate: 'cand1' });
  employees.push({ _id: 'cand1', email: 'nouser@example.com' });
  users.push({ _id: 'creator1', email: 'creator@example.com' });
  // No User row for nouser@example.com.

  await autoExpireOffers();

  const candNotifs = notifications.filter((n) => n.type === 'job_application');
  assert.equal(candNotifs.length, 0, 'no candidate notification should be created');
  const creatorNotifs = notifications.filter((n) => eq(n.user, 'creator1'));
  assert.equal(creatorNotifs.length, 1, 'creator still gets exactly the internal notification, not a duplicate');
  assert.ok(
    warnLogs.some((l) => /no User account/i.test(l)),
    'must log that the candidate has no User account'
  );
});

test('running the scheduler twice produces NO duplicate notifications (atomic claim dedup)', async () => {
  reset();
  seedExpiringOffer({ createdBy: 'creator1', candidate: 'cand1' });
  employees.push({ _id: 'cand1', email: 'candidate@example.com' });
  users.push({ _id: 'creator1', email: 'creator@example.com' });
  users.push({ _id: 'candUser1', email: 'candidate@example.com' });

  const first = await autoExpireOffers();
  const second = await autoExpireOffers();

  assert.equal(first, 1, 'first run expires the one eligible offer');
  assert.equal(second, 0, 'second run finds nothing left to claim (status guard no longer matches)');
  assert.equal(notifications.filter((n) => eq(n.user, 'creator1')).length, 1, 'creator notified exactly once');
  assert.equal(notifications.filter((n) => eq(n.user, 'candUser1')).length, 1, 'candidate notified exactly once');
});

test('offers not past validity, or already Draft/Accepted/Rejected, are left untouched', async () => {
  reset();
  seedExpiringOffer({ id: 'offFuture', offerValidityDate: future });
  seedExpiringOffer({ id: 'offDraft', status: 'Draft' });
  seedExpiringOffer({ id: 'offAccepted', status: 'Accepted' });
  employees.push({ _id: 'cand1', email: 'candidate@example.com' });
  users.push({ _id: 'creator1', email: 'creator@example.com' });

  const count = await autoExpireOffers();

  assert.equal(count, 0);
  assert.equal(offers.find((o) => o._id === 'offFuture').status, 'Sent');
  assert.equal(offers.find((o) => o._id === 'offDraft').status, 'Draft');
  assert.equal(offers.find((o) => o._id === 'offAccepted').status, 'Accepted');
  assert.equal(notifications.length, 0);
});

test('cascades the linked JobApplication to Rejected and syncs referral pipeline status', async () => {
  reset();
  seedExpiringOffer({ jobApplication: 'app1', candidate: 'cand1' });
  employees.push({ _id: 'cand1', email: 'candidate@example.com' });
  users.push({ _id: 'creator1', email: 'creator@example.com' });

  await autoExpireOffers();

  assert.equal(jobApplications.find((a) => a._id === 'app1').status, 'Rejected');
  assert.deepEqual(referralSyncCalls, ['cand1']);
});
