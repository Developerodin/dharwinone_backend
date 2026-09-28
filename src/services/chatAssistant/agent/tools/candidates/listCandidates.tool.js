import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { candidateFilters } from './filters.js';
import {
  EMPLOYEES_ACCESS, MAX_LIST_LIMIT, personRecordsScope, personRecordsDeps,
  runPersonList, personCountFacts, personListBlock,
} from '../employees/common.js';

export default defineTool({
  name: 'list_candidates',
  domain: 'candidates',
  kind: 'read',
  description:
    'List CANDIDATES (never employees). total is the full count even when fewer rows come back. ' +
    'For one person\'s full profile use get_user.',
  measure:
    'Candidate PROFILES whose account holds the Candidate role and is active or pending ' +
      '(disabled/deleted accounts excluded). For candidate ACCOUNTS of every status (the Users page ' +
      'number) use count_users with role Candidate and status all.',
  input: Joi.object({
    filters: candidateFilters,
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }),
  access: EMPLOYEES_ACCESS,
  async execute({ filters, page, limit } = {}, ctx) {
    const user = personRecordsScope(ctx);
    const deps = personRecordsDeps(ctx);
    return runPersonList({
      filters: { ...(filters || {}), employmentStatus: 'all' }, ownerUserRole: 'candidate', page, limit, user, deps,
    });
  },
  render(result) {
    if (!result || result.error) return null;
    return {
      blocks: result.records.length ? [personListBlock(result, { label: 'candidates', id: 'candidate-list' })] : [],
      facts: personCountFacts('list_candidates', 'candidates', result.total),
    };
  },
});
