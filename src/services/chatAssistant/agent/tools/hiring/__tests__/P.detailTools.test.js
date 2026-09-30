import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import getOffer from '../getOffer.tool.js';
import listOffers from '../listOffers.tool.js';
import countOffers from '../countOffers.tool.js';
import getPlacement from '../getPlacement.tool.js';
import listPlacements from '../listPlacements.tool.js';
import countPlacements from '../countPlacements.tool.js';
import listDocuments from '../listDocuments.tool.js';
import { PAPERWORK_COMPLETE_MATCH, offerDaysPending } from '../placementDetail.js';
import { checkAccessRule } from '../../../../toolAccess.js';

const NOW = new Date('2026-09-30T06:00:00.000Z'); // 11:30 IST on 2026-09-30
const viewer = (...perms) => ({
  id: 'v1', _id: 'v1', email: 'viewer@x.com', authContext: { permissions: new Set(perms) },
});
/** Fake Mongoose model: every query is .select()/.limit()/.sort()/.lean()-chainable and resolves to the handler's value. */
const chain = (value) => {
  const c = { select: () => c, limit: () => c, sort: () => c, lean: async () => value };
  return c;
};
// No sent-by log on record unless a test says so (the real model would wait on Mongo).
const NO_LOGS = { findOne: () => chain(null) };
const ctxWith = (deps, user = viewer('offers.read')) => ({
  user, requestId: 'r', deps: { now: () => NOW, RecruiterActivityLog: NO_LOGS, ...deps },
});
const paged = (totalResults, results = []) => ({ totalResults, results, page: 1, totalPages: 1 });
const forbidden = () => Object.assign(new Error('Forbidden'), { statusCode: 403 });
const model = ({ find, findById, findOne } = {}) => ({
  find: (q) => chain(find ? find(q) : []),
  findById: (id) => chain(findById ? findById(id) : null),
  findOne: (q) => chain(findOne ? findOne(q) : null),
});

const ALL_TOOLS = [getOffer, listOffers, countOffers, getPlacement, listPlacements, countPlacements, listDocuments];

describe('P tools — access and fail closed', () => {
  for (const tool of ALL_TOOLS) {
    it(`${tool.name} refuses to run without a user id`, async () => {
      await assert.rejects(() => tool.execute({ candidate: 'x', person: 'x' }, { user: {}, deps: {} }), /authenticated user/);
    });
    it(`${tool.name} is hidden from a viewer with no hiring/document permission`, async () => {
      assert.equal((await checkAccessRule(tool.access, viewer('jobs.read'))).ok, false);
    });
  }
  it('documents follow the employee documents route, not the offers route', async () => {
    assert.equal((await checkAccessRule(listDocuments.access, viewer('pre-boarding.read'))).ok, true);
    assert.equal((await checkAccessRule(listDocuments.access, viewer('offers.read'))).ok, false);
  });
});

// ─── get_offer ──────────────────────────────────────────────────────────────

const offerDoc = {
  _id: 'o1', offerCode: 'OFF-2026-0012', status: 'Sent', candidate: { fullName: 'Ravi Kumar' },
  job: { title: 'QA Engineer' }, positionTitle: 'QA Lead', createdBy: { name: 'Asha' },
  createdAt: '2026-09-18T05:00:00.000Z', sentAt: '2026-09-20T10:00:00.000Z', joiningDate: '2026-10-15T00:00:00.000Z',
  ctcBreakdown: { base: 50000, hra: 10000, gross: 70000, currency: 'INR' }, compensationType: 'paid',
  offerLetterUrl: undefined, offerLetterGeneratedAt: '2026-09-19T00:00:00.000Z', letterVersionSeq: 2,
  rejectionReason: 'x',
};

