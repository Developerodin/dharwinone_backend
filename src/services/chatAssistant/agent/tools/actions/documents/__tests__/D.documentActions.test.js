import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import requestDocuments from '../requestDocuments.tool.js';
import remindPendingDocuments from '../remindPendingDocuments.tool.js';
import { checkAccessRule } from '../../../../../toolAccess.js';
import { STALE_MESSAGE, checkPrepared } from '../../../../sageActions.js';

// Every model, the service, notify / notifyByEmail and the audit writer are fakes injected through
// ctx.deps: nothing here reaches Mongo, mail or the notification service.

const NOW = new Date('2026-09-30T12:00:00.000Z');
const perms = (...p) => ({ authContext: { permissions: new Set(p) } });
const MANAGER = { id: 'u-mgr', name: 'Asha Rao', ...perms('candidates.manage') };

let profiles;
let users;
let visibleIds;
let sageRows;
let deps;

const query = (rows) => {
  const q = {
    select: () => q,
    limit: (n) => { rows = rows.slice(0, n); return q; },
    lean: async () => structuredClone(rows),
  };
  return q;
};
const one = (row) => ({ select: () => ({ lean: async () => (row ? structuredClone(row) : null) }) });

function matchesPerson(row, m) {
  if (m._id) return row._id === m._id;
  return m.$or.some((c) => {
    if (c.fullName) return new RegExp(c.fullName.$regex, c.fullName.$options).test(row.fullName || '');
    if (c.email) return c.email.test(row.email || '');
    if (c.employeeId) return c.employeeId.test(row.employeeId || '');
    return false;
  });
}

const FakeEmployee = {
  find: mock.fn((filter) => {
    if (filter.owner?.$in) return query(profiles.filter((p) => filter.owner.$in.includes(p.owner)));
    // Every person lookup must carry the page scope as the first $and clause.
    assert.ok(Array.isArray(filter.$and), 'person lookup must be scoped');
    const [scope, person] = filter.$and;
    return query(profiles.filter((p) => scope._id.$in.includes(p._id) && matchesPerson(p, person)));
  }),
  findById: mock.fn((id) => one(profiles.find((p) => p._id === id))),
};
const FakeUser = {
  findById: (id) => one(users.find((u) => u._id === id)),
  findOne: ({ email }) => one(users.find((u) => u.email === email)),
  find: ({ _id }) => query(users.filter((u) => _id.$in.includes(u._id))),
};
const FakeSageAction = {
  findOne: mock.fn((f) => one(sageRows.find((r) =>
    r.tool === f.tool && r.status === f.status && r.summary.targets.some((t) => t.id === f['summary.targets.id'])
    && r.confirmedAt >= f.confirmedAt.$gte))),
};

