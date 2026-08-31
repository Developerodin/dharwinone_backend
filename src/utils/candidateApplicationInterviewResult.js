const OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;

/**
 * Sort key for picking the latest relevant interview meeting.
 * scheduledAt is the primary signal (interview time); updatedAt/createdAt break ties.
 */
export const meetingRelevanceSortKey = (meeting) => {
  const sched = meeting.scheduledAt ? new Date(meeting.scheduledAt).getTime() : 0;
  const updated = meeting.updatedAt ? new Date(meeting.updatedAt).getTime() : 0;
  const created = meeting.createdAt ? new Date(meeting.createdAt).getTime() : 0;
  return [sched, updated, created];
};

/**
 * Whether a meeting belongs to the given application (candidate + job).
 * Mirrors meeting.service.js jobPosition resolution: ObjectId hex or exact job title.
 */
export const meetingMatchesApplication = (meeting, { candidateId, jobId, jobTitle }) => {
  const meetingCandidateId = String(meeting.candidate?.id || '');
  if (!meetingCandidateId || meetingCandidateId !== String(candidateId)) return false;

  const jobPos = (meeting.jobPosition || '').trim();
  if (!jobPos) return false;

  if (OBJECT_ID_HEX_RE.test(jobPos)) {
    return String(jobPos) === String(jobId);
  }

  if (jobTitle) {
    return jobPos.toLowerCase() === String(jobTitle).trim().toLowerCase();
  }

  return false;
};

const applicationMeta = (application) => {
  const plain = application && typeof application.toJSON === 'function' ? application.toJSON() : application || {};
  const candidate = plain.candidate;
  const job = plain.job;
  return {
    appId: String(plain.id || plain._id || ''),
    candidateId: String(candidate?.id || candidate?._id || candidate || ''),
    jobId: String(job?.id || job?._id || job || ''),
    jobTitle: job?.title || '',
  };
};

/**
 * Map each application id to the interviewResult of its latest non-cancelled meeting.
 * @param {object[]} applications
 * @param {object[]} meetings - lean Meeting docs (may include cancelled; they are filtered out)
 * @returns {Map<string, string|null>}
 */
export const buildLatestInterviewResultMap = (applications, meetings) => {
  const map = new Map();
  const relevantMeetings = (meetings || []).filter((m) => m.status !== 'cancelled');

  for (const app of applications || []) {
    const meta = applicationMeta(app);
    if (!meta.appId) continue;

    const matching = relevantMeetings.filter((m) => meetingMatchesApplication(m, meta));
    if (!matching.length) {
      map.set(meta.appId, null);
      continue;
    }

    matching.sort((a, b) => {
      const ka = meetingRelevanceSortKey(a);
      const kb = meetingRelevanceSortKey(b);
      for (let i = 0; i < ka.length; i += 1) {
        if (kb[i] !== ka[i]) return kb[i] - ka[i];
      }
      return 0;
    });

    map.set(meta.appId, matching[0].interviewResult ?? null);
  }

  return map;
};
