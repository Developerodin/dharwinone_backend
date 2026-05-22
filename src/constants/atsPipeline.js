const freezeList = (items) => Object.freeze([...items]);

const freezeTransitions = (map) =>
  Object.freeze(
    Object.fromEntries(Object.entries(map).map(([status, next]) => [status, freezeList(next)]))
  );

export const APPLICATION_STATUSES = freezeList([
  'Applied',
  'Screening',
  'Interview',
  'Shortlisted',
  'Offered',
  'Hired',
  'Rejected',
]);

/** Meeting lifecycle status (Meeting.status). */
export const INTERVIEW_STATUSES = freezeList(['scheduled', 'ended', 'cancelled']);

/** Interview outcome (Meeting.interviewResult) — distinct from the meeting lifecycle status. */
export const INTERVIEW_RESULTS = freezeList(['pending', 'selected', 'rejected']);

export const OFFER_STATUSES = freezeList(['Draft', 'Sent', 'Under Negotiation', 'Accepted', 'Rejected']);

export const PLACEMENT_STATUSES = freezeList(['Pending', 'Onboarding', 'Joined', 'Deferred', 'Cancelled']);

export const PRE_BOARDING_STATUSES = freezeList(['Pending', 'In Progress', 'Completed']);

export const ALLOWED_TRANSITIONS = Object.freeze({
  // Strict forward-only pipeline — no skipping stages. Rejection is reachable from
  // every live stage. Hired/Rejected are terminal. This is the guardrail that
  // blocks Applied→Hired and other arbitrary jumps.
  application: freezeTransitions({
    Applied: ['Screening', 'Rejected'],
    Screening: ['Interview', 'Shortlisted', 'Rejected'],
    Interview: ['Shortlisted', 'Offered', 'Rejected'],
    Shortlisted: ['Offered', 'Rejected'],
    Offered: ['Hired', 'Rejected'],
    Hired: [],
    Rejected: [],
  }),
  interviewResult: freezeTransitions({
    pending: ['selected', 'rejected'],
    selected: ['pending', 'rejected'],
    rejected: ['pending', 'selected'],
  }),
  offer: freezeTransitions({
    Draft: ['Sent', 'Rejected'],
    Sent: ['Under Negotiation', 'Accepted', 'Rejected'],
    'Under Negotiation': ['Sent', 'Accepted', 'Rejected'],
    Accepted: [],
    Rejected: [],
  }),
  placement: freezeTransitions({
    Pending: ['Onboarding', 'Joined', 'Deferred', 'Cancelled'],
    Onboarding: ['Pending', 'Joined', 'Deferred', 'Cancelled'],
    Joined: ['Deferred'],
    Deferred: ['Pending', 'Onboarding', 'Joined', 'Cancelled'],
    Cancelled: ['Pending', 'Onboarding', 'Deferred'],
  }),
});

export const CANDIDATE_STATUS_MAP = Object.freeze({
  application: Object.freeze({
    Applied: 'Application received',
    Screening: 'Application under review',
    Interview: 'Interview in progress',
    Shortlisted: 'Shortlisted',
    Offered: 'Offer stage',
    Hired: 'Hired',
    Rejected: 'Application closed',
  }),
  interviewResult: Object.freeze({
    pending: 'Interview scheduled',
    selected: 'Selected for next stage',
    rejected: 'Not selected',
  }),
  offer: Object.freeze({
    Draft: 'Offer in preparation',
    Sent: 'Offer sent',
    'Under Negotiation': 'Offer discussion in progress',
    Accepted: 'Offer accepted',
    Rejected: 'Offer closed',
  }),
  placement: Object.freeze({
    Pending: 'Offer',
    Onboarding: 'Onboarding',
    Joined: 'Joined',
    Deferred: 'On hold',
    Cancelled: 'Process cancelled',
  }),
});

export const isAllowedTransition = (workflow, from, to) => {
  if (!workflow || !from || !to) return false;
  if (from === to) return true;
  const transitions = ALLOWED_TRANSITIONS[workflow];
  if (!transitions) return false;
  return Array.isArray(transitions[from]) && transitions[from].includes(to);
};

/**
 * Offer letter job types. `compensationType` is DERIVED from `value` — never stored
 * or selected manually — so paid/unpaid can never contradict the chosen job type.
 */
export const JOB_TYPES = freezeList([
  Object.freeze({ value: 'FT_40', label: 'Full time — 40 hours/week', compensationType: 'paid' }),
  Object.freeze({ value: 'PT_25', label: 'Part time — 25 hours/week', compensationType: 'paid' }),
  Object.freeze({
    value: 'INTERN_UNPAID',
    label: 'Training / Unpaid Internship (Full Time)',
    compensationType: 'unpaid',
  }),
]);

export const COMPENSATION_TYPES = freezeList(['paid', 'unpaid']);

/**
 * Provenance of a compensationType value. `jobTypeDerived` = mirrored from an
 * offer's job type; `manual` = set directly by an admin on the employee form.
 * Seam for future stipend / contract / grant / external-payroll sources.
 */
export const COMPENSATION_SOURCES = freezeList(['jobTypeDerived', 'manual']);

/** Derive 'paid' | 'unpaid' from an offer job type. Unknown/missing → 'paid'. */
export const compensationTypeForJobType = (jobType) => {
  const match = JOB_TYPES.find((t) => t.value === jobType);
  return match ? match.compensationType : 'paid';
};

/**
 * Candidate-facing status for a job application. Pre-boarding is an internal
 * operational phase: while a Placement sits in 'Pending' the candidate still
 * sees "Offer" — internal onboarding workflows are never exposed to candidates.
 * With no active placement, the raw application status is returned unchanged.
 */
export const resolveCandidateVisibleStatus = ({ applicationStatus, placementStatus } = {}) => {
  if (placementStatus === 'Pending') return 'Offer';
  return applicationStatus;
};
