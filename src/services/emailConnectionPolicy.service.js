import crypto from 'crypto';
import mongoose from 'mongoose';
import Candidate from '../models/candidate.model.js';
import EmailAccount from '../models/emailAccount.model.js';
import logger from '../config/logger.js';

/**
 * Multi-account when hard lock turns on (existing users with several mailboxes):
 * **Option A (product choice)** — no automatic revoke on toggle/assign alone; Communication shows
 * a reconnect banner until the user completes OAuth with the assigned address; OAuth success path
 * revokes non-matching accounts in the same callback.
 */

/** @typedef {'gmail'|'outlook'} MailProvider */

/**
 * Normalize company-assigned email (same rules as candidate.service).
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeAssignedEmail(raw) {
  if (raw === null || raw === undefined || raw === '') return '';
  return String(raw).toLowerCase().trim();
}

/**
 * @param {string} companyEmailProvider
 * @returns {MailProvider[]}
 */
export function deriveAllowedProviders(companyEmailProvider) {
  const p = String(companyEmailProvider || '')
    .trim()
    .toLowerCase();
  if (p === 'gmail') return ['gmail'];
  if (p === 'outlook') return ['outlook'];
  return ['gmail', 'outlook'];
}

/**
 * Hard lock whenever a company work email is stored on the candidate (no separate hub toggle).
 * @param {{ companyAssignedEmail?: string, companyEmailProvider?: string, adminId?: unknown, owner?: unknown } | null} candidate
 * @param {{ adminCandidateSettings?: { companyEmailAssignmentEnabled?: boolean } } | null} _adminUser Reserved for tests / future use (ignored).
 * @param {import('mongoose').Types.ObjectId|string|null|undefined} policySourceUserId Stable id for OAuth policy fingerprint (resolved recruiting/owner id).
 */
export function evaluateMailboxLockPolicy(candidate, _adminUser, policySourceUserId = null) {
  if (!candidate) {
    return { hardLockActive: false };
  }
  const expectedEmail = normalizeAssignedEmail(candidate.companyAssignedEmail);
  if (!expectedEmail) {
    return { hardLockActive: false };
  }
  const adminKey =
    policySourceUserId != null && policySourceUserId !== ''
      ? String(policySourceUserId)
      : candidate.adminId != null
        ? String(candidate.adminId)
        : candidate.owner != null
          ? String(candidate.owner)
          : '';
  if (!adminKey) {
    return { hardLockActive: false };
  }
  const allowedProviders = deriveAllowedProviders(candidate.companyEmailProvider);
  return {
    hardLockActive: true,
    expectedEmail,
    allowedProviders,
    adminId: adminKey,
  };
}

/**
 * Fingerprint for OAuth state (detect admin reassignment mid-flight).
 * @param {{ hardLockActive: true, expectedEmail: string, adminId: string }} policy
 */
export function computePolicyFingerprint(policy) {
  if (!policy || !policy.hardLockActive) return '';
  const payload = JSON.stringify({
    e: policy.expectedEmail,
    a: policy.adminId,
  });
  return crypto.createHash('sha256').update(payload).digest('base64url').slice(0, 32);
}

/**
 * Stable id for OAuth policy fingerprint when `adminId` is missing or equals the candidate owner.
 * When `adminId` incorrectly equals the candidate owner, prefer `assignedAgent` if set.
 * @param {{ adminId?: unknown, assignedAgent?: unknown } | null} candidate
 * @param {import('mongoose').Types.ObjectId|string} ownerUserId
 * @returns {string|null}
 */
export function resolveCompanyEmailSettingsUserId(candidate, ownerUserId) {
  if (!candidate || !ownerUserId) return null;
  const ownerStr = String(ownerUserId);
  let settingsUserId = candidate.adminId != null ? String(candidate.adminId) : '';
  if (!settingsUserId || settingsUserId === ownerStr) {
    settingsUserId = candidate.assignedAgent != null ? String(candidate.assignedAgent) : '';
  }
  if (!settingsUserId || settingsUserId === ownerStr) {
    return ownerStr;
  }
  return settingsUserId;
}

