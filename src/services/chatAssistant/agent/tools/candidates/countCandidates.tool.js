import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { candidateFilters } from './filters.js';
import {
  EMPLOYEES_ACCESS, personRecordsScope, personRecordsDeps, runPersonCount, personCountFacts,
} from '../employees/common.js';

export default defineTool({
  name: 'count_candidates',
  domain: 'candidates',
  kind: 'read',
  description: 'Count CANDIDATES (the Candidate role — never employees). Use for "how many candidates…".',
  input: Joi.object({ filters: candidateFilters }),
  access: EMPLOYEES_ACCESS,
  async execute({ filters } = {}, ctx) {
    const user = personRecordsScope(ctx);
    const deps = personRecordsDeps(ctx);
    // employmentStatus 'all': candidates have no employment dates to filter on.
    return runPersonCount({ filters: { ...(filters || {}), employmentStatus: 'all' }, ownerUserRole: 'candidate', user, deps });
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: personCountFacts('count_candidates', 'candidates', result.total) };
  },
});