beforeEach(() => {
  profiles = [
    { _id: 'p1', fullName: 'Priya Sharma', email: 'priya@x.com', owner: 'u-priya', employeeId: 'E-1',
      documentRequests: [{ label: 'Aadhar card', type: 'Aadhar', status: 'pending' }, { label: 'Old', status: 'fulfilled' }] },
    // Public-apply profiles owned by a recruiter: Ravi has his own login, Meera has none.
    { _id: 'p2', fullName: 'Ravi Kumar', email: 'ravi@x.com', owner: 'u-rec',
      documentRequests: [{ label: 'PAN card', type: 'PAN', status: 'pending' }] },
    { _id: 'p3', fullName: 'Meera Nair', email: 'meera@x.com', owner: 'u-rec',
      documentRequests: [{ label: 'Passport', type: 'Passport', status: 'pending' }] },
    { _id: 'p4', fullName: 'Hidden Person', email: 'hidden@x.com', owner: 'u-hidden', documentRequests: [] },
    { _id: 'p5', fullName: 'Arjun Mehta', email: 'arjun1@x.com', owner: 'u-a1', documentRequests: [] },
    { _id: 'p6', fullName: 'Arjun Mehta', email: 'arjun2@x.com', owner: 'u-a2', documentRequests: [] },
    // The only profile a second recruiter owns: single ownership must not make it speak for the recruiter.
    { _id: 'p7', fullName: 'Sita Verma', email: 'sita@x.com', owner: 'u-rec2', documentRequests: [] },
  ];
  users = [
    { _id: 'u-priya', email: 'priya@x.com', status: 'active' },
    { _id: 'u-rec', email: 'recruiter@corp.com', status: 'active' },
    { _id: 'u-ravi', email: 'ravi@x.com', status: 'active' },
    { _id: 'u-hidden', email: 'hidden@x.com', status: 'active' },
    { _id: 'u-rec2', email: 'recruiter2@corp.com', status: 'active' },
  ];
  visibleIds = ['p1', 'p2', 'p3', 'p5', 'p6', 'p7'];
  sageRows = [];
  FakeEmployee.find.mock.resetCalls();
  FakeEmployee.findById.mock.resetCalls();
  FakeSageAction.findOne.mock.resetCalls();
  deps = {
    Employee: FakeEmployee,
    User: FakeUser,
    SageAction: FakeSageAction,
    applyEmployeeListScope: mock.fn(async (filter) => ({ ...filter })),
    buildEmployeeListMongoFilter: mock.fn(async () => ({ mongoFilter: { _id: { $in: visibleIds } } })),
    // Mirrors the real service's write so a replayed commit sees its own requests.
    requestDocumentFromCandidate: mock.fn(async (id, payload, user) => {
      const row = { ...payload, status: 'pending', requestedBy: user._id };
      profiles.find((p) => p._id === id).documentRequests.push(row);
      return row;
    }),
    notify: mock.fn(async () => ({ _id: 'n1' })),
    notifyByEmail: mock.fn(async () => ({ _id: 'n2' })),
    writeAtsAudit: mock.fn(async () => null),
    now: () => NOW,
  };
});

const ctxFor = (user = MANAGER) => ({ user, requestId: 'req-1', deps });
const draftOf = (tool, args, prepared) => ({ key: 'k1', tool: tool.name, args, summary: prepared.summary, payload: prepared.payload });
const validArgs = (tool, args) => {
  const { value, error } = tool.input.validate(args, { abortEarly: false });
  assert.equal(error, undefined);
  return value;
};

