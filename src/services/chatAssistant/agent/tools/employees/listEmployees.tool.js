import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { employeeFilters } from './filters.js';
import {
  EMPLOYEES_ACCESS, MAX_LIST_LIMIT, personRecordsScope, personRecordsDeps,
  runPersonList, personCountFacts, personListBlock,
} from './common.js';

export default defineTool({
  name: 'list_employees',
  domain: 'employees',
  kind: 'read',
  description:
    'List EMPLOYEES (never candidates) with their designation, department and employment type. ' +
    'total is the full count even when fewer rows come back. For one person\'s full profile use get_user.',
  measure:
    'Employee PROFILES whose account holds the Employee role and is active or pending ' +
      '(disabled/deleted accounts excluded); current (not resigned) employees unless ' +
      'filters.employmentStatus is set.',
  input: Joi.object({
    filters: employeeFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: EMPLOYEES_ACCESS,
  async execute({ filters, page, limit } = {}, ctx) {
    const user = personRecordsScope(ctx);
    const deps = personRecordsDeps(ctx);
    return runPersonList({ filters, ownerUserRole: 'employee', page, limit, user, deps });
  },
  render(result) {
    if (!result || result.error) return null;
    return {
      blocks: result.records.length ? [personListBlock(result, { label: 'employees', id: 'employee-list' })] : [],
      facts: personCountFacts('list_employees', 'employees', result.total),
    };
  },
});
