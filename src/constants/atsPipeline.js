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
    // Rejected is terminal for scheduling but may be reopened manually to early pipeline stages only.
    Rejected: ['Applied', 'Screening', 'Shortlisted'],
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

/** Application statuses eligible for scheduling a new interview (Option A). */
export const INTERVIEW_SCHEDULE_ELIGIBLE_STATUSES = freezeList([
  'Applied',
  'Screening',
  'Shortlisted',
  'Interview',
]);

/** User-facing reason when interview scheduling is blocked for this application status, or null when allowed. */
export const getInterviewSchedulingBlockReason = (applicationStatus) => {
  if (!applicationStatus) return null;
  if (applicationStatus === 'Rejected') {
    return 'Cannot schedule an interview for a rejected application. Change the application status first.';
  }
  if (applicationStatus === 'Offered') {
    return 'Cannot schedule an interview for an application that has already received an offer.';
  }
  if (applicationStatus === 'Hired') {
    return 'Cannot schedule an interview for a hired application.';
  }
  if (!INTERVIEW_SCHEDULE_ELIGIBLE_STATUSES.includes(applicationStatus)) {
    return `Cannot schedule an interview for an application in "${applicationStatus}" status.`;
  }
  return null;
};

/** Application statuses that block scheduling a new interview. */
export const isInterviewSchedulingBlocked = (applicationStatus) =>
  Boolean(getInterviewSchedulingBlockReason(applicationStatus));

export const isAllowedTransition = (workflow, from, to) => {
  if (!workflow || !from || !to) return false;
  if (from === to) return true;
  const transitions = ALLOWED_TRANSITIONS[workflow];
  if (!transitions) return false;
  return Array.isArray(transitions[from]) && transitions[from].includes(to);
};

/** Application statuses recruiters must not set via manual PATCH. */
export const SYSTEM_ONLY_APPLICATION_STATUSES = freezeList(['Interview', 'Offered', 'Hired']);

/**
 * Manual recruiter transitions (Option B). System services bypass this graph via direct writes.
 * Targets are Applied, Screening, Shortlisted, and Rejected only (+ valid reopen from Rejected).
 */
export const MANUAL_APPLICATION_TRANSITIONS = freezeTransitions({
  Applied: ['Screening', 'Rejected'],
  Screening: ['Shortlisted', 'Rejected'],
  Interview: ['Shortlisted', 'Rejected'],
  Shortlisted: ['Rejected'],
  Offered: ['Rejected'],
  Hired: [],
  Rejected: ['Applied', 'Screening', 'Shortlisted'],
});

export const getManualApplicationTransitionBlockReason = (to) => {
  if (to === 'Interview') {
    return 'Interview status is set automatically when an interview is scheduled.';
  }
  if (to === 'Offered') {
    return 'Application becomes Offered through the offer workflow.';
  }
  if (to === 'Hired') {
    return 'Application becomes Hired through the offer/lifecycle workflow.';
  }
  return null;
};

export const isManualApplicationTransition = (from, to) => {
  if (!from || !to) return false;
  if (from === to) return true;
  if (SYSTEM_ONLY_APPLICATION_STATUSES.includes(to)) return false;
  const transitions = MANUAL_APPLICATION_TRANSITIONS;
  return Array.isArray(transitions[from]) && transitions[from].includes(to);
};

/**
 * Employment categories. Shared vocabulary between `Job.jobType` (what was posted) and
 * `Employee.employmentType` (what someone was hired as). The offer sits between them with a
 * finer-grained enum, because an offer must also pin down paid vs unpaid.
 */
export const EMPLOYMENT_TYPES = freezeList([
  'Full-time',
  'Part-time',
  'Contract',
  'Temporary',
  'Internship',
  'Freelance',
]);

/**
 * Offer letter job types. `compensationType` is DERIVED from `value` — never stored
 * or selected manually — so paid/unpaid can never contradict the chosen job type.
 *
 * Where a category is genuinely ambiguous about pay it gets one value per outcome
 * (`FREELANCE_PAID` / `FREELANCE_UNPAID`) rather than a separate selectable field. That keeps
 * `compensationTypeForJobType` a total function: there is no state in which the letter body and
 * the paid/unpaid badge can disagree. Internship is unpaid-only by policy — "Training" IS the
 * unpaid internship — so it needs no pair.
 */
export const JOB_TYPES = freezeList([
  Object.freeze({ value: 'FT_40', label: 'Full time — 40 hours/week', compensationType: 'paid' }),
  Object.freeze({ value: 'PT_25', label: 'Part time — 20 hours/week', compensationType: 'paid' }),
  Object.freeze({ value: 'CONTRACT', label: 'Contract', compensationType: 'paid' }),
  Object.freeze({ value: 'TEMPORARY', label: 'Temporary', compensationType: 'paid' }),
  Object.freeze({
    value: 'INTERN_UNPAID',
    label: 'Training / Unpaid Internship (Full Time)',
    compensationType: 'unpaid',
  }),
  Object.freeze({ value: 'FREELANCE_PAID', label: 'Freelance (Paid)', compensationType: 'paid' }),
  Object.freeze({
    value: 'FREELANCE_UNPAID',
    label: 'Freelance (Unpaid)',
    compensationType: 'unpaid',
  }),
]);

/**
 * The enum values themselves. Derived from JOB_TYPES so the model, the letter-version snapshot
 * and the Joi schema cannot drift apart — adding a job type above is the only edit required.
 */
export const OFFER_JOB_TYPE_VALUES = freezeList(JOB_TYPES.map((t) => t.value));

/** Offer job type → employment category. Total over JOB_TYPES. */
const OFFER_JOB_TYPE_TO_EMPLOYMENT_TYPE = Object.freeze({
  FT_40: 'Full-time',
  PT_25: 'Part-time',
  CONTRACT: 'Contract',
  TEMPORARY: 'Temporary',
  INTERN_UNPAID: 'Internship',
  FREELANCE_PAID: 'Freelance',
  FREELANCE_UNPAID: 'Freelance',
});

/**
 * Employment category → the offer job type to preselect. Freelance defaults to paid; the offer
 * form lets the user flip it. This is a DEFAULT, not a constraint — terms are renegotiable
 * between posting a job and writing the offer, so nothing validates the pair afterwards.
 */
const EMPLOYMENT_TYPE_TO_OFFER_JOB_TYPE = Object.freeze({
  'Full-time': 'FT_40',
  'Part-time': 'PT_25',
  Contract: 'CONTRACT',
  Temporary: 'TEMPORARY',
  Internship: 'INTERN_UNPAID',
  Freelance: 'FREELANCE_PAID',
});

/** Offer job type → Employee/Job employment category. Unknown/missing → null, never a guess. */
export const offerJobTypeToEmploymentType = (offerJobType) =>
  OFFER_JOB_TYPE_TO_EMPLOYMENT_TYPE[offerJobType] ?? null;

/** Job/Employee employment category → suggested offer job type. Unknown/missing → null. */
export const jobTypeToOfferJobType = (employmentType) =>
  EMPLOYMENT_TYPE_TO_OFFER_JOB_TYPE[employmentType] ?? null;

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