describe('request_documents', () => {
  it('drafts one request per document for a visible person, with the channel and message', async () => {
    const args = validArgs(requestDocuments, {
      person: 'Priya Sharma',
      documents: [{ label: 'Passport', type: 'Passport', notes: 'All pages' }, { label: 'PAN card', type: 'PAN' }],
    });
    const res = await requestDocuments.prepare(args, ctxFor());
    assert.equal(res.ok, true);
    assert.equal(res.summary.title, 'Request 2 documents from Priya Sharma');
    assert.deepEqual(res.summary.targets, [{ id: 'p1', name: 'Priya Sharma' }]);
    assert.equal(res.summary.targetCount, 1);
    assert.deepEqual(res.summary.lines, [
      'Request "Passport" (type Passport) from Priya Sharma, note: All pages',
      'Request "PAN card" (type PAN) from Priya Sharma',
      'Notify Priya Sharma: in-app notice and email to their DharwinOne login.',
      'Message: "Asha Rao asked you to upload: Passport, PAN card."',
    ]);
    assert.deepEqual(res.payload, { profileId: 'p1', documentIndexes: [0, 1], recipient: { channel: 'owner', userId: 'u-priya' } });
    assert.equal(checkPrepared(res, requestDocuments).ok, true);
    assert.equal(deps.requestDocumentFromCandidate.mock.callCount(), 0);
    assert.equal(deps.notify.mock.callCount(), 0);
  });

  it('skips a label that is already pending and says so', async () => {
    const args = validArgs(requestDocuments, {
      person: 'priya@x.com', documents: [{ label: 'aadhar card' }, { label: 'Passport' }],
    });
    const res = await requestDocuments.prepare(args, ctxFor());
    assert.equal(res.ok, true);
    assert.deepEqual(res.payload.documentIndexes, [1]);
    assert.ok(res.summary.lines.includes('Skip "aadhar card": already pending, not requested again.'));
  });

  it('refuses when every listed document is already pending', async () => {
    const res = await requestDocuments.prepare(
      validArgs(requestDocuments, { person: 'Priya Sharma', documents: [{ label: 'Aadhar card' }] }), ctxFor());
    assert.equal(res.ok, false);
    assert.match(res.error, /already pending for Priya Sharma/);
  });

  it('refuses a person outside the page scope by name only', async () => {
    const res = await requestDocuments.prepare(
      validArgs(requestDocuments, { person: 'Hidden Person', documents: [{ label: 'Passport' }] }), ctxFor());
    assert.deepEqual(res, { ok: false, error: 'No candidate or employee you can see matches "Hidden Person".' });
    // Out-of-scope by profile id is the same refusal, and the id is never read unscoped.
    const byId = await requestDocuments.prepare(
      validArgs(requestDocuments, { person: 'aaaaaaaaaaaaaaaaaaaaaaaa', documents: [{ label: 'Passport' }] }), ctxFor());
    assert.equal(byId.ok, false);
    assert.equal(FakeEmployee.findById.mock.callCount(), 0);
  });

  it('refuses an ambiguous name, listing only people in scope', async () => {
    const res = await requestDocuments.prepare(
      validArgs(requestDocuments, { person: 'Arjun Mehta', documents: [{ label: 'Passport' }] }), ctxFor());
    assert.equal(res.ok, false);
    assert.match(res.error, /More than one person matches "Arjun Mehta"/);
  });

  it('caps a draft at one person and ten documents', () => {
    const docs = Array.from({ length: 11 }, (_, i) => ({ label: `Doc ${i}` }));
    const { error } = requestDocuments.input.validate({ person: 'Priya Sharma', documents: docs });
    assert.ok(error);
    assert.equal(requestDocuments.maxTargets, 1);
  });

  it('still creates the requests when there is no way to notify the person, and says so', async () => {
    const args = validArgs(requestDocuments, { person: 'Meera Nair', documents: [{ label: 'Degree certificate' }] });
    const res = await requestDocuments.prepare(args, ctxFor());
    assert.equal(res.ok, true);
    assert.equal(res.payload.recipient, null);
    assert.ok(res.summary.lines.includes(
      'No way to notify Meera Nair: the profile has no active DharwinOne login of their own.'));
    assert.ok(res.summary.lines.includes('The requests are still created; tell them yourself.'));

    const out = await requestDocuments.commit(draftOf(requestDocuments, args, res), ctxFor());
    assert.equal(out.ok, true);
    assert.equal(deps.requestDocumentFromCandidate.mock.callCount(), 1);
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(deps.notifyByEmail.mock.callCount(), 0);
    assert.match(out.message, /No notice was sent/);
  });

  it('never notifies a recruiter who owns just one public-apply profile', async () => {
    const args = validArgs(requestDocuments, { person: 'Sita Verma', documents: [{ label: 'Passport' }] });
    const res = await requestDocuments.prepare(args, ctxFor());
    assert.equal(res.payload.recipient, null);
    await requestDocuments.commit(draftOf(requestDocuments, args, res), ctxFor());
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(deps.notifyByEmail.mock.callCount(), 0);
  });

  it('emails the person, never the recruiter who owns a public-apply profile', async () => {
    const args = validArgs(requestDocuments, { person: 'Ravi Kumar', documents: [{ label: 'Passport' }] });
    const res = await requestDocuments.prepare(args, ctxFor());
    assert.deepEqual(res.payload.recipient, { channel: 'email', userId: 'u-ravi' });
    await requestDocuments.commit(draftOf(requestDocuments, args, res), ctxFor());
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.equal(deps.notifyByEmail.mock.callCount(), 1);
    assert.equal(deps.notifyByEmail.mock.calls[0].arguments[0], 'ravi@x.com');
  });

  it('refuses employees.edit alone: the route lets it in, the controller does not', async () => {
    const editOnly = { id: 'u-ed', name: 'Ed', ...perms('employees.edit') };
    const res = await requestDocuments.prepare(
      validArgs(requestDocuments, { person: 'Priya Sharma', documents: [{ label: 'Passport' }] }), ctxFor(editOnly));
    assert.equal(res.ok, false);
    assert.match(res.error, /cannot request documents/);
    assert.equal(FakeEmployee.find.mock.callCount(), 0);
    const readOnly = await checkAccessRule(requestDocuments.access, { id: 'u-r', ...perms('candidates.read') });
    assert.equal(readOnly.ok, false);
  });

  it('commit calls the service with exactly the payload ids, then one notice and the route\'s audit rows', async () => {
    const args = validArgs(requestDocuments, {
      person: 'Priya Sharma',
      documents: [{ label: 'Aadhar card' }, { label: 'Passport', type: 'Passport', notes: 'All pages' }, { label: 'PAN card', type: 'PAN' }],
    });
    const res = await requestDocuments.prepare(args, ctxFor());
    assert.deepEqual(res.payload.documentIndexes, [1, 2]);
    const out = await requestDocuments.commit(draftOf(requestDocuments, args, res), ctxFor());

    assert.equal(out.ok, true);
    const calls = deps.requestDocumentFromCandidate.mock.calls.map((c) => c.arguments);
    assert.deepEqual(calls, [
      ['p1', { label: 'Passport', type: 'Passport', notes: 'All pages' }, { _id: 'u-mgr', canManageCandidates: true }],
      ['p1', { label: 'PAN card', type: 'PAN', notes: undefined }, { _id: 'u-mgr', canManageCandidates: true }],
    ]);
    assert.equal(deps.notify.mock.callCount(), 1);
    const [userId, notice] = deps.notify.mock.calls[0].arguments;
    assert.equal(userId, 'u-priya');
    assert.equal(notice.type, 'onboarding_reminder');
    assert.equal(notice.message, 'Asha Rao asked you to upload: Passport, PAN card.');
    assert.equal(notice.link, '/ats/my-applications');
    assert.equal(notice.email.subject, 'Documents requested');
    assert.equal(deps.writeAtsAudit.mock.callCount(), 2);
    const [actorId, audit, req] = deps.writeAtsAudit.mock.calls[0].arguments;
    assert.equal(actorId, 'u-mgr');
    assert.deepEqual(audit, {
      action: 'employee.document.request', entityType: 'Employee', entityId: 'p1', metadata: { documentType: 'Passport' },
    });
    assert.equal(req.headers['x-audit-source'], 'ats/sage');
    assert.deepEqual(out.details, { profileId: 'p1', created: ['Passport', 'PAN card'], skipped: [], failed: 0, notified: true });
  });

  it('a replayed commit creates nothing and sends no second notice', async () => {
    const args = validArgs(requestDocuments, { person: 'Priya Sharma', documents: [{ label: 'Passport' }] });
    const res = await requestDocuments.prepare(args, ctxFor());
    const draft = draftOf(requestDocuments, args, res);
    await requestDocuments.commit(draft, ctxFor());
    const again = await requestDocuments.commit(draft, ctxFor());
    assert.equal(again.ok, true);
    assert.deepEqual(again.details.created, []);
    assert.deepEqual(again.details.skipped, ['Passport']);
    assert.equal(deps.requestDocumentFromCandidate.mock.callCount(), 1);
    assert.equal(deps.notify.mock.callCount(), 1);
  });

  it('confirm refuses when the draft no longer matches (a document became pending meanwhile)', async () => {
    const args = validArgs(requestDocuments, { person: 'Priya Sharma', documents: [{ label: 'Passport' }, { label: 'PAN card' }] });
    const res = await requestDocuments.prepare(args, ctxFor());
    profiles[0].documentRequests.push({ label: 'PAN card', status: 'pending' });
    const checked = await requestDocuments.recheck(draftOf(requestDocuments, args, res), ctxFor());
    assert.deepEqual(checked, { ok: false, error: STALE_MESSAGE });
  });
});