describe('get_offer', () => {
  it('searches through the Offers page service with the viewer (row scope) and returns the detail', async () => {
    let seen;
    const out = await getOffer.execute(
      { candidate: 'Ravi' },
      ctxWith({ queryOffers: async (f, o, u) => { seen = { f, o, u }; return paged(1, [offerDoc]); } }),
    );
    assert.equal(seen.u.id, 'v1');
    assert.equal(seen.f.search, 'Ravi');
    assert.equal(out.preparedBy, 'Asha');
    assert.equal(out.position, 'QA Lead');
    assert.equal(out.daysPending, 10); // IST 2026-09-20 → 2026-09-30
  });

  it('hides compensation from a read-only viewer — no CTC field at all (the GET /offers/:id leak)', async () => {
    const out = await getOffer.execute({ offerCode: 'OFF-2026-0012' }, ctxWith({ queryOffers: async () => paged(1, [offerDoc]) }));
    assert.equal(out.compensationHidden, true);
    assert.doesNotMatch(JSON.stringify(out), /70000|50000|gross|ctc|rejectionReason/i);
  });

  it('shows compensation to a viewer who can edit offers', async () => {
    const out = await getOffer.execute(
      { offerCode: 'OFF-2026-0012' },
      ctxWith({ queryOffers: async () => paged(1, [offerDoc]) }, viewer('offers.edit')),
    );
    assert.equal(out.compensation.gross, 70000);
    assert.equal(out.compensationHidden, undefined);
  });

  it('names who marked it Sent (the offer_sent activity) and when; letter delivery stays not captured', async () => {
    let q;
    const logs = {
      findOne: (query) => { q = query; return chain({ recruiter: 'u-asha', createdAt: '2026-09-20T10:00:00.000Z' }); },
    };
    const out = await getOffer.execute({ candidate: 'Ravi' }, ctxWith({
      queryOffers: async () => paged(1, [offerDoc]),
      RecruiterActivityLog: logs,
      User: model({ findById: (id) => (id === 'u-asha' ? { name: 'Asha' } : null) }),
    }));
    assert.equal(q.activityType, 'offer_sent');
    assert.deepEqual(q['metadata.offerId'], { $in: ['o1'] });
    assert.equal(out.markedSentBy, 'Asha');
    assert.equal(out.markedSentAt, '2026-09-20T10:00:00.000Z');
    assert.match(out.delivery, /Outlook/);
    assert.match(out.delivery, /not captured in DharwinOne/);
    assert.equal(out.markedSentByNote, undefined);
    assert.equal(out.letter.pdfUrl, null);
    assert.equal(out.letter.savedVersions, 2);
  });

  it('says who marked it Sent is not on record for an older offer, instead of guessing', async () => {
    const out = await getOffer.execute({ candidate: 'Ravi' }, ctxWith({ queryOffers: async () => paged(1, [offerDoc]) }));
    assert.equal(out.markedSentBy, null);
    assert.match(out.markedSentByNote, /not captured in DharwinOne/);
  });

  it('bug: finds who marked it Sent even when sentAt is empty (only Draft → Sent stamps sentAt); skips Drafts', async () => {
    const logs = { findOne: () => chain({ recruiter: 'u-asha', createdAt: '2026-05-10T14:24:43.287Z' }) };
    const users = model({ findById: () => ({ name: 'Asha' }) });
    const accepted = { ...offerDoc, status: 'Accepted', sentAt: undefined };
    const out = await getOffer.execute({ candidate: 'Ravi' }, ctxWith({
      queryOffers: async () => paged(1, [accepted]), RecruiterActivityLog: logs, User: users,
    }));
    assert.equal(out.markedSentBy, 'Asha');
    const draft = await getOffer.execute({ candidate: 'Ravi' }, ctxWith({
      queryOffers: async () => paged(1, [{ ...offerDoc, status: 'Draft', sentAt: undefined }]),
      RecruiterActivityLog: { findOne: () => assert.fail('a Draft was never sent') },
    }));
    assert.equal(draft.markedSentBy, null);
    assert.equal(draft.markedSentByNote, undefined);
  });

  it('matches the offer_sent log by ObjectId as well as by string id', async () => {
    let q;
    const id = '64b000000000000000000001';
    await getOffer.execute({ candidate: 'Ravi' }, ctxWith({
      queryOffers: async () => paged(1, [{ ...offerDoc, _id: id }]),
      RecruiterActivityLog: { findOne: (query) => { q = query; return chain(null); } },
    }));
    const [asString, asObjectId] = q['metadata.offerId'].$in;
    assert.equal(asString, id);
    assert.equal(String(asObjectId), id);
    assert.notEqual(typeof asObjectId, 'string');
  });

  it('bug: never hands a stored letter PDF link (it prints the CTC) to a viewer who cannot see compensation', async () => {
    const withPdf = { ...offerDoc, offerLetterUrl: 'https://s3.example/offer-letter.pdf' };
    const hidden = await getOffer.execute({ candidate: 'Ravi' }, ctxWith({ queryOffers: async () => paged(1, [withPdf]) }));
    assert.equal(hidden.letter.pdfUrl, null);
    assert.doesNotMatch(JSON.stringify(hidden), /s3\.example/);
    assert.match(hidden.letter.pdfNote, /compensation/);
    const shown = await getOffer.execute(
      { candidate: 'Ravi' },
      ctxWith({ queryOffers: async () => paged(1, [withPdf]) }, viewer('offers.edit')),
    );
    assert.equal(shown.letter.pdfUrl, 'https://s3.example/offer-letter.pdf');
  });

  it('opens an id through getOfferById with the viewer and turns a 403 into an error', async () => {
    let user;
    const out = await getOffer.execute(
      { id: '64b000000000000000000001' },
      ctxWith({ getOfferById: async (_id, u) => { user = u; throw forbidden(); } }),
    );
    assert.equal(user.id, 'v1');
    assert.match(out.error, /do not have access/);
  });

  it('bug: by id, preparedAt survives (reads the document with toObject — the toJSON plugin drops createdAt)', async () => {
    const doc = {
      toObject: () => ({ ...offerDoc, _id: '64b000000000000000000001' }),
      toJSON: () => ({ ...offerDoc, _id: undefined, createdAt: undefined, id: '64b000000000000000000001' }),
    };
    const out = await getOffer.execute({ id: '64b000000000000000000001' }, ctxWith({ getOfferById: async () => doc }));
    assert.equal(out.preparedAt, offerDoc.createdAt);
    assert.equal(out.id, '64b000000000000000000001');
  });

  it('asks which one when a name fits several offers, and is notFound on none', async () => {
    const two = [offerDoc, { ...offerDoc, _id: 'o2', offerCode: 'OFF-2026-0013', candidate: { fullName: 'Ravi Shah' } }];
    const many = await getOffer.execute({ candidate: 'Ravi' }, ctxWith({ queryOffers: async () => paged(2, two) }));
    assert.equal(many.matches.length, 2);
    const none = await getOffer.execute({ candidate: 'Nobody' }, ctxWith({ queryOffers: async () => paged(0) }));
    assert.equal(none.notFound, 'offer');
  });
});

