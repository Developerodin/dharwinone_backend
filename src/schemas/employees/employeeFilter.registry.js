/** NL aliases and display labels for employee filters (Phase 1). */

/**
 * 'unpaid' is not a synonym for "intern". Unpaid freelancers exist, so the old
 * 'Unpaid Internship' label mislabelled them — and the employment type, not this field, is what
 * says which kind of unpaid someone is.
 */
export const COMPENSATION_LABELS = Object.freeze({
  paid: 'Paid',
  unpaid: 'Unpaid',
});

export const EMPLOYMENT_TYPE_LABELS = Object.freeze({
  'Full-time': 'Full-time',
  'Part-time': 'Part-time',
  Contract: 'Contract',
  Temporary: 'Temporary',
  Internship: 'Internship',
  Freelance: 'Freelance',
});

export const EMPLOYEE_FILTER_ALIASES = Object.freeze({
  compensationType: {
    // 'unpaid internship' stays here: it still resolves to a correct superset. Narrowing it to
    // interns specifically would need a compound alias (unpaid AND employmentType=Internship),
    // which this per-key table cannot express.
    unpaid: ['unpaid', 'unpaid employees', 'without salary', 'not paid', 'unpaid internship'],
    paid: ['paid', 'salaried', 'paid employees'],
  },
  employmentType: {
    'Full-time': ['full time', 'full-time', 'fulltime', 'permanent'],
    'Part-time': ['part time', 'part-time', 'parttime'],
    Contract: ['contract', 'contractor', 'contractors', 'on contract'],
    Temporary: ['temporary', 'temp', 'temps', 'temp staff'],
    Internship: ['internship', 'intern', 'interns', 'trainee', 'trainees'],
    Freelance: ['freelance', 'freelancer', 'freelancers'],
  },
  employmentStatus: {
    current: ['current', 'active', 'working', 'on roll'],
    resigned: ['resigned', 'former', 'left', 'ex-employee', 'past employees'],
    all: ['all employees', 'both'],
  },
});

/** Phase 1 filter keys — single source for parity assert and codegen. */
export const PHASE1_FILTER_KEYS = Object.freeze([
  'employmentStatus',
  'compensationType',
  'employmentType',
  'search',
  'fullName',
  'email',
  'employeeId',
  'agent',
  'agentIds',
  'id',
  'designation',
]);
