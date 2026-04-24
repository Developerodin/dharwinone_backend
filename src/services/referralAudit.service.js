import Employee from '../models/employee.model.js';
import User from '../models/user.model.js';
import * as activityLogService from './activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';
import { logReferralEvent } from './referralAttribution.service.js';

/**
 * When a referred candidate's User is activated (pending → active), write one referral audit row.
 * Does not throw (audit failure must not break user update).
 * @param {{ userId: import('mongoose').Types.ObjectId|string, actorId: import('mongoose').Types.ObjectId|string, req: import('express').Request }} opts
 */
export const tryLogReferralCandidateActivated = async ({ userId, actorId, req }) => {
  try {
    const c = await Employee.findOne({ owner: userId }).select('_id referredByUserId').lean();
    if (!c?.referredByUserId) return;
    const u = await User.findById(userId).select('name').lean();
    const displayName = u?.name && String(u.name).trim() ? String(u.name).trim().slice(0, 100) : undefined;
    const row = await activityLogService.createActivityLog(
      String(actorId),
      ActivityActions.REFERRAL_CANDIDATE_ACTIVATED,
      EntityTypes.CANDIDATE,
      String(c._id),
      {
        userId: String(userId),
        ...(displayName ? { subjectName: displayName } : {}),
        transition: { from: 'pending', to: 'active' },
      },
      req
    );
    if (row) {
      logReferralEvent('referral_candidate_activated', {
        candidateId: String(c._id),
        userId: String(userId),
      });
    }
  } catch (e) {
    logReferralEvent('referral_candidate_activation_audit_failed', { message: e?.message });
  }
};