// ─── list_offers / count_offers ─────────────────────────────────────────────

describe('list_offers / count_offers — pendingOverDays, acceptedNoPreboarding', () => {
  // N = 7 on IST 2026-09-30 → sent before the first instant of IST 2026-09-23.
  const CUTOFF_7 = '2026-09-22T18:30:00.000Z';

  it('pendingOverDays is a service filter (sentBefore) on still-pending offers — no row scan', async () => {
    const seen = [];
    const out = await listOffers.execute(
      { filters: { pendingOverDays: 7 }, page: 2, limit: 20 },
      ctxWith({
        queryOffers: async (f, o, u) => {
          seen.push({ f, o, u });
          if (f.sentAtMissing) return paged(4);
          return { ...paged(812, [{ ...offerDoc, sentAt: '2026-09-10T10:00:00.000Z' }]), page: 2, totalPages: 41 };
        },
      }),
    );
    const main = seen.find((s) => !s.f.sentAtMissing);
    assert.equal(main.f.status, 'Sent,Under Negotiation');
    assert.equal(main.f.sentBefore, CUTOFF_7);
    assert.deepEqual({ page: main.o.page, limit: main.o.limit }, { page: 2, limit: 20 });
    assert.ok(seen.every((s) => s.u.id === 'v1'));
    assert.equal(out.total, 812); // the service's own count, not a page or scan slice
    assert.equal(out.scanTruncated, undefined);
    assert.equal(out.records[0].daysPending, 20);
    assert.equal(out.sentDateMissing, 4);
  });

  it('the sentBefore cutoff agrees with daysPending at the IST day boundary', () => {
    const justIn = { status: 'Sent', sentAt: '2026-09-22T18:29:59.000Z' }; // 23:59:59 IST on 09-22
    const justOut = { status: 'Sent', sentAt: '2026-09-22T18:30:00.000Z' }; // 00:00 IST on 09-23
    assert.equal(offerDaysPending(justIn, NOW), 8); // > 7 and before the cutoff
    assert.equal(offerDaysPending(justOut, NOW), 7); // not > 7 and not before the cutoff
    assert.ok(justIn.sentAt < CUTOFF_7 && !(justOut.sentAt < CUTOFF_7));
  });

  it('counts exactly through the service and splits by the pending statuses only', async () => {
    const out = await countOffers.execute(
      { filters: { pendingOverDays: 2 } },
      ctxWith({
        queryOffers: async (f) => {
          if (f.sentAtMissing) return paged(0);
          return paged({ Sent: 3, 'Under Negotiation': 1 }[f.status] ?? 4);
        },
      }),
    );
    assert.equal(out.total, 4);
    assert.deepEqual(out.byStatus, { Sent: 3, 'Under Negotiation': 1 });
    assert.equal(out.sentDateMissing, undefined);
  });

  it('acceptedNoPreboarding asks the service for accepted offers whose placement is Pending / pre-boarding Pending', async () => {
    const seen = [];
    const out = await countOffers.execute(
      { filters: { acceptedNoPreboarding: true } },
      ctxWith({ queryOffers: async (f) => { seen.push(f); return paged(6); } }),
    );
    assert.ok(seen.every((f) => f.status === 'Accepted' && f.stage === 'preBoarding'
      && f.placementStatus === 'Pending' && f.placementPreBoardingStatus === 'Pending'));
    assert.equal(out.total, 6);
    assert.deepEqual(out.byStatus, { Accepted: 6 });
  });

  it('answers 0 without a query when the filters contradict each other', async () => {
    const out = await countOffers.execute(
      { filters: { pendingOverDays: 3, status: 'Accepted' } },
      ctxWith({ queryOffers: async () => assert.fail('must not query') }),
    );
    assert.equal(out.total, 0);
  });

  it('without the new filters, list/count send the page filter unchanged', async () => {
    const seen = [];
    await listOffers.execute(
      { filters: { status: 'Sent', search: 'Ravi' }, page: 1, limit: 20 },
      ctxWith({ queryOffers: async (f) => { seen.push(f); return paged(0); } }),
    );
    assert.deepEqual(seen[0], { search: 'Ravi', status: 'Sent' });
  });
});

