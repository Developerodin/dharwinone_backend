// src/services/communicationAccess.referral.js
/**
 * Sales Agent referred set. Spec §2.5.
 *
 * No new schema: ReferralAttribution already carries the exact semantics needed.
 *   - reassignment supersedes via previousAttributionId, flipping the prior row isCurrent:false,
 *     so the previous agent loses visibility automatically
 *   - revocation (isRevoked:true) drops visibility
 *   - the unique index permits two agents on the same person only across different jobIds
 *   - subjectProfileId already references Employee, so candidate -> employee conversion is a no-op
 */
import mongoose from 'mongoose';
import ReferralAttribution from '../models/referralAttribution.model.js';
import Employee from '../models/employee.model.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));

const viewerId = (viewer) => String(viewer?.id || viewer?._id || '');

export const referredUserIds = async (viewer) => {
  const profileIds = await ReferralAttribution.find({
    salesAgentUserId: oid(viewerId(viewer)),
    isCurrent: true,
    isRevoked: false,
  }).distinct('subjectProfileId');

  if (!profileIds.length) return new Set();

  // An attributed profile may have no owner: referred, never registered a login. There is no chat
  // identity to reach, so they simply do not appear. Expected, not an error. Spec §2.5.
  const ownerIds = await Employee.find({
    _id: { $in: profileIds },
    owner: { $ne: null },
  }).distinct('owner');

  return new Set(ownerIds.map(String));
};
