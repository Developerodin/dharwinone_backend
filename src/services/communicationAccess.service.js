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

/**
 * Current co-membership of a group conversation. Spec §2.6.
 *
 * !!! DO NOT ADD a status / archived / deletedAt / expiresAt guard to this query. !!!
 * conversation.model.js has NO such fields, and participantSchema has no membership status.
 * Group deletion is findByIdAndDelete (chat.service.js) and participant removal hard-removes the
 * row, so presence in participants.user IS current membership. Mongo does not match a filter
 * against an absent field: adding one returns zero documents for every pair, so the group
 * exception fails CLOSED and silently — every restricted user loses their co-members, and a test
 * asserting "restricted user cannot see a stranger" still passes.
 *
 * FORWARD GUARD: if archiving, soft-delete, group lifecycle state, or per-participant membership
 * status is ever added to Conversation, this function MUST be updated in the same change and the
 * canSeeUser truth-table tests extended. A soft-deleted group would otherwise keep granting
 * discovery forever.
 */
export const sharesCurrentGroup = async (viewerId, targetId) => {
  const Conversation = (await import('../models/conversation.model.js')).default;
  const found = await Conversation.exists({
    type: 'group',
    'participants.user': { $all: [oid(viewerId), oid(targetId)] },
  });
  return Boolean(found);
};

const isEligible = async (viewerId, targetId) => {
  const User = (await import('../models/user.model.js')).default;
  const filter = await baseEligible(viewerId);
  // MERGE into _id, never replace it. `{ ...filter, _id: oid(targetId) }` would overwrite the
  // whole _id operator object and silently drop the $nin hidden-user exclusion — so every
  // hideFromDirectory user would become discoverable. Mongo accepts $eq alongside $ne/$nin.
  return Boolean(await User.exists({ ...filter, _id: { ...filter._id, $eq: oid(targetId) } }));
};

/**
 * STANDING discovery authorization. Spec §2.4.
 *
 * An exact-email lookup must never cause this to return true (spec §2.0): the lookup is one-time
 * resolution authorization and grants nothing that outlives the response.
 */
export const canSeeUser = async (viewer, targetId) => {
  if (String(viewer.id) === String(targetId)) return false;
  if (!(await isEligible(viewer.id, targetId))) return false;

  const scope = await directoryScope(viewer);
  if (scope.kind === 'all') return true;
  if (scope.kind === 'referred' && scope.ids.has(String(targetId))) return true;

  return sharesCurrentGroup(viewer.id, targetId);
};

/**
 * ONE-TIME resolution authorization. Every role reaching this router already holds chats.read,
 * and the access matrix grants exact-email lookup to every role without exception — including
 * Sales Agent (spec §8.1). Kept as a named predicate so no shared middleware ever guards both
 * this and the directory route.
 */
export const canLookupUserByExactEmail = () => true;

/** Whether the browsable directory surface is available at all. Spec §2. */
export const canUseDirectorySearch = async (viewer) =>
  (await directoryScope(viewer)).kind !== 'none';

/**
 * Why a contact is being returned. The REASON decides field inclusion — never a bare boolean,
 * which is too easy to pass without understanding why, and is how a projection drifts. Spec §3.3.
 */
export const CONTACT_REASONS = {
  DIRECTORY_ALL: 'directory_all',
  DIRECTORY_REFERRED: 'directory_referred',
  EXACT_EMAIL_LOOKUP: 'exact_email_lookup',
  CONVERSATION_PARTICIPANT: 'conversation_participant',
};

const EMAIL_REASONS = new Set([
  CONTACT_REASONS.DIRECTORY_ALL,
  CONTACT_REASONS.DIRECTORY_REFERRED,
  CONTACT_REASONS.EXACT_EMAIL_LOOKUP,
]);

const ROLE_NAME_REASONS = new Set([
  CONTACT_REASONS.DIRECTORY_ALL,
  CONTACT_REASONS.DIRECTORY_REFERRED,
]);

/**
 * The single projection for EVERY discovery surface — invariant I-1 (spec §4). Authorization
 * (canSeeUser) decides WHETHER a target may be returned; this decides WHAT is returned.
 *
 * Replaces the previous full User toJSON() on chat search, so phone, notification preferences,
 * timestamps, and companyAssignedEmail stop reaching every chats.read holder.
 */
export const serializeContact = (viewer, target, { reason }) => {
  if (!Object.values(CONTACT_REASONS).includes(reason)) {
    // Fail loud. A permissive default here would silently widen disclosure on a new surface.
    throw new Error(`serializeContact: unknown reason "${reason}"`);
  }

  const card = {
    id: String(target.id || target._id),
    name: target.name || '',
    // Present for the shared API contract; web ignores it and generates avatars client-side from
    // the name. Consumers must tolerate null. Spec §3.3.
    avatar: target.avatar || null,
  };

  if (EMAIL_REASONS.has(reason)) card.email = target.email;

  // Withheld on the lookup path: the requester supplied the address, so echoing it discloses
  // nothing, but the target's role is information they did not have and do not need in order to
  // start a chat. Spec §3.3.
  if (ROLE_NAME_REASONS.has(reason)) card.roleName = target.roleName ?? null;

  return card;
};
