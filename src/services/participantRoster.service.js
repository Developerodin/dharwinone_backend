import crypto from 'crypto';
import Meeting from '../models/meeting.model.js';
import { ROSTER_ASSURANCE, ROSTER_REF_KINDS, ROSTER_ROLES } from '../constants/participantRoster.js';

export function hashParticipantEmail(email) {
  const normalized = String(email || '')
    .toLowerCase()
    .trim();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function stablePublicParticipantIdentity({ roomName, participantName, participantEmail }) {
  const emailHash = hashParticipantEmail(participantEmail);
  const namePart = String(participantName || 'guest')
    .toLowerCase()
    .trim();
  const digest = crypto
    .createHash('sha1')
    .update(`${String(roomName).trim()}|${emailHash || namePart}`)
    .digest('hex')
    .slice(0, 10);
  return `guest-${digest}`;
}

function isMongoObjectIdString(value) {
  return /^[a-f0-9]{24}$/i.test(String(value || '').trim());
}

function findRosterIdentityByEmailHash(meeting, participantEmail) {
  const emailHash = hashParticipantEmail(participantEmail);
  if (!emailHash || !Array.isArray(meeting?.participantRoster)) return null;
  const entry = meeting.participantRoster.find((r) => r.emailHash === emailHash);
  return entry?.identity || null;
}

/**
 * Public token mint: keep a pinned identity when it is already on the meeting roster or
 * admitted list. Prevents auth (user id) → public poll (guest-*) drift for interview joins.
 */
export function resolvePublicTokenIdentity({
  meeting,
  roomName,
  participantName,
  participantEmail,
  requestedIdentity,
}) {
  const serverIdentity = stablePublicParticipantIdentity({
    roomName,
    participantName,
    participantEmail,
  });
  const requested = String(requestedIdentity || '').trim();
  const rosterByEmail = findRosterIdentityByEmailHash(meeting, participantEmail);

  if (!requested) {
    return rosterByEmail || serverIdentity;
  }
  if (requested === serverIdentity) {
    return rosterByEmail || serverIdentity;
  }
  const onRoster = (meeting?.participantRoster || []).some((r) => r.identity === requested);
  const admitted = (meeting?.admittedIdentities || []).includes(requested);
  if (onRoster || admitted) {
    return requested;
  }
  // Logged-in joiner: keep user id when admission polls hit the public token route.
  if (isMongoObjectIdString(requested)) {
    return requested;
  }
  if (rosterByEmail) {
    return rosterByEmail;
  }
  return serverIdentity;
}

export function deriveAuthenticatedParticipantIdentity(user) {
  return user?.id || user?._id?.toString() || null;
}

function emailMatches(a, b) {
  if (!a || !b) return false;
  return String(a).toLowerCase().trim() === String(b).toLowerCase().trim();
}

function userMatchesEmbedded(user, embedded) {
  if (!user || !embedded) return false;
  const uid = deriveAuthenticatedParticipantIdentity(user);
  if (embedded.id && uid && String(embedded.id) === String(uid)) return true;
  if (embedded.email && user.email && emailMatches(user.email, embedded.email)) return true;
  return false;
}

function isCandidateAuthenticated(meeting, user, candidateOwnerUserId) {
  if (!meeting || !user) return false;
  if (meeting.candidateId && candidateOwnerUserId) {
    const uid = deriveAuthenticatedParticipantIdentity(user);
    if (uid && String(candidateOwnerUserId) === String(uid)) {
      return true;
    }
  }
  if (userMatchesEmbedded(user, meeting.candidate)) return true;
  return false;
}

function isInterviewerAuthenticated(meeting, user) {
  if (!meeting || !user) return false;
  if (userMatchesEmbedded(user, meeting.recruiter)) return true;
  if (Array.isArray(meeting.agents) && meeting.agents.some((a) => userMatchesEmbedded(user, a))) return true;
  if (Array.isArray(meeting.hosts) && meeting.hosts.some((h) => userMatchesEmbedded(user, h))) return true;
  return false;
}

function isCandidatePublicClaim(meeting, publicEmail) {
  if (!meeting?.candidate?.email || !publicEmail) return false;
  return emailMatches(publicEmail, meeting.candidate.email);
}

function isInterviewerPublicClaim(meeting, publicEmail) {
  if (!publicEmail) return false;
  if (meeting.recruiter?.email && emailMatches(publicEmail, meeting.recruiter.email)) return true;
  if (Array.isArray(meeting.agents) && meeting.agents.some((a) => emailMatches(publicEmail, a.email))) {
    return true;
  }
  if (Array.isArray(meeting.hosts) && meeting.hosts.some((h) => emailMatches(publicEmail, h.email))) {
    return true;
  }
  return false;
}

/**
 * Pure roster role resolution per plan §9.4.
 * @returns {{ role: string, assurance: string, refKind: string, refId: string|null }}
 */
export function resolveRosterRole({ meeting, user, publicEmail, candidateOwnerUserId }) {
  if (user) {
    if (isCandidateAuthenticated(meeting, user, candidateOwnerUserId)) {
      return {
        role: 'candidate',
        assurance: 'authenticated',
        refKind: meeting?.candidateId ? 'employee' : 'user',
        refId: meeting?.candidateId ? String(meeting.candidateId) : deriveAuthenticatedParticipantIdentity(user),
      };
    }
    if (isInterviewerAuthenticated(meeting, user)) {
      return {
        role: 'interviewer',
        assurance: 'authenticated',
        refKind: 'user',
        refId: deriveAuthenticatedParticipantIdentity(user),
      };
    }
    return {
      role: 'guest',
      assurance: 'uninvited',
      refKind: 'user',
      refId: deriveAuthenticatedParticipantIdentity(user),
    };
  }

  if (isCandidatePublicClaim(meeting, publicEmail)) {
    return {
      role: 'candidate',
      assurance: 'invite_email_claim',
      refKind: meeting?.candidateId ? 'employee' : 'none',
      refId: meeting?.candidateId ? String(meeting.candidateId) : null,
    };
  }
  if (isInterviewerPublicClaim(meeting, publicEmail)) {
    return {
      role: 'interviewer',
      assurance: 'invite_email_claim',
      refKind: 'none',
      refId: null,
    };
  }
  return {
    role: 'guest',
    assurance: 'uninvited',
    refKind: 'none',
    refId: null,
  };
}

export function resolveSpeakerFromRoster(roster, participantIdentity) {
  if (!participantIdentity || !Array.isArray(roster)) {
    return { speakerRole: 'unknown', speakerRef: null, roleAssurance: null };
  }
  const entry = roster.find((r) => r.identity === participantIdentity);
  if (!entry) {
    return { speakerRole: 'unknown', speakerRef: null, roleAssurance: null };
  }
  const ref =
    entry.refKind && entry.refKind !== 'none' && entry.refId
      ? { kind: entry.refKind, id: entry.refId }
      : null;
  return {
    speakerRole: entry.role || 'unknown',
    speakerRef: ref,
    roleAssurance: entry.assurance || null,
  };
}

export function buildRosterEntry({
  identity,
  displayName,
  emailHash,
  role,
  assurance,
  refKind,
  refId,
  now = new Date(),
}) {
  return {
    identity,
    role,
    refKind: refKind || 'none',
    refId: refId || null,
    displayName: displayName || '',
    emailHash: emailHash || null,
    assurance,
    firstJoinedAt: now,
    lastJoinedAt: now,
  };
}

export async function syncParticipantRosterForToken({
  meeting,
  identity,
  displayName,
  participantEmail,
  authUser = null,
}) {
  if (!meeting?._id || !identity) return meeting;
  let effectiveAuthUser = authUser;
  if (!effectiveAuthUser && /^[a-f0-9]{24}$/i.test(String(identity))) {
    const { default: User } = await import('../models/user.model.js');
    const u = await User.findById(identity).select('email name').lean();
    if (u) {
      effectiveAuthUser = { id: String(identity), email: u.email, name: u.name };
    }
  }
  let candidateOwnerUserId = null;
  if (meeting.candidateId) {
    const { default: Employee } = await import('../models/employee.model.js');
    const candidateEmployee = await Employee.findById(meeting.candidateId).select('owner').lean();
    candidateOwnerUserId = candidateEmployee?.owner ? String(candidateEmployee.owner) : null;
  }
  const emailHash = hashParticipantEmail(participantEmail);
  const { role, assurance, refKind, refId } = resolveRosterRole({
    meeting,
    user: effectiveAuthUser,
    publicEmail: effectiveAuthUser ? null : participantEmail,
    candidateOwnerUserId,
  });
  await upsertParticipantRosterOnToken({
    meeting,
    identity,
    displayName,
    emailHash,
    role,
    assurance,
    refKind,
    refId,
  });
  return Meeting.findById(meeting._id);
}

export async function upsertParticipantRosterOnToken({
  meeting,
  identity,
  displayName,
  emailHash,
  role,
  assurance,
  refKind,
  refId,
}) {
  if (!meeting?._id || !identity) return meeting;
  const now = new Date();
  const existing = (meeting.participantRoster || []).find((r) => r.identity === identity);
  const entry = buildRosterEntry({
    identity,
    displayName,
    emailHash,
    role,
    assurance,
    refKind,
    refId,
    now,
  });
  const pushResult = await Meeting.updateOne(
    { _id: meeting._id, 'participantRoster.identity': { $ne: identity } },
    { $push: { participantRoster: entry } }
  );
  if (pushResult.matchedCount === 0) {
    await Meeting.updateOne(
      { _id: meeting._id, 'participantRoster.identity': identity },
      {
        $set: {
          'participantRoster.$.displayName': displayName || existing?.displayName || '',
          'participantRoster.$.emailHash': emailHash ?? existing?.emailHash ?? null,
          'participantRoster.$.role': role,
          'participantRoster.$.assurance': assurance,
          'participantRoster.$.refKind': refKind || existing?.refKind || 'none',
          'participantRoster.$.refId': refId ?? existing?.refId ?? null,
          'participantRoster.$.lastJoinedAt': now,
        },
      }
    );
  }
  return Meeting.findById(meeting._id);
}

export function meetingInterviewSnapshot(meeting) {
  if (!meeting) return null;
  return {
    // getMeetingByMeetingId returns toJSON() output (no `_id`); internal meetings are not interviews.
    interviewId: meeting.meetingKind === 'internal' ? null : meeting._id || meeting.id || null,
    applicationId: meeting.applicationId || null,
    jobId: meeting.jobId || null,
    candidateId: meeting.candidateId || null,
    round: meeting.round || null,
    interviewLanguage: meeting.interviewLanguage || 'en',
  };
}

export const rosterConstants = { ROSTER_ROLES, ROSTER_ASSURANCE, ROSTER_REF_KINDS };