// ─── list_placements / count_placements ─────────────────────────────────────

const placementRowDoc = (id, status, bgv, extra = {}) => ({
  _id: id, status, candidate: { _id: `c-${id}`, fullName: `Person ${id}` }, job: { title: 'QA' },
  backgroundVerification: bgv, joiningDate: '2026-09-20T00:00:00.000Z', ...extra,
});

describe('list_placements / count_placements — new filters', () => {
  it('joinDatePassedNotOnboarded = Pending/Onboarding with joining before the IST day, via the service', async () => {
    const seen = [];
    const out = await countPlacements.execute(
      { filters: { joinDatePassedNotOnboarded: true } },
      ctxWith({ queryPlacements: async (f, o, u) => { seen.push({ f, u }); return paged(f.status === 'Pending' ? 2 : 3); } }),
    );
    assert.equal(seen[0].f.status, 'Pending,Onboarding');
    assert.equal(seen[0].f.joiningTo, '2026-09-29T18:29:59.999Z'); // last ms before IST midnight of 09-30
    assert.ok(seen.every((s) => s.u.id === 'v1'));
    assert.deepEqual(Object.keys(out.byStatus), ['Pending', 'Onboarding']);
  });

  it('narrows a stage queue to its one matching status', async () => {
    let filter;
    await listPlacements.execute(
      { filters: { stage: 'onboarding', joinDatePassedNotOnboarded: true }, page: 1, limit: 20 },
      ctxWith({ queryPlacements: async (f) => { filter = f; return paged(0); } }),
    );
    assert.equal(filter.stage, 'onboarding');
    assert.equal(filter.status, 'Onboarding');
  });

  it('bgvPending is a service filter (BGV Pending / In Progress) on active placements, total exact', async () => {
    let seen;
    const out = await listPlacements.execute(
      { filters: { bgvPending: true }, page: 1, limit: 20 },
      ctxWith({
        queryPlacements: async (f, o, u) => {
          seen = { f, o, u };
          return paged(640, [placementRowDoc('1', 'Pending', { status: 'Pending' })]);
        },
      }),
    );
    assert.equal(seen.f.status, 'Pending,Onboarding');
    assert.equal(seen.f.bgvStatus, 'Pending,In Progress');
    assert.equal(seen.o.limit, 20);
    assert.equal(seen.u.id, 'v1');
    assert.equal(out.total, 640);
    assert.equal(out.scanTruncated, undefined);
  });

  it('readyForBgv = BGV Pending, never requested, paperwork complete on the profile — all in the service query', async () => {
    const seen = [];
    const out = await countPlacements.execute(
      { filters: { readyForBgv: true, bgvPending: true } },
      ctxWith({
        queryPlacements: async (f) => { seen.push(f); return paged(f.status === 'Pending' ? 2 : 3); },
        Employee: { find: () => assert.fail('no profile scan in the tool') },
      }),
    );
    for (const f of seen) {
      assert.equal(f.bgvStatus, 'Pending');
      assert.equal(f.bgvNotRequested, true);
      assert.equal(f.candidateMatch, PAPERWORK_COMPLETE_MATCH);
    }
    assert.equal(out.total, 3);
    assert.deepEqual(out.byStatus, { Pending: 2, Onboarding: 3 });
  });

  it('the paperwork match is: ≥1 document, none pending review (or unset) / rejected, no open request', () => {
    assert.deepEqual(PAPERWORK_COMPLETE_MATCH, {
      'documents.0': { $exists: true },
      documents: { $not: { $elemMatch: { status: { $in: [0, 2, null] } } } },
      documentRequests: { $not: { $elemMatch: { status: 'pending' } } },
    });
  });

  it('without the new filters, the page filter goes to the service unchanged', async () => {
    let filter;
    await listPlacements.execute(
      { filters: { stage: 'preBoarding' }, page: 1, limit: 20 },
      ctxWith({ queryPlacements: async (f) => { filter = f; return paged(0); } }),
    );
    assert.deepEqual(filter, { stage: 'preBoarding' });
  });
});

