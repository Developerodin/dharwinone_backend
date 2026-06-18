import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLifecycleOverlay,
  bucketByEffectiveStatus,
  rankSalesAgentHires,
  deriveReferralPipelineStatus,
  pipelineStatusToLifecycleStage,
} from '../referralPipelineStatus.js';

describe('deriveReferralPipelineStatus', () => {
  const now = new Date('2026-06-15T12:00:00Z');

  it('maps application Applied to applied', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        apps: [{ status: 'Applied', updatedAt: now }],
      }),
      'applied'
    );
  });

  it('maps pending interview to interview', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        apps: [{ status: 'Interview', updatedAt: now }],
        meetings: [{ status: 'ended', interviewResult: 'pending' }],
      }),
      'interview'
    );
  });

  it('maps interview rejection to rejected', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        apps: [{ status: 'Applied', updatedAt: now }],
        meetings: [{ status: 'ended', interviewResult: 'rejected' }],
      }),
      'rejected'
    );
  });

  it('maps selected interview to offer (no offer entity yet)', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        apps: [{ status: 'Interview', updatedAt: now }],
        meetings: [{ status: 'ended', interviewResult: 'selected' }],
      }),
      'offer'
    );
  });

  it('pending interview outranks a selected one', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        apps: [{ status: 'Interview', updatedAt: now }],
        meetings: [
          { status: 'ended', interviewResult: 'selected' },
          { status: 'ended', interviewResult: 'pending' },
        ],
      }),
      'interview'
    );
  });

  it('maps open offer to offer', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        apps: [{ status: 'Offered', updatedAt: now }],
        offers: [{ status: 'Sent', updatedAt: now }],
      }),
      'offer'
    );
  });

  it('maps accepted offer to preboarding', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        offers: [{ status: 'Accepted', updatedAt: now }],
        placements: [{ status: 'Pending', updatedAt: now }],
      }),
      'preboarding'
    );
  });

  it('maps placement Onboarding to hired (onboarding phase)', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        placements: [{ status: 'Onboarding', updatedAt: now }],
        offers: [{ status: 'Accepted', updatedAt: now }],
      }),
      'hired'
    );
  });

  it('maps placement Joined to joined', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        placements: [{ status: 'Joined', updatedAt: now }],
      }),
      'joined'
    );
  });

  it('maps placement Cancelled to rejected', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        placements: [{ status: 'Cancelled', updatedAt: now }],
      }),
      'rejected'
    );
  });

  it('maps placement Deferred to deferred', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        placements: [{ status: 'Deferred', updatedAt: now }],
      }),
      'deferred'
    );
  });

  it('maps active employee post join date to employee', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        employee: { joiningDate: '2026-01-01', isActive: true },
        placements: [{ status: 'Joined', updatedAt: now }],
      }),
      'employee'
    );
  });

  it('maps inactive post join to resigned', () => {
    assert.equal(
      deriveReferralPipelineStatus({
        employee: { joiningDate: '2026-01-01', isActive: false },
      }),
      'resigned'
    );
  });

  it('overlay: passed joiningDate + active overrides stored status to employee', () => {
    assert.equal(
      applyLifecycleOverlay('hired', { joiningDate: '2026-01-01', isActive: true }, now),
      'employee'
    );
  });

  it('overlay: passed joiningDate + inactive overrides to resigned', () => {
    assert.equal(
      applyLifecycleOverlay('hired', { joiningDate: '2026-01-01', isActive: false }, now),
      'resigned'
    );
  });

  it('overlay: past joiningDate is authoritative over any stored status (onboard-invite employee)', () => {
    // No ATS rows, stored 'pending', but a passed joiningDate means they joined.
    assert.equal(
      applyLifecycleOverlay('pending', { joiningDate: '2026-01-01', isActive: true }, now),
      'employee'
    );
    assert.equal(
      applyLifecycleOverlay('pending', { joiningDate: '2026-01-01', isActive: false }, now),
      'resigned'
    );
  });

  it('overlay: future joiningDate does not override stored status', () => {
    assert.equal(
      applyLifecycleOverlay('preboarding', { joiningDate: '2026-12-01', isActive: true }, now),
      'preboarding'
    );
  });

  it('overlay: normalizes legacy in_review to interview', () => {
    assert.equal(applyLifecycleOverlay('in_review', {}, now), 'interview');
  });

  it('bucketByEffectiveStatus counts by overlay status, so cards agree with rows', () => {
    const rows = [
      // stored pending but joined+inactive → must count as resigned, NOT pending (Dhruv case)
      { referralPipelineStatus: 'pending', joiningDate: '2026-01-01', isActive: false },
      // stored hired but joined+active → counts as employee
      { referralPipelineStatus: 'hired', joiningDate: '2026-01-01', isActive: true },
      // genuine pending, no join date → stays pending
      { referralPipelineStatus: 'pending' },
      // future join date → stored status stands
      { referralPipelineStatus: 'offer', joiningDate: '2026-12-01', isActive: true },
    ];
    const m = bucketByEffectiveStatus(rows, now);
    assert.equal(m.resigned, 1);
    assert.equal(m.employee, 1);
    assert.equal(m.pending, 1);
    assert.equal(m.offer, 1);
    assert.equal(m.hired, undefined);
  });

  it('rankSalesAgentHires counts effective hires (overlay), dedupes per agent', () => {
    const ranked = rankSalesAgentHires(
      [
        // agent A: two distinct hired candidates (one stored hired+joined→employee, one stored joined)
        { agent: 'A', cand: 'c1', status: 'hired', joiningDate: '2026-01-01', isActive: true },
        { agent: 'A', cand: 'c2', status: 'joined', joiningDate: '2026-12-01', isActive: true },
        // same candidate counted once for agent A
        { agent: 'A', cand: 'c1', status: 'hired', joiningDate: '2026-01-01', isActive: true },
        // agent B: stored employee but RESIGNED (joined+inactive) → not a current hire, excluded
        { agent: 'B', cand: 'c3', status: 'employee', joiningDate: '2026-01-01', isActive: false },
        // agent B: a still-applying candidate → excluded
        { agent: 'B', cand: 'c4', status: 'applied' },
      ],
      now
    );
    assert.deepEqual(ranked, [{ userId: 'A', count: 2 }]);
  });

  it('pipelineStatusToLifecycleStage mirrors unified status', () => {
    assert.equal(pipelineStatusToLifecycleStage('offer'), 'offered');
    assert.equal(pipelineStatusToLifecycleStage('hired'), 'preboarding');
    assert.equal(pipelineStatusToLifecycleStage('employee'), 'employee');
  });
});
