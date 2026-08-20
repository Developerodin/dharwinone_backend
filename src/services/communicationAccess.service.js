// src/services/communicationAccess.service.js
/**
 * Communication contact-discovery authorization.
 *
 * Design: docs/superpowers/specs/2026-08-20-communication-contact-discovery-rbac-design.md
 *
 * Three concerns stay separate (spec §2):
 *   canSeeUser()                -> STANDING discovery authorization
 *   canLookupUserByExactEmail() -> ONE-TIME resolution authorization; grants nothing durable
 *   capability flags            -> what you may DO (unchanged by this module, spec §5.6)
 *
 * A successful exact-email lookup must NEVER make canSeeUser() return true. Spec §2.0.
 */
import mongoose from 'mongoose';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import { getDirectoryHiddenUserIds } from '../utils/platformAccess.util.js';
import { getFeatureFlag } from '../utils/featureFlags.js';
import {
  DIRECTORY_ALL_PERMISSION,
  DIRECTORY_REFERRED_PERMISSION,
  COMMUNICATION_DIRECTORY_FLAG,
} from '../constants/communicationAccess.js';

const oid = (v) => new mongoose.Types.ObjectId(String(v));

const holds = (viewer, permission) =>
  Array.isArray(viewer?.permissions) && viewer.permissions.includes(permission);

/**
 * The eligibility floor for EVERY discovery surface — directory list, exact lookup, pickers.
 * Spec §2.3 and invariant I-1 (§4).
 */
export const baseEligible = async (viewerId) => {
  const hidden = await getDirectoryHiddenUserIds();
  return {
    status: 'active',
    _id: { $ne: oid(viewerId), $nin: hidden.map(oid) },
  };
};

/**
 * Keyed on permissions, never on role names: roles are renameable admin-created docs and their
 * spellings vary by org. Spec §2.2.
 *
 * Flag off returns { kind: 'all' } — exactly pre-change behaviour, so rollback is a flag flip
 * rather than a revert. Spec §9.1.
 */
export const directoryScope = async (viewer) => {
  if (!getFeatureFlag(viewer?.tenantId, COMMUNICATION_DIRECTORY_FLAG)) {
    return { kind: 'all' };
  }
  if (holds(viewer, DIRECTORY_ALL_PERMISSION)) return { kind: 'all' };
  if (holds(viewer, DIRECTORY_REFERRED_PERMISSION)) {
    const { referredUserIds } = await import('./communicationAccess.referral.js');
    return { kind: 'referred', ids: await referredUserIds(viewer) };
  }
  return { kind: 'none' };
};
