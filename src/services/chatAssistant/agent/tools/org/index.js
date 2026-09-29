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

export default {
  domain: 'org',
  instructions,
  tools: [getOrgStructure],
};
