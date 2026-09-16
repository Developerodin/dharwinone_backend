/** Situation ids, thresholds, overlap types, and default severity for smart nudges. */

export const SCAN_LIMIT = 200;

export const OVERLAP_WINDOW_MS = 12 * 60 * 60 * 1000;

export const COPY_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export const SITUATIONS = {
  interview_no_show: {
    audienceDefaults: ['candidate', 'recruiter'],
    severity: 'high',
    overlapTypes: ['meeting', 'meeting_reminder'],
  },
  result_overdue: {
    audienceDefaults: ['recruiter'],
    severity: 'medium',
    overlapTypes: ['meeting'],
    hoursAfterConclusion: 24,
  },
  application_stale: {
    audienceDefaults: ['recruiter'],
    severity: 'medium',
    overlapTypes: ['job_application'],
    staleDays: 5,
  },
  selected_no_offer: {
    audienceDefaults: ['recruiter'],
    severity: 'medium',
    overlapTypes: ['offer', 'job_application'],
    staleDays: 2,
  },
  offer_aging: {
    audienceDefaults: ['candidate', 'recruiter'],
    severity: 'medium',
    overlapTypes: ['offer'],
    candidateDays: 2,
    recruiterDays: 4,
  },
  joining_overdue: {
    audienceDefaults: ['recruiter', 'agent'],
    severity: 'medium',
    overlapTypes: ['placement_update', 'joining_reminder', 'onboarding_reminder'],
  },
  preboard_incomplete: {
    audienceDefaults: ['recruiter', 'candidate'],
    severity: 'medium',
    overlapTypes: ['placement_update', 'joining_reminder'],
    daysBeforeJoin: 3,
  },
  task_overdue: {
    audienceDefaults: ['employee'],
    severity: 'medium',
    overlapTypes: ['task'],
  },
  leave_pending_stale: {
    audienceDefaults: ['admin'],
    severity: 'medium',
    overlapTypes: ['leave'],
    staleDays: 2,
  },
};

export const SITUATION_IDS = Object.keys(SITUATIONS);
