import countEmployees from './countEmployees.tool.js';
import listEmployees from './listEmployees.tool.js';

const instructions = [
  'Employees: people on the Employees page (the Employee role). Candidates are a DIFFERENT role — never ' +
    'answer an employee question with candidate tools or the reverse, and label numbers with the tool\'s noun.',
  '- "people", "staff", "team", "headcount", "interns" mean employees.',
  '- A plain employee headcount ("how many employees do we have") is count_employees — current employee ' +
    'profiles, like the Employees page. When the question is framed as users/accounts ("how many users and how ' +
    'many of them are employees") it is a role breakdown: count_users with role "Employee" or groupBy "role".',
  '- employmentStatus defaults to current. When you did not pass it, say the numbers are for current employees.',
  '- "each/per/by X" → count_employees with groupBy X. If X is not a groupBy value, say so and name the ones that exist.',
  '- "Resigned vs current/still working" → ONE count_employees call with groupBy employmentStatus; it already ' +
    'returns both numbers, so do not also count each status separately.',
  '- People named by a job title in the plural ("the react developers", "our QA engineers", "designers") are ' +
    'employees with that designation → list_employees/count_employees with filters.designation. Job postings ' +
    'are only meant when the user says job(s), opening(s), vacancy or posting.',
  '- Interns → filters.employmentType "Internship". Unpaid/paid → filters.compensationType.',
  '- "Haven\'t uploaded their salary slip(s)" → filters.missingSalarySlip ({ month, year } for one month, ' +
    'true for none at all). "Without a resume / PAN / <document>" → filters.missingDocument { type }; add ' +
    'approvedOnly when they mean not yet approved/verified. These check upload records only — you cannot read, ' +
    'summarise or link the files themselves; say so if asked.',
  '- "Joined / new joiners / resigned / left the company" in a period → filters.joinedBetween or ' +
    'filters.resignedBetween { from, to } as YYYY-MM-DD, resolved from today\'s date ("last month", "in July", ' +
    '"this year"). These include people who have since resigned, so say so. No period given → ask which one.',
  '- "Joined" about hiring — a placement marked Joined, joiners from the hiring pipeline, "who is joining next ' +
    'week" — is not an employee joining date: use count_placements / list_placements with filters.status ' +
    '"Joined" (and joiningBetween for a period). "Employees who joined" stays on joinedBetween here.',
  '- One named person\'s details → get_user, not list_employees.',
].join('\n');

// Employee nouns. "people"/"staff"/"team" are employee words in this product (spec: "people/staff/
// team" = employees). Candidate/applicant phrasing belongs to the candidates/applications domains.
const EMPLOYEE_NOUN_RE = /\b(employees?|staff|headcount|interns?|internships?|team\s+members?|workforce|resigned|resignations?|joiners?|designations?|departments?)\b/i;
const PEOPLE_COUNT_RE = /\bhow many\s+(?:people|persons)\b/i;
// "who joined last month" / "who left" / "left the company" — joining- and resign-date windows.
const JOIN_LEAVE_RE = /\bwho\s+(?:has\s+|have\s+)?(?:joined|left)\b|\bleft\s+the\s+(?:company|org\w*)\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  return EMPLOYEE_NOUN_RE.test(t) || PEOPLE_COUNT_RE.test(t) || JOIN_LEAVE_RE.test(t);
}

export default {
  domain: 'employees',
  instructions,
  tools: [countEmployees, listEmployees],
  matchesTurn,
};