// ─── get_placement ──────────────────────────────────────────────────────────

const placementDoc = {
  _id: '64b000000000000000000010', status: 'Pending', preBoardingStatus: 'Pending',
  candidate: { _id: 'c1', fullName: 'Meera Nair', department: 'QA', designation: 'Tester', email: 'meera@x.com' },
  job: { title: 'QA' }, offer: { offerCode: 'OFF-1', status: 'Accepted', acceptedAt: '2026-09-01T00:00:00.000Z' },
  joiningDate: '2026-10-05T00:00:00.000Z', backgroundVerification: { status: 'Pending', notes: 'secret' },
  preBoardingTasks: [], onboardingTasks: [],
};

describe('get_placement', () => {
  const baseDeps = (over = {}) => ({
    getPlacementById: async () => placementDoc,
    Employee: model({ findById: () => ({ _id: 'c1', assignedAgent: 'a1', email: 'meera@x.com' }) }),
    User: model({ findById: () => ({ name: 'Agent Neha' }), findOne: () => ({ _id: 'u9', roleIds: ['r1'] }) }),
    userHasEmployeeRole: async () => true,
    ...over,
  });

  it('opens the placement through getPlacementById with the viewer and returns steps + first blocker', async () => {
    let user;
    const out = await getPlacement.execute(
      { id: placementDoc._id },
      ctxWith(baseDeps({ getPlacementById: async (_id, u) => { user = u; return placementDoc; } }), viewer('pre-boarding.read')),
    );
    assert.equal(user.id, 'v1');
    assert.equal(out.department, 'QA');
    assert.equal(out.agentAssigned, 'Agent Neha');
    assert.equal(out.holdsEmployeeRole, true);
    assert.equal(out.firstBlockingStep.step, 'Background verification');
    assert.deepEqual(out.steps.map((s) => s.step).slice(0, 3), ['Offer accepted', 'Pre-boarding', 'Background verification']);
    assert.doesNotMatch(JSON.stringify(out), /secret/);
  });

  it('names the first open required checklist step as the blocker', async () => {
    const p = {
      ...placementDoc,
      preBoardingTasks: [
        { title: 'Sign NDA', required: true, done: true, order: 0 },
        { title: 'Upload ID', required: true, done: false, order: 1 },
      ],
    };
    const out = await getPlacement.execute({ id: p._id }, ctxWith(baseDeps({ getPlacementById: async () => p })));
    assert.equal(out.firstBlockingStep.step, 'Pre-boarding');
    assert.match(out.firstBlockingStep.detail, /Upload ID/);
  });

  it('flags an Onboarding placement whose joining date has passed', async () => {
    const p = { ...placementDoc, status: 'Onboarding', joiningDate: '2026-09-25T00:00:00.000Z' };
    const out = await getPlacement.execute({ id: p._id }, ctxWith(baseDeps({ getPlacementById: async () => p })));
    assert.equal(out.firstBlockingStep.step, 'Mark as Joined');
  });

  it('bug: a joining date stored at IST midnight (18:30Z the day before) is not "passed" on the joining day', async () => {
    const p = { ...placementDoc, status: 'Onboarding', joiningDate: '2026-09-29T18:30:00.000Z' }; // = 2026-09-30 IST
    const out = await getPlacement.execute({ id: p._id }, ctxWith(baseDeps({ getPlacementById: async () => p })));
    assert.equal(out.firstBlockingStep, null);
  });

  it('adds the audit trail only for viewers with placement audit access, through the audit service', async () => {
    let call;
    const rows = [{
      action: 'PLACEMENT_STATUS_CHANGED', fromValue: 'Pending', toValue: 'Onboarding',
      actor: { name: 'Asha', email: 'asha@x.com' }, createdAt: '2026-09-25T10:00:00.000Z', details: { offerId: 'o1' },
    }];
    const audit = async (id, u) => { call = { id, u }; return rows; };
    const out = await getPlacement.execute(
      { id: placementDoc._id },
      ctxWith(baseDeps({ listAuditForPlacementId: audit }), viewer('pre-boarding.read', 'placement.audit')),
    );
    assert.equal(call.id, placementDoc._id);
    assert.equal(call.u.id, 'v1');
    assert.deepEqual(out.auditTrail, [
      { action: 'PLACEMENT_STATUS_CHANGED', from: 'Pending', to: 'Onboarding', by: 'Asha', at: '2026-09-25T10:00:00.000Z' },
    ]);
    assert.doesNotMatch(JSON.stringify(out), /asha@x\.com/);

    const without = await getPlacement.execute(
      { id: placementDoc._id },
      ctxWith(baseDeps({ listAuditForPlacementId: async () => assert.fail('must not read the audit') }), viewer('pre-boarding.read')),
    );
    assert.equal(without.auditTrail, undefined);
  });

  it('leaves the audit trail out when the audit service refuses the row', async () => {
    const out = await getPlacement.execute(
      { id: placementDoc._id },
      ctxWith(baseDeps({ listAuditForPlacementId: async () => { throw forbidden(); } }), viewer('candidates.manage')),
    );
    assert.equal(out.auditTrail, undefined);
    assert.equal(out.candidate, 'Meera Nair');
  });

  it('returns null, not a guess, for no agent and no login account', async () => {
    const out = await getPlacement.execute(
      { id: placementDoc._id },
      ctxWith(baseDeps({
        Employee: model({ findById: () => ({ _id: 'c1', email: 'meera@x.com' }) }),
        User: model({ findOne: () => null }),
      })),
    );
    assert.equal(out.agentAssigned, null);
    assert.equal(out.holdsEmployeeRole, null);
    assert.match(out.employeeRoleNote, /not captured in DharwinOne/);
  });

  it('turns a 403 from the service into an error', async () => {
    const out = await getPlacement.execute(
      { id: placementDoc._id },
      ctxWith(baseDeps({ getPlacementById: async () => { throw forbidden(); } })),
    );
    assert.match(out.error, /do not have access/);
  });

  it('resolves a name through the placement list (row scope) and asks when it fits several people', async () => {
    let seen;
    const out = await getPlacement.execute(
      { candidate: 'Meera' },
      ctxWith(baseDeps({
        queryPlacements: async (f, o, u) => {
          seen = { f, u };
          return paged(2, [placementRowDoc('1', 'Pending', {}), placementRowDoc('2', 'Joined', {})]);
        },
      })),
    );
    assert.equal(seen.u.id, 'v1');
    assert.match(seen.f.status, /Cancelled/);
    assert.equal(out.matches.length, 2);
  });
});