describe('remind_pending_documents', () => {
  it('drafts one reminder listing every pending request', async () => {
    const res = await remindPendingDocuments.prepare({ person: 'Priya Sharma' }, ctxFor());
    assert.equal(res.ok, true);
    assert.equal(res.summary.title, 'Remind Priya Sharma about 1 pending document');
    assert.deepEqual(res.summary.lines, [
      'Remind Priya Sharma about "Aadhar card".',
      'Notify Priya Sharma: in-app notice and email to their DharwinOne login.',
      'Message: "Asha Rao is reminding you to upload: Aadhar card."',
    ]);
    assert.deepEqual(res.payload, { profileId: 'p1', pendingIndexes: [0], recipient: { channel: 'owner', userId: 'u-priya' } });
    assert.equal(checkPrepared(res, remindPendingDocuments).ok, true);
    assert.equal(deps.notify.mock.callCount(), 0);
  });

  it('refuses when there is nothing pending', async () => {
    profiles[0].documentRequests = [{ label: 'Old', status: 'fulfilled' }];
    const res = await remindPendingDocuments.prepare({ person: 'Priya Sharma' }, ctxFor());
    assert.deepEqual(res, { ok: false, error: 'Priya Sharma has no pending document requests to remind them about.' });
  });

  it('refuses when a reminder for this profile was sent in the last 24 hours', async () => {
    sageRows.push({
      tool: 'remind_pending_documents', status: 'done', summary: { targets: [{ id: 'p1', name: 'Priya Sharma' }] },
      confirmedAt: new Date(NOW.getTime() - 3 * 60 * 60 * 1000),
    });
    const res = await remindPendingDocuments.prepare({ person: 'Priya Sharma' }, ctxFor());
    assert.equal(res.ok, false);
    assert.match(res.error, /already reminded .* last 24 hours/);
  });

  it('refuses when there is no way to notify the person', async () => {
    const res = await remindPendingDocuments.prepare({ person: 'Meera Nair' }, ctxFor());
    assert.deepEqual(res, { ok: false, error: 'No way to notify Meera Nair: the profile has no active DharwinOne login of their own.' });
  });

  it('refuses a person outside the page scope by name only', async () => {
    const res = await remindPendingDocuments.prepare({ person: 'Hidden Person' }, ctxFor());
    assert.deepEqual(res, { ok: false, error: 'No candidate or employee you can see matches "Hidden Person".' });
  });

  it('refuses a user without the request-documents permissions', async () => {
    const res = await remindPendingDocuments.prepare({ person: 'Priya Sharma' }, ctxFor({ id: 'u-x', ...perms('candidates.read') }));
    assert.equal(res.ok, false);
    assert.match(res.error, /cannot request documents/);
  });

  it('commit sends exactly one notice for the payload profile; a replay sends nothing', async () => {
    const res = await remindPendingDocuments.prepare({ person: 'Priya Sharma' }, ctxFor());
    const draft = draftOf(remindPendingDocuments, { person: 'Priya Sharma' }, res);
    const out = await remindPendingDocuments.commit(draft, ctxFor());
    assert.equal(out.ok, true);
    assert.equal(deps.notify.mock.callCount(), 1);
    const [userId, notice] = deps.notify.mock.calls[0].arguments;
    assert.equal(userId, 'u-priya');
    assert.equal(notice.type, 'onboarding_reminder');
    assert.equal(notice.message, 'Asha Rao is reminding you to upload: Aadhar card.');
    assert.equal(FakeEmployee.findById.mock.calls.at(-1).arguments[0], 'p1');

    // confirmAction marks the row done; a replay of the same draft then finds it and stops.
    sageRows.push({ tool: 'remind_pending_documents', status: 'done', summary: draft.summary, confirmedAt: NOW });
    const again = await remindPendingDocuments.commit(draft, ctxFor());
    assert.equal(again.ok, true);
    assert.equal(again.details.skipped, 'reminded_recently');
    assert.equal(deps.notify.mock.callCount(), 1);
  });

  it('reminds the person behind a recruiter-owned profile by their own email', async () => {
    const res = await remindPendingDocuments.prepare({ person: 'Ravi Kumar' }, ctxFor());
    await remindPendingDocuments.commit(draftOf(remindPendingDocuments, { person: 'Ravi Kumar' }, res), ctxFor());
    assert.equal(deps.notify.mock.callCount(), 0);
    assert.deepEqual(deps.notifyByEmail.mock.calls.map((c) => c.arguments[0]), ['ravi@x.com']);
  });
});
