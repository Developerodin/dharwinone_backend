/** NL aliases and display labels for employee filters (Phase 1). */

export const COMPENSATION_LABELS = Object.freeze({
  paid: 'Paid',
  unpaid: 'Unpaid Internship',
});

export const EMPLOYEE_FILTER_ALIASES = Object.freeze({
  compensationType: {
    unpaid: ['unpaid', 'unpaid employees', 'without salary', 'not paid', 'unpaid internship'],
    paid: ['paid', 'salaried', 'paid employees'],
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
  'search',
  'fullName',
  'email',
  'employeeId',
  'agent',
  'agentIds',
  'id',
]);