// ─── list_documents ─────────────────────────────────────────────────────────

const profile = {
  _id: 'c1', fullName: 'Meera Nair', email: 'meera@x.com', owner: 'recruiter-1', employeeId: null,
  eadValidTo: '2026-10-10T00:00:00.000Z',
  documents: [
    { type: 'CV/Resume', label: 'Resume', status: 1, verifiedBy: 'u-rev', verifiedAt: '2026-09-02', logicalSlot: 'resume', slotVersion: 2, url: 'https://s3/r.pdf', key: 'k1' },
    { type: 'Visa', label: 'Visa copy', status: 2, verifiedBy: 'u-rev', adminNotes: 'Blurry scan', url: 'https://s3/v.pdf' },
    { type: 'Bank Proof', label: 'Bank proof', status: 0 },
  ],
  documentRequests: [
    { type: 'W-4', label: 'W-4 form', status: 'pending', requestedBy: 'u-rev', requestedAt: '2026-09-05' },
    { type: 'Other', label: 'Old', status: 'fulfilled' },
  ],
  documentVersions: [{ slot: 'resume', version: 2, createdBy: 'u-staff' }],
  salarySlips: [{ month: 'Aug', documentUrl: 'https://s3/slip.pdf' }],
  salaryRange: '10-20',
};
const names = [{ _id: 'u-rev', name: 'Reviewer Ria' }, { _id: 'u-staff', name: 'Agent Neha' }];

