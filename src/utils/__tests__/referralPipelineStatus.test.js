import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
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

  it('pipelineStatusToLifecycleStage mirrors unified status', () => {
    assert.equal(pipelineStatusToLifecycleStage('offer'), 'offered');
    assert.equal(pipelineStatusToLifecycleStage('hired'), 'preboarding');
    assert.equal(pipelineStatusToLifecycleStage('employee'), 'employee');
  });
});
