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

function isCandidateAuthenticated(meeting, user) {
  if (!meeting || !user) return false;
  if (meeting.candidateId && user.employeeId && String(meeting.candidateId) === String(user.employeeId)) {
    return true;
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
export function resolveRosterRole({ meeting, user, publicEmail, admitted }) {
  if (user) {
    if (isCandidateAuthenticated(meeting, user)) {
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
      role: admitted ? 'guest' : 'guest',
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
    assurance: admitted ? 'uninvited' : 'uninvited',
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
  if (existing) {
    await Meeting.updateOne(
      { _id: meeting._id, 'participantRoster.identity': identity },
      {
        $set: {
          'participantRoster.$.displayName': displayName || existing.displayName,
          'participantRoster.$.emailHash': emailHash ?? existing.emailHash,
          'participantRoster.$.role': role,
          'participantRoster.$.assurance': assurance,
          'participantRoster.$.refKind': refKind || existing.refKind,
          'participantRoster.$.refId': refId ?? existing.refId,
          'participantRoster.$.lastJoinedAt': now,
        },
      }
    );
    return Meeting.findById(meeting._id);
  }
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
  await Meeting.updateOne({ _id: meeting._id }, { $push: { participantRoster: entry } });
  return Meeting.findById(meeting._id);
}

export function meetingInterviewSnapshot(meeting) {
  if (!meeting) return null;
  return {
    interviewId: meeting._id,
    applicationId: meeting.applicationId || null,
    jobId: meeting.jobId || null,
    candidateId: meeting.candidateId || null,
    round: meeting.round || null,
    interviewLanguage: meeting.interviewLanguage || 'en',
  };
}

export const rosterConstants = { ROSTER_ROLES, ROSTER_ASSURANCE, ROSTER_REF_KINDS };