describe('list_documents', () => {
  const docDeps = (over = {}) => ({
    Employee: model({ find: () => [profile], findOne: () => profile }),
    User: model({ find: () => names, findOne: () => ({ _id: 'u-meera' }) }),
    ...over,
  });

  it('shows one person\'s documents: status, reviewer, reason, uploader, missing, expiry', async () => {
    const out = await listDocuments.execute(
      { person: 'Meera Nair', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps(), viewer('pre-boarding.read')),
    );
    assert.deepEqual(out.counts, { uploaded: 3, pendingReview: 1, approved: 1, rejected: 1, missing: 1 });
    const [resume, visa, bank] = out.documents;
    assert.equal(resume.reviewedBy, 'Reviewer Ria');
    assert.equal(resume.uploadedBy, 'Agent Neha');
    assert.equal(resume.uploadedByStaff, true);
    assert.equal(visa.reason, 'Blurry scan');
    assert.equal(bank.status, 'pending_review');
    assert.deepEqual(out.missing.map((m) => m.label), ['W-4 form']);
    assert.equal(out.expiries[0].document, 'EAD card');
    assert.equal(out.expiries[0].daysLeft, 10);
    assert.equal(out.expiries[0].expiringSoon, true);
  });

  it('leaves the uploader null where DharwinOne does not record one, and never returns files or salary', async () => {
    const out = await listDocuments.execute(
      { person: 'Meera Nair', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps(), viewer('candidates.manage')),
    );
    assert.equal(out.documents[1].uploadedBy, null);
    assert.equal(out.documents[1].uploadedByStaff, null);
    assert.match(out.uploaderNote, /not captured in DharwinOne/);
    assert.doesNotMatch(JSON.stringify(out), /s3|salary|slip|10-20/i);
  });

  it('refuses someone else\'s documents to a viewer without the documents gate', async () => {
    const out = await listDocuments.execute(
      { person: 'Meera Nair', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps(), viewer('candidates.read')),
    );
    assert.match(out.error, /only see your own documents/);
  });

  it('bug: a viewer without the documents gate cannot enumerate people by name (no matches / notFound)', async () => {
    const two = [profile, { ...profile, _id: 'c9', fullName: 'Meera Shah', employeeId: 'DBS9' }];
    const many = await listDocuments.execute(
      { person: 'Meera', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({ Employee: model({ find: () => two }) }), viewer('candidates.read')),
    );
    assert.match(many.error, /only see your own documents/);
    assert.doesNotMatch(JSON.stringify(many), /Meera|DBS9/);
    const none = await listDocuments.execute(
      { person: 'Zed', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({ Employee: model({ find: () => [] }) }), viewer('candidates.read')),
    );
    assert.match(none.error, /only see your own documents/);
  });

  it('a profile owner without the documents gate still sees that profile by name (REST isOwnerOrAdmin)', async () => {
    const owned = { ...profile, owner: 'v1' };
    const out = await listDocuments.execute(
      { person: 'Meera Nair', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({ Employee: model({ find: () => [owned] }) }), viewer('candidates.read')),
    );
    assert.equal(out.name, 'Meera Nair');
  });

  it('lets any document reader see their own profile', async () => {
    const mine = { ...profile, email: 'viewer@x.com' };
    const out = await listDocuments.execute(
      { expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({ Employee: model({ findOne: () => mine }) }), viewer('candidates.read')),
    );
    assert.equal(out.name, 'Meera Nair');
  });

  it('cohort reads the placement pages with the viewer and keeps people with missing documents', async () => {
    let seen;
    const complete = { _id: 'c2', fullName: 'Done Person', documents: [{ status: 1 }], documentRequests: [] };
    const out = await listDocuments.execute(
      { cohort: { stage: 'preBoarding' }, onlyWith: 'missing', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({
        queryPlacements: async (f, o, u) => {
          seen = { f, u };
          return paged(2, [{ candidate: { _id: 'c1' } }, { candidate: { _id: 'c2' } }]);
        },
        Employee: model({ find: () => [profile, complete] }),
      }), viewer('pre-boarding.read')),
    );
    assert.equal(seen.u.id, 'v1');
    assert.equal(seen.f.stage, 'preBoarding');
    assert.equal(out.total, 1);
    assert.equal(out.records[0].name, 'Meera Nair');
    assert.deepEqual(out.records[0].missing, ['W-4 form']);
  });

  it('refuses a cohort to a viewer who may only see their own documents', async () => {
    const out = await listDocuments.execute(
      { cohort: {}, expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({ queryPlacements: async () => assert.fail('must not query') }), viewer('employees.read')),
    );
    assert.match(out.error, /only see your own documents/);
  });

  it('reports an unknown person as notFound and several as matches', async () => {
    const none = await listDocuments.execute(
      { person: 'Zed', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({ Employee: model({ find: () => [] }) }), viewer('pre-boarding.read')),
    );
    assert.equal(none.notFound, 'person');
    const two = await listDocuments.execute(
      { person: 'Meera', expiringWithinDays: 30, limit: 20 },
      ctxWith(docDeps({ Employee: model({ find: () => [profile, { ...profile, _id: 'c9', fullName: 'Meera Shah' }] }) }), viewer('pre-boarding.read')),
    );
    assert.equal(two.matches.length, 2);
  });
});
