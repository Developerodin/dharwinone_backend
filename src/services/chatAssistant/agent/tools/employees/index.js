import countEmployees from './countEmployees.tool.js';
import listEmployees from './listEmployees.tool.js';

const instructions = [
  'Employees: people on the Employees page (the Employee role). Candidates are a DIFFERENT role — never ' +
    'answer an employee question with candidate tools or the reverse, and label numbers with the tool\'s noun.',
  '- "people", "staff", "team", "headcount", "interns" mean employees.',
  '- Any employee count — including "how many of them are employees" right after a users question — is ' +
    'count_employees, never count_users with role "Employee".',
  '- employmentStatus defaults to current. When you did not pass it, say the numbers are for current employees.',
  '- "each/per/by X" → count_employees with groupBy X. If X is not a groupBy value, say so and name the ones that exist.',
  '- "Resigned vs current/still working" → ONE count_employees call with groupBy employmentStatus; it already ' +
    'returns both numbers, so do not also count each status separately.',
  '- People named by a job title in the plural ("the react developers", "our QA engineers", "designers") are ' +
    'employees with that designation → list_employees/count_employees with filters.designation. Job postings ' +
    'are only meant when the user says job(s), opening(s), vacancy or posting.',
  '- Interns → filters.employmentType "Internship". Unpaid/paid → filters.compensationType.',
  '- One named person\'s details → get_user, not list_employees.',
].join('\n');

// Employee nouns. "people"/"staff"/"team" are employee words in this product (spec: "people/staff/
// team" = employees). Candidate/applicant phrasing belongs to the candidates/applications domains.
const EMPLOYEE_NOUN_RE = /\b(employees?|staff|headcount|interns?|internships?|team\s+members?|workforce|resigned|designations?|departments?)\b/i;
const PEOPLE_COUNT_RE = /\bhow many\s+(?:people|persons)\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  return EMPLOYEE_NOUN_RE.test(t) || PEOPLE_COUNT_RE.test(t);
}

export default {
  domain: 'employees',
  instructions,
  tools: [countEmployees, listEmployees],
  matchesTurn,
};
