import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  employmentStatusClause,
  employmentMetricClause,
  compensationTypeClause,
  buildEmployeeEmploymentFilter,
} from '../employeeEmploymentFilter.js';

const TODAY = new Date(Date.UTC(2026, 7, 7, 12, 0, 0));
const FROM = new Date(Date.UTC(2026, 6, 1)); // July 1
const TO = new Date(Date.UTC(2026, 6, 31, 23, 59, 59, 999)); // July 31 EOD

describe('employeeEmploymentFilter', () => {
  it('scopes resigned employment status by resignDate <= today', () => {
    assert.deepEqual(employmentStatusClause('resigned', TODAY), {
      resignDate: { $ne: null, $lte: TODAY },
    });
  });

  it('builds an inclusive resign window on resignDate', () => {
    const c = employmentMetricClause('resign', { from: FROM, to: TO }, TODAY);
    assert.equal(c.resignDate.$ne, null);
    assert.equal(c.resignDate.$gte, FROM);
    assert.equal(c.resignDate.$lte, TO);
  });

  it('builds an inclusive join window on joiningDate', () => {
    const c = employmentMetricClause('join', { from: FROM, to: TO }, TODAY);
    assert.equal(c.joiningDate.$ne, null);
    assert.equal(c.joiningDate.$gte, FROM);
    assert.equal(c.joiningDate.$lte, TO);
  });

  it('only accepts paid/unpaid compensation filters', () => {
    assert.deepEqual(compensationTypeClause('paid'), { compensationType: 'paid' });
    assert.deepEqual(compensationTypeClause('unpaid'), { compensationType: 'unpaid' });
    assert.deepEqual(compensationTypeClause('freelance'), {});
  });

  it('composes owner + resign metric + paid for Employee-role analytics', () => {
    const owners = ['o1', 'o2'];
    const filter = buildEmployeeEmploymentFilter({
      ownerIds: owners,
      metric: 'resign',
      window: { from: FROM, to: TO },
      compensationType: 'paid',
      today: TODAY,
    });
    assert.ok(filter.$and);
    assert.deepEqual(filter.$and[0], { owner: { $in: owners } });
    assert.equal(filter.$and[1].resignDate.$gte, FROM);
    assert.deepEqual(filter.$and[2], { compensationType: 'paid' });
  });

  it('reuses employmentStatus when no metric is set (fetch_employees path)', () => {
    const filter = buildEmployeeEmploymentFilter({
      ownerIds: ['o1'],
      employmentStatus: 'active',
      today: TODAY,
    });
    assert.ok(filter.$and || filter.owner);
    const flat = filter.$and || [filter];
    assert.ok(flat.some((p) => p.owner));
    assert.ok(flat.some((p) => p.$or));
  });
});