/**
 * @param {import('mongoose').Types.ObjectId|string} ownerUserId
 * @returns {Promise<{ hardLockActive: false } | { hardLockActive: true, expectedEmail: string, allowedProviders: MailProvider[], policyFingerprint: string, adminId: string }>}
 */
export async function getAssignedMailboxPolicy(ownerUserId) {
  const oid = mongoose.Types.ObjectId.isValid(ownerUserId) ? new mongoose.Types.ObjectId(ownerUserId) : null;
  if (!oid) {
    return { hardLockActive: false };
  }
  try {
    const candidate = await Candidate.findOne({ owner: oid })
      .select('adminId assignedAgent owner companyAssignedEmail companyEmailProvider')
      .lean();
    if (!candidate) {
      return { hardLockActive: false };
    }
    const settingsUserId = resolveCompanyEmailSettingsUserId(candidate, oid);
    const policy = evaluateMailboxLockPolicy(candidate, null, settingsUserId);
    if (!policy.hardLockActive) {
      return { hardLockActive: false };
    }
    const policyFingerprint = computePolicyFingerprint(policy);
    return {
      hardLockActive: true,
      expectedEmail: policy.expectedEmail,
      allowedProviders: policy.allowedProviders,
      policyFingerprint,
      adminId: policy.adminId,
    };
  } catch (err) {
    logger.error('[mailbox_lock] getAssignedMailboxPolicy failed: %s', err?.message);
    return { hardLockActive: false };
  }
}

/**
 * Response shape for GET /v1/email/connection-policy (no fingerprint / adminId).
 * @param {Awaited<ReturnType<typeof getAssignedMailboxPolicy>>} policy
 */
export function toConnectionPolicyResponse(policy) {
  if (!policy.hardLockActive) {
    return { hardLockActive: false };
  }
  return {
    hardLockActive: true,
    expectedEmail: policy.expectedEmail,
    allowedProviders: policy.allowedProviders,
  };
}

/**
 * Revoke every other active email account for this user (same request as OAuth success).
 * @param {import('mongoose').Types.ObjectId|string} userId
 * @param {import('mongoose').Types.ObjectId|string} keepAccountId
 */
export async function revokeAllOtherEmailAccounts(userId, keepAccountId) {
  const uid = mongoose.Types.ObjectId.isValid(userId) ? new mongoose.Types.ObjectId(userId) : null;
  const kid = mongoose.Types.ObjectId.isValid(keepAccountId) ? new mongoose.Types.ObjectId(keepAccountId) : null;
  if (!uid || !kid) return { revoked: 0 };
  const PLACEHOLDER = '__revoked__';
  const res = await EmailAccount.updateMany(
    { user: uid, _id: { $ne: kid }, status: 'active' },
    {
      $set: {
        status: 'revoked',
        accessToken: PLACEHOLDER,
        refreshToken: null,
        tokenExpiry: null,
      },
    }
  );
  const count = res.modifiedCount ?? res.nModified ?? 0;
  logger.info('[mailbox_lock] bulk_revoke_succeeded userId=%s revoked=%s', String(uid), String(count));
  return { revoked: count };
}

/**
 * Guard any new EmailAccount row under hard lock (IMAP or OAuth).
 * @param {Awaited<ReturnType<typeof getAssignedMailboxPolicy>>} policy
 * @param {'gmail'|'outlook'|'imap'} provider
 * @param {string} normalizedEmail
 */
export function assertEmailAccountPersistAllowed(policy, provider, normalizedEmail) {
  if (!policy.hardLockActive) return;
  const email = normalizeAssignedEmail(normalizedEmail);
  if (email !== policy.expectedEmail) {
    const err = new Error('MAILBOX_LOCKED');
    err.code = 'MAILBOX_LOCKED';
    throw err;
  }
  if (provider === 'imap') {
    return;
  }
  if (!policy.allowedProviders.includes(provider)) {
    const err = new Error('WRONG_PROVIDER');
    err.code = 'WRONG_PROVIDER';
    throw err;
  }
}
