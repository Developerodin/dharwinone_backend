/**
 * Regression test for the "new application received" notification bug.
 *
 * Root cause: the recruiter-notify block in publicApplyToJobService (job.service.js)
 * called notify(job.createdBy, { type: 'application', ... }). The Notification schema's
 * `type` enum does not include 'application' (it includes 'job_application'), so
 * Notification.create() threw a ValidationError inside createNotification(). The
 * surrounding try/catch in job.service.js swallowed that error and only logged a
 * warning, so the job owner silently got neither the in-app notification nor the email.
 *
 * Fix: use type: 'job_application' (a real enum value, already wired up in
 * NOTIFICATION_PREF_KEYS and isChannelAllowed for both channels).
 *
 * These tests mock every collaborator EXCEPT the real Notification model, so the
 * schema-validation assertions run against the actual mongoose schema.
 */
import test, { mock, before } from 'node:test';
import assert from 'node:assert/strict';

const OWNER_ID = '507f1f77bcf86cd799439011';

const fakeJob = {
  _id: 'job1',
  status: 'Active',
  title: 'Senior Engineer',
  createdBy: OWNER_ID,
  jobOrigin: 'internal',
  populate: async function populate() {
    return this;
  },
};

/** Captures every notify() call made by job.service.js so tests can inspect what was sent. */
let notifyCalls = [];

mock.module('../../models/job.model.js', {
  defaultExport: {
    findById: () => ({ exec: async () => fakeJob }),
  },
});
mock.module('../../models/jobTemplate.model.js', { defaultExport: {} });
mock.module('../../models/externalJob.model.js', { defaultExport: {} });

mock.module('../../models/employee.model.js', {
  defaultExport: {
    findOne: async () => null, // no existing candidate for this email
    create: async (data) => ({ _id: 'cand1', ...data }),
  },
});

mock.module('../../models/user.model.js', {
  defaultExport: {
    findOne: () => ({ select: () => ({ lean: async () => null }) }), // no existing account
    create: async (data) => ({ _id: 'user1', ...data }),
  },
});

mock.module('../../models/jobApplication.model.js', {
  defaultExport: {
    create: async (data) => ({
      _id: 'app1',
      ...data,
      populate: async function populate() {
        this.job = { title: fakeJob.title };
        return this;
      },
    }),
  },
});

mock.module('../role.service.js', {
  namedExports: {
    getRoleByName: async (name) => ({ _id: 'roleCandidate', name }),
  },
});

mock.module('../token.service.js', {
  namedExports: {
    generateVerifyEmailToken: async () => 'fake-verify-token',
  },
});

mock.module('../email.service.js', {
  namedExports: {
    sendVerificationEmail: async () => {},
  },
});

mock.module('../referralLeads.service.js', {
  namedExports: {
    syncReferralPipelineStatusForCandidate: async () => {},
  },
});

mock.module('../notification.service.js', {
  namedExports: {
    // Synchronous body so the call is recorded before publicApplyToJobService's
    // fire-and-forget notify(...).catch(() => {}) has a chance to matter.
    notify: (userId, options) => {
      notifyCalls.push({ userId, options });
      return Promise.resolve({ _id: 'notif1', user: userId, ...options });
    },
    plainTextEmailBody: (message, link) => `${message}\n${link}`,
  },
});

let jobService;
let Notification;
before(async () => {
  jobService = await import('../job.service.js');
  Notification = (await import('../../models/notification.model.js')).default;
});

const applicationData = {
  fullName: 'Jane Candidate',
  email: 'jane.candidate@example.com',
  password: 'Passw0rd!',
  coverLetter: 'I would love to join.',
  // phoneNumber/countryCode intentionally omitted so the Bolna verification-call
  // branch (job.jobOrigin !== 'external' && phoneNumber && countryCode) is skipped.
};

test('public candidate application creates a notification with type job_application, addressed to the job owner', async () => {
  notifyCalls = [];
  const result = await jobService.publicApplyToJobService('job1', applicationData, {});

  assert.equal(result.application.id, 'app1');
  assert.equal(notifyCalls.length, 1, 'exactly one notify() call for the new application');

  const call = notifyCalls[0];
  assert.equal(call.userId, OWNER_ID, 'notification recipient must be the job owner (job.createdBy)');
  assert.equal(call.options.type, 'job_application', 'must use the real enum value, not the old broken "application"');
  assert.notEqual(call.options.type, 'application', 'the old broken type string must never be used');
});

test('the notify() payload validates against the real Notification mongoose schema', async () => {
  notifyCalls = [];
  await jobService.publicApplyToJobService('job1', applicationData, {});
  const { options } = notifyCalls[0];

  const doc = new Notification({
    user: OWNER_ID,
    type: options.type,
    title: options.title,
    message: options.message,
    link: options.link,
  });

  const validationError = doc.validateSync();
  assert.equal(validationError, undefined, `expected no validation error, got: ${validationError}`);
  assert.equal(doc.type, 'job_application');
});

test('sanity check: the old buggy type value fails real schema validation (this is why it was silently dropped)', () => {
  const badDoc = new Notification({
    user: OWNER_ID,
    type: 'application',
    title: 'New job application',
    message: 'Someone applied.',
  });
  const validationError = badDoc.validateSync();
  assert.ok(validationError, 'type: "application" is not in the enum and must fail validation');
  assert.match(String(validationError), /type/i);
});

test('no notification with type "application" is ever produced across multiple applications', async () => {
  notifyCalls = [];
  await jobService.publicApplyToJobService('job1', applicationData, {});
  await jobService.publicApplyToJobService('job1', { ...applicationData, email: 'second@example.com' }, {});

  assert.equal(notifyCalls.length, 2);
  for (const call of notifyCalls) {
    assert.notEqual(call.options.type, 'application');
    assert.equal(call.options.type, 'job_application');
  }
});
