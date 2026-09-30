/**
 * The Sage-only filter keys added to offer.service queryOffers and placement.service queryPlacements.
 * Model statics are stubbed (no Mongo); the viewer holds a pipeline permission and no roles, so visibility is
 * unrestricted without a Role lookup. Each existing caller's query is pinned too: the two list controllers
 * pick() only jobId/candidateId/createdBy/status/stage/search (offers) and jobId/candidateId/status/
 * preBoardingStatus/stage/search (placements), so the new keys never reach them.
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import Offer from '../../../../../../models/offer.model.js';
import Placement from '../../../../../../models/placement.model.js';
import Employee from '../../../../../../models/employee.model.js';
import { queryOffers } from '../../../../../offer.service.js';
import { queryPlacements } from '../../../../../placement.service.js';

const viewer = { id: '64b0000000000000000000aa', authContext: { permissions: new Set(['offers.read', 'pre-boarding.read']) } };
const EMPTY = { results: [], page: 1, limit: 10, totalPages: 0, totalResults: 0 };
const chain = (value) => {
  const c = { select: () => c, lean: async () => value };
  return c;
};

afterEach(() => mock.restoreAll());

describe('offer.service queryOffers — Sage filter keys', () => {
  const capture = () => {
    const seen = {};
    mock.method(Offer, 'paginate', async (q, o) => { seen.query = q; seen.options = o; return { ...EMPTY }; });
    return seen;
  };

  it('existing caller (Offers page list): the query for its keys is unchanged and no placement lookup runs', async () => {
    const seen = capture();
    const distinct = mock.method(Placement, 'distinct', async () => assert.fail('no placement lookup'));
    await queryOffers({ status: 'Sent,Under Negotiation', createdBy: '64b0000000000000000000bb' }, { limit: 10 }, viewer);
    assert.deepEqual(Object.keys(seen.query).sort(), ['createdBy', 'status']);
    assert.deepEqual(seen.query.status, { $in: ['Sent', 'Under Negotiation'] });
    assert.equal(distinct.mock.callCount(), 0);
  });

  it('sentBefore → sentAt $lt that instant; sentAtMissing → sentAt null', async () => {
    const seen = capture();
    await queryOffers({ status: 'Sent', sentBefore: '2026-09-22T18:30:00.000Z' }, { limit: 1 }, viewer);
    assert.deepEqual(seen.query.sentAt, { $lt: new Date('2026-09-22T18:30:00.000Z') });
    await queryOffers({ status: 'Sent', sentAtMissing: true }, { limit: 1 }, viewer);
    assert.equal(seen.query.sentAt, null);
    assert.ok(Object.prototype.hasOwnProperty.call(seen.query, 'sentAt'));
  });

  it('placementStatus / placementPreBoardingStatus → offers whose placement matches, ANDed with the rest', async () => {
    const seen = capture();
    let placementQuery;
    mock.method(Placement, 'distinct', async (field, q) => { placementQuery = { field, q }; return ['o1', 'o2']; });
    await queryOffers(
      { status: 'Accepted', placementStatus: 'Pending', placementPreBoardingStatus: 'Pending' }, { limit: 1 }, viewer,
    );
    assert.deepEqual(placementQuery, { field: 'offer', q: { status: 'Pending', preBoardingStatus: 'Pending' } });
    assert.equal(seen.query.status, 'Accepted');
    assert.deepEqual(seen.query.$and, [{ _id: { $in: ['o1', 'o2'] } }]);
  });

  it('no placement matches → the empty page, without querying offers', async () => {
    mock.method(Offer, 'paginate', async () => assert.fail('must not query offers'));
    mock.method(Placement, 'distinct', async () => []);
    const res = await queryOffers({ placementStatus: 'Pending' }, { limit: 1 }, viewer);
    assert.equal(res.totalResults, 0);
  });
});

describe('placement.service queryPlacements — Sage filter keys', () => {
  const capture = ({ employees = [{ _id: 'c1', fullName: 'Meera', email: 'm@x.com' }] } = {}) => {
    const seen = {};
    mock.method(Placement, 'distinct', async () => ['c1']);
    mock.method(Employee, 'find', (q) => { seen.employeeQuery = q; return chain(employees); });
    mock.method(Placement, 'paginate', async (q) => { seen.query = q; return { ...EMPTY }; });
    return seen;
  };

  it('existing caller (Pre-boarding / Onboarding pages): query and candidate check unchanged', async () => {
    const seen = capture();
    await queryPlacements({ status: 'Pending', preBoardingStatus: 'Pending' }, { limit: 10 }, viewer);
    assert.deepEqual(seen.employeeQuery, { _id: { $in: ['c1'] } });
    assert.deepEqual(Object.keys(seen.query).sort(), ['candidate', 'preBoardingStatus', 'status']);
  });

  it('bgvStatus: comma list, and Pending also matches an unset status', async () => {
    const seen = capture();
    await queryPlacements({ status: 'Pending', bgvStatus: 'Pending,In Progress' }, { limit: 1 }, viewer);
    assert.deepEqual(seen.query['backgroundVerification.status'], { $in: ['Pending', 'In Progress', null] });
    await queryPlacements({ status: 'Pending', bgvStatus: 'Verified' }, { limit: 1 }, viewer);
    assert.deepEqual(seen.query['backgroundVerification.status'], { $in: ['Verified'] });
  });

  it('bgvNotRequested → no requestedAt on record', async () => {
    const seen = capture();
    await queryPlacements({ status: 'Pending', bgvNotRequested: true }, { limit: 1 }, viewer);
    assert.equal(seen.query['backgroundVerification.requestedAt'], null);
    assert.ok(Object.prototype.hasOwnProperty.call(seen.query, 'backgroundVerification.requestedAt'));
  });

  it('candidateMatch is ANDed into the existing candidate check; nobody matching → empty page', async () => {
    const match = { 'documents.0': { $exists: true } };
    const seen = capture();
    await queryPlacements({ status: 'Pending', candidateMatch: match }, { limit: 1 }, viewer);
    assert.deepEqual(seen.employeeQuery, { $and: [{ _id: { $in: ['c1'] } }, match] });
    assert.deepEqual(seen.query.candidate, { $in: ['c1'] });

    capture({ employees: [] });
    mock.method(Placement, 'paginate', async () => assert.fail('must not page'));
    const res = await queryPlacements({ status: 'Pending', candidateMatch: match }, { limit: 1 }, viewer);
    assert.equal(res.totalResults, 0);
  });
});
