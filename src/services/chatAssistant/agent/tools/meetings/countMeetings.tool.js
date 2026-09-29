import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  MEETINGS_ACCESS, meetingFilters, meetingsScope, meetingsDeps, runMeetingQuery, meetingCountFacts,
} from './common.js';

export default defineTool({
  name: 'count_meetings',
  domain: 'meetings',
  kind: 'read',
  description:
    'Count internal / team meetings (Communication → Meetings), past or upcoming, with a breakdown by ' +
    'status (scheduled / ended / cancelled). Use for "how many meetings do I have this week", ' +
    '"how many meetings were cancelled last month". Never for interviews.',
  measure:
    'Internal meeting RECORDS you can see on the Meetings page (every meeting with full meetings.* ' +
      'permissions, otherwise ones you created, host or are invited to); every status and both past and ' +
      'upcoming unless filters say otherwise. ATS interviews are not included.',
  input: Joi.object({ filters: meetingFilters }),
  access: MEETINGS_ACCESS,
  async execute({ filters } = {}, ctx) {
    const user = meetingsScope(ctx);
    return runMeetingQuery({ filters: filters || {}, countOnly: true, user, deps: meetingsDeps(ctx) });
  },
  render(result) {
    if (!result || result.error) return null;
    return { blocks: [], facts: meetingCountFacts('count_meetings', result.total) };
  },
});
