import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAssignedEmail,
  deriveAllowedProviders,
  evaluateMailboxLockPolicy,
  computePolicyFingerprint,
  toConnectionPolicyResponse,
  assertEmailAccountPersistAllowed,
  resolveCompanyEmailSettingsUserId,
} from './emailConnectionPolicy.service.js';

describe('emailConnectionPolicy', () => {
  it('normalizeAssignedEmail', () => {
    assert.equal(normalizeAssignedEmail('  A@B.COM  '), 'a@b.com');
    assert.equal(normalizeAssignedEmail(''), '');
    assert.equal(normalizeAssignedEmail(null), '');
  });

  it('deriveAllowedProviders', () => {
    assert.deepEqual(deriveAllowedProviders('gmail'), ['gmail']);
    assert.deepEqual(deriveAllowedProviders('outlook'), ['outlook']);
    assert.deepEqual(deriveAllowedProviders('unknown'), ['gmail', 'outlook']);
    assert.deepEqual(deriveAllowedProviders(''), ['gmail', 'outlook']);
  });

  it('evaluateMailboxLockPolicy: no candidate', () => {
    assert.deepEqual(evaluateMailboxLockPolicy(null, {}), { hardLockActive: false });
  });

  it('evaluateMailboxLockPolicy: lock when company email set (assignment hub toggle ignored)', () => {
    const cand = { adminId: '507f1f77bcf86cd799439011', companyAssignedEmail: 'a@corp.com', companyEmailProvider: 'gmail' };
    const admin = { adminCandidateSettings: { companyEmailAssignmentEnabled: false } };
    const p = evaluateMailboxLockPolicy(cand, admin);
    assert.equal(p.hardLockActive, true);
    assert.equal(p.expectedEmail, 'a@corp.com');
    assert.deepEqual(p.allowedProviders, ['gmail']);
  });

  it('evaluateMailboxLockPolicy: empty email', () => {
    const cand = { adminId: '507f1f77bcf86cd799439011', companyAssignedEmail: '  ', companyEmailProvider: 'gmail' };
    const admin = { adminCandidateSettings: { companyEmailAssignmentEnabled: true } };
    assert.deepEqual(evaluateMailboxLockPolicy(cand, admin), { hardLockActive: false });
  });

  it('evaluateMailboxLockPolicy: fully enabled', () => {
    const cand = {
      adminId: '507f1f77bcf86cd799439011',
      companyAssignedEmail: 'User@Corp.COM',
      companyEmailProvider: 'outlook',
    };
    const admin = { adminCandidateSettings: { companyEmailAssignmentEnabled: true } };
    const p = evaluateMailboxLockPolicy(cand, admin);
    assert.equal(p.hardLockActive, true);
    assert.equal(p.expectedEmail, 'user@corp.com');
    assert.deepEqual(p.allowedProviders, ['outlook']);
    assert.equal(p.adminId, '507f1f77bcf86cd799439011');
    assert.ok(computePolicyFingerprint(p).length > 0);
  });

  it('evaluateMailboxLockPolicy: policySourceUserId used for fingerprint admin when adminId is owner', () => {
    const ownerId = '507f1f77bcf86cd799439011';
    const agentId = '507f191e810c19729de860ea';
    const cand = {
      adminId: ownerId,
      owner: ownerId,
      assignedAgent: agentId,
      companyAssignedEmail: 'work@corp.com',
      companyEmailProvider: 'gmail',
    };
    const admin = { adminCandidateSettings: { companyEmailAssignmentEnabled: true } };
    const p = evaluateMailboxLockPolicy(cand, admin, agentId);
    assert.equal(p.hardLockActive, true);
    assert.equal(p.adminId, agentId);
  });

  it('resolveCompanyEmailSettingsUserId falls back from self-adminId to assignedAgent', () => {
    const owner = 'aaa000000000000000000001';
    const agent = 'bbb000000000000000000002';
    assert.equal(
      resolveCompanyEmailSettingsUserId({ adminId: owner, assignedAgent: agent }, owner),
      agent
    );
    assert.equal(resolveCompanyEmailSettingsUserId({ adminId: agent }, owner), agent);
  });

  it('resolveCompanyEmailSettingsUserId uses owner when adminId is self and no agent', () => {
    const owner = 'aaa000000000000000000001';
    assert.equal(resolveCompanyEmailSettingsUserId({ adminId: owner }, owner), owner);
  });

  it('toConnectionPolicyResponse strips internal fields', () => {
    assert.deepEqual(toConnectionPolicyResponse({ hardLockActive: false }), { hardLockActive: false });
    const pol = {
      hardLockActive: true,
      expectedEmail: 'a@b.com',
      allowedProviders: ['gmail'],
      policyFingerprint: 'fp',
      adminId: '507f1f77bcf86cd799439011',
    };
    assert.deepEqual(toConnectionPolicyResponse(pol), {
      hardLockActive: true,
      expectedEmail: 'a@b.com',
      allowedProviders: ['gmail'],
    });
  });

  it('assertEmailAccountPersistAllowed: no-op when lock off', () => {
    assert.doesNotThrow(() =>
      assertEmailAccountPersistAllowed({ hardLockActive: false }, 'imap', 'other@x.com')
    );
  });

  it('assertEmailAccountPersistAllowed: wrong email under lock', () => {
    assert.throws(
      () =>
        assertEmailAccountPersistAllowed(
          { hardLockActive: true, expectedEmail: 'work@corp.com', allowedProviders: ['gmail'] },
          'imap',
          'other@corp.com'
        ),
      (e) => e.code === 'MAILBOX_LOCKED'
    );
  });

  it('assertEmailAccountPersistAllowed: IMAP ok when email matches', () => {
    assert.doesNotThrow(() =>
      assertEmailAccountPersistAllowed(
        { hardLockActive: true, expectedEmail: 'work@corp.com', allowedProviders: ['gmail'] },
        'imap',
        'work@corp.com'
      )
    );
  });

  it('assertEmailAccountPersistAllowed: disallowed OAuth provider', () => {
    assert.throws(
      () =>
        assertEmailAccountPersistAllowed(
          { hardLockActive: true, expectedEmail: 'work@corp.com', allowedProviders: ['gmail'] },
          'outlook',
          'work@corp.com'
        ),
      (e) => e.code === 'WRONG_PROVIDER'
    );
  });
});
