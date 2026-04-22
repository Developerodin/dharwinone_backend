import crypto from 'crypto';
import mongoose from 'mongoose';
import config from '../config/config.js';
import logger from '../config/logger.js';
import Candidate from '../models/candidate.model.js';

const CTX_ONBOARD = 'SHARE_CANDIDATE_ONBOARD';
const CTX_JOB = 'JOB_APPLY';

const getSecret = () => config.referral?.linkSecret || config.jwt?.secret;

/**
 * Build v1 referral ref= token (HMAC-SHA256 over base64url payload).
 * @param {object} opts
 * @param {string} opts.orgId
 * @param {'onboard'|'job'} opts.source
 * @param {string} opts.referrerUserId
 * @param {string} opts.candidateEmail - normalized email this link is bound to
 * @param {string|null} [opts.jobId]
 * @param {string|null} [opts.batchId]
 * @param {number} [opts.ttlSeconds] default 30d
 */
export const signReferralToken = (opts) => {
  const ttl = opts.ttlSeconds ?? 30 * 24 * 3600;
  const now = Math.floor(Date.now() / 1000);
  const jti = crypto.randomBytes(16).toString('hex');
  const exp = now + ttl;
  const orgId = opts.orgId || config.referral?.defaultOrgId || 'default';
  const jobId = opts.jobId && mongoose.Types.ObjectId.isValid(String(opts.jobId)) ? String(opts.jobId) : null;
  const batchId = opts.batchId ? String(opts.batchId).trim().slice(0, 200) : null;

  const payload = {
    v: 1,
    o: orgId,
    s: opts.source,
    t: String(opts.referrerUserId),
    e: String(opts.candidateEmail || '')
      .trim()
      .toLowerCase(),
    j: jobId,
    b: batchId,
    exp,
    jti,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
};

/**
 * @returns {{ ok: true, data: object } | { ok: false, error: string }}
 */
export const verifyReferralToken = (token) => {
  if (!token || typeof token !== 'string' || !token.includes('.')) {
    return { ok: false, error: 'Invalid referral token' };
  }
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) {
    return { ok: false, error: 'Invalid referral token' };
  }
  const expected = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest('base64url');
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, error: 'Invalid signature' };
  }
  let data;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    data = JSON.parse(json);
  } catch (e) {
    return { ok: false, error: 'Malformed token' };
  }
  if (data.v !== 1) {
    return { ok: false, error: 'Unsupported token version' };
  }
  const now = Math.floor(Date.now() / 1000);
  if (data.exp && now > data.exp) {
    return { ok: false, error: 'Token expired' };
  }
  if (!data.t || !mongoose.Types.ObjectId.isValid(String(data.t))) {
    return { ok: false, error: 'Invalid referrer' };
  }
  // Job "open" links: sharer+job, any applicant (e may be empty). Onboard and email-bound job links require e.
  if (!String(data.e || '').trim() && !(data.s === 'job' && data.j)) {
    return { ok: false, error: 'Token missing email' };
  }
  return { ok: true, data };
};

/**
 * Map token source to Candidate.referralContext
 */
const sourceToContext = (s) => {
  if (s === 'job') return CTX_JOB;
  return CTX_ONBOARD;
};

/**
 * Apply verified referral to a newly created or existing candidate (FVCW: skip if already attributed).
 * @param {import('mongoose').Types.ObjectId|string} candidateId
 * @param {string} registeringEmail
 * @param {object} verifiedPayload - from verifyReferralToken().data
 * @param {import('mongoose').Types.ObjectId|string} [actorForLog]
 * @returns {Promise<{ applied: boolean, reason?: string }>}
 */
export const applyReferralToCandidate = async (candidateId, registeringEmail, verifiedPayload) => {
  const email = String(registeringEmail || '')
    .trim()
    .toLowerCase();
  const tokenEmail = String(verifiedPayload.e || '')
    .trim()
    .toLowerCase();
  const unboundJob =
    !tokenEmail && verifiedPayload.s === 'job' && verifiedPayload.j;
  if (!unboundJob && email !== tokenEmail) {
    return { applied: false, reason: 'email_mismatch' };
  }

  const c = await Candidate.findById(candidateId);
  if (!c) {
    return { applied: false, reason: 'not_found' };
  }
  if (c.referredByUserId) {
    return { applied: false, reason: 'already_attributed' };
  }

  c.referredByUserId = verifiedPayload.t;
  c.referralContext = sourceToContext(verifiedPayload.s);
  c.referredAt = new Date();
  c.referralJti = verifiedPayload.jti;
  c.referralBatchId = verifiedPayload.b || null;
  if (verifiedPayload.j && mongoose.Types.ObjectId.isValid(verifiedPayload.j)) {
    c.referralJobId = verifiedPayload.j;
  }
  c.referralPipelineStatus = 'pending';
  c.attributionLockedAt = new Date();
  await c.save();
  return { applied: true };
};

/**
 * Share-candidate-form / onboarding invite: registration uses POST /auth/register with
 * `adminId` (inviter's User id). Same attribution semantics as a signed `ref` for onboard, without HMAC.
 * @param {import('mongoose').Types.ObjectId|string} candidateId
 * @param {string} inviteeEmail
 * @param {import('mongoose').Types.ObjectId|string} inviterUserId
 */
export const applyOnboardInviteReferral = async (candidateId, inviteeEmail, inviterUserId) => {
  const email = String(inviteeEmail || '')
    .trim()
    .toLowerCase();
  if (!email || !mongoose.Types.ObjectId.isValid(String(inviterUserId))) {
    return { applied: false, reason: 'invalid_input' };
  }
  const c = await Candidate.findById(candidateId);
  if (!c) {
    return { applied: false, reason: 'not_found' };
  }
  if (c.referredByUserId) {
    return { applied: false, reason: 'already_attributed' };
  }
  if (String(c.email || '')
    .trim()
    .toLowerCase() !== email) {
    return { applied: false, reason: 'email_mismatch' };
  }
  c.referredByUserId = inviterUserId;
  c.referralContext = CTX_ONBOARD;
  c.referredAt = new Date();
  c.referralPipelineStatus = 'pending';
  c.attributionLockedAt = new Date();
  await c.save();
  return { applied: true };
};

/**
 * Log structured message for security monitoring (no PII in message).
 * @param {string} type
 * @param {object} [meta]
 */
export const logReferralEvent = (type, meta = {}) => {
  logger.info(`[referral] ${type}`, { ...meta, ts: new Date().toISOString() });
};

export { CTX_ONBOARD, CTX_JOB };
