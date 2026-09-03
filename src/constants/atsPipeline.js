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
    // Rejected is terminal for scheduling but may be reopened manually to any live stage except Interview.
    Rejected: ['Applied', 'Screening', 'Shortlisted', 'Offered'],
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
    Joined: ['Pending', 'Onboarding', 'Deferred', 'Cancelled'],
    Deferred: ['Pending', 'Onboarding', 'Joined', 'Cancelled'],
    Cancelled: ['Pending', 'Onboarding', 'Joined', 'Deferred'],
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

/** Application statuses that block scheduling a new interview. */
export const isInterviewSchedulingBlocked = (applicationStatus) => applicationStatus === 'Rejected';

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
  Object.freeze({ value: 'PT_25', label: 'Part time — 20 hours/week', compensationType: 'paid' }),
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

/** Candidate-facing lifecycle stages — a projection of the Meeting/Offer/Placement state machines. */
export const CANDIDATE_LIFECYCLE_STAGES = freezeList([
  'interview',
  'offer',
  'preboarding',
  'onboarding',
  'hired',
  'deferred',
  'rejected',
]);

/** Stage at which the selection lifecycle closed. Drives the compact rejection badge. */
export const REJECTION_STAGES = freezeList(['interview', 'offer', 'preboarding', 'onboarding']);

const REJECTION_STAGE_LABELS = Object.freeze({
  interview: 'Rejected · Interview',
  offer: 'Rejected · Offer',
  preboarding: 'Rejected · Pre-boarding',
  onboarding: 'Rejected · Onboarding',
});

const CANDIDATE_STAGE_LABELS = Object.freeze({
  offer: 'Offer',
  preboarding: 'Pre-boarding',
  onboarding: 'Onboarding',
  hired: 'Hired',
  deferred: 'Deferred',
});

/**
 * Canonical candidate-facing lifecycle resolver. ONE source of truth for the My Applications
 * badge, the congratulations banner and the API's candidate-visible fields.
 *
 * Deepest durable evidence wins: Placement > Offer > Meeting.interviewResult. `interviewResult`
 * is a mutable interview decision — once an Offer or Placement exists it must not be able to
 * pull the candidate back to "Interview" or relabel a downstream rejection as an interview one.
 *
 * Rejection stage comes from existing persisted data, not from a new field:
 * `Placement.enteredOnboardingAt` already discriminates pre-boarding vs onboarding (it is set
 * once, never cleared), and the absence of a Placement means the offer never got accepted.
 *
 * Ceiling: assumes at most one live Offer/Placement per application (callers pass the latest).
 * If an application ever needs to show several concurrent offers, this returns the newest only.
 *
 * @returns {{stage: string, badge: string, selectionPersisted: boolean,
 *   showCongratulations: boolean, rejectionStage: string|null}}
 */
export const resolveCandidateLifecycle = ({
  applicationStatus,
  placementStatus,
  interviewResult,
  offerStatus,
  enteredOnboarding = false,
} = {}) => {
  const selectionPersisted =
    Boolean(offerStatus || placementStatus) || interviewResult === 'selected';

  const build = (stage, rejectionStage = null, badgeOverride = null) => ({
    stage,
    badge:
      badgeOverride ||
      (rejectionStage && REJECTION_STAGE_LABELS[rejectionStage]) ||
      CANDIDATE_STAGE_LABELS[stage] ||
      applicationStatus,
    selectionPersisted,
    showCongratulations: selectionPersisted && stage !== 'rejected',
    rejectionStage,
  });

  // Causal stage, not cleanup state: rejecting/expiring an offer cascades Placement -> 'Cancelled'
  // (offer.service cascadeOfferRejectionToPlacement). Checked before the placement block so that
  // cascade cannot relabel an offer rejection as a pre-boarding one. A pre-boarding/onboarding
  // cancellation leaves Offer.status = 'Accepted', so it still falls through below.
  if (offerStatus === 'Rejected') return build('rejected', 'offer');

  if (placementStatus) {
    const placementStage = enteredOnboarding ? 'onboarding' : 'preboarding';
    if (placementStatus === 'Cancelled') return build('rejected', placementStage);
    if (placementStatus === 'Deferred') return build('deferred');
    if (placementStatus === 'Joined') return build('hired');
    if (placementStatus === 'Onboarding') return build('onboarding');
    // 'Pending' = offer accepted, pre-boarding running.
    return build('preboarding');
  }

  if (offerStatus) return build('offer');

  if (interviewResult === 'rejected') return build('rejected', 'interview');
  // Rejected before any interview decision (Applied/Screening) has no stage to name.
  if (applicationStatus === 'Rejected') return build('rejected', null, 'Rejected');
  if (interviewResult === 'selected') return build('offer');
  if (interviewResult === 'pending') return build('interview', null, 'Interview');
  return build('interview');
};

/**
 * Candidate-facing badge label for a job application. Thin wrapper over
 * `resolveCandidateLifecycle` — kept so existing callers keep a single-value API.
 */
export const resolveCandidateVisibleStatus = (input) => resolveCandidateLifecycle(input).badge;
