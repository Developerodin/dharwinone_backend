import getOrgStructure from './getOrgStructure.tool.js';

const instructions = [
  'Org chart: the Org Structure page — positions, chart departments and reporting lines.',
  '- "Manager" has THREE meanings. Pick by wording; when the user gives no hint, answer the first two in ' +
    'one reply and say which is which:',
  '  1. Manager POSITIONS on the org chart ("how many managers on the org chart", "list supervisors") → ' +
    'get_org_structure metric positions with positionType.',
  '  2. Employees whose DESIGNATION / job title is Manager ("employees with the title manager", "project ' +
    'managers") → count_employees / list_employees with filters.designation.',
  '  3. People with DIRECT REPORTS ("who has people reporting to them", "people managers") → ' +
    'get_org_structure metric people_managers.',
  '- "Departments" on the org chart (units, "departments without a node", "who is in Group A") → ' +
    'get_org_structure (departments / unit). "Employees per department" as a headcount by the Department ' +
    'field on the Employees page → count_employees groupBy department. Say which one you used; they can differ.',
  '- "Unassigned employees" (not placed in any chart department) → get_org_structure metric unassigned.',
].join('\n');

const ORG_RE = /\b(org(?:ani[sz]ation(?:al)?)?\s*(?:chart|structure|units?)|supervisors?|managers?|direct\s+reports?|reports?\s+to|reporting\s+(?:line|manager)|unassigned|ceo|departments?|group\s+[a-z0-9])\b/i;
// Turns about attendance/leave (R5), tasks/projects (R7) or meetings (R8) stay with their own domain,
// even when they mention a department or a manager. "Project manager(s)" is a designation, so it stays here.
const OTHER_DOMAIN_RE = /\b(attendance|leaves?|punch(?:es|ed)?|backdated|tasks?|sprints?|meetings?|projects?(?!\s+managers?))\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  return ORG_RE.test(t) && !OTHER_DOMAIN_RE.test(t);
}

export default {
  domain: 'org',
  instructions,
  tools: [getOrgStructure],
  matchesTurn,
};
