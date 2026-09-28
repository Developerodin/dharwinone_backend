import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { employeeFilters } from './filters.js';
import {
  EMPLOYEES_ACCESS, personRecordsScope, personRecordsDeps,
  runPersonCount, runPersonGroupBy, personCountFacts, personBreakdownBlock, documentFilterAccessError,
} from './common.js';

export default defineTool({
  name: 'count_employees',
  domain: 'employees',
  kind: 'read',
  description:
    'Count EMPLOYEES (people on the Employees page — never candidates). Use for "how many employees/' +
    'staff/interns/people", and breakdowns: groupBy department, designation, employmentType, ' +
    'compensationType (paid/unpaid) or employmentStatus (current vs resigned). filters.missingSalarySlip / ' +
    'missingDocument count who has NOT uploaded a salary slip or document (upload records only — never file ' +
    'contents or links).',
  measure:
    'Employee PROFILES whose account holds the Employee role and is active or pending ' +
      '(disabled/deleted accounts excluded); current (not resigned) employees unless ' +
      'filters.employmentStatus is set. Document filters test upload records, not file contents.',
  input: Joi.object({
    filters: employeeFilters,
    groupBy: Joi.string()
      .valid('department', 'designation', 'employmentType', 'compensationType', 'employmentStatus')
      .description('Break the count down by this field.'),
  }),
  access: EMPLOYEES_ACCESS,
  async execute({ filters, groupBy } = {}, ctx) {
    const user = personRecordsScope(ctx);
    const deps = personRecordsDeps(ctx);
    const denied = documentFilterAccessError(filters, user);
    if (denied) return { error: denied };
    if (groupBy) return runPersonGroupBy({ filters, ownerUserRole: 'employee', groupBy, user, deps });
    return runPersonCount({ filters, ownerUserRole: 'employee', user, deps });
  },
  render(result) {
    if (!result || result.error) return null;
    if (result.groups) {
      // No count facts for a breakdown: count enforcement would rewrite each group's number.
      return {
        blocks: [personBreakdownBlock(result, { label: 'employees', id: 'employee-breakdown' })],
        facts: { counts: [], primary: null },
      };
    }
    return { blocks: [], facts: personCountFacts('count_employees', 'employees', result.total) };
  },
});
