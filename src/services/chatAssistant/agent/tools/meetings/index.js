import countMeetings from './countMeetings.tool.js';
import listMeetings from './listMeetings.tool.js';

const instructions = [
  'Meetings: internal / team meetings from Communication → Meetings (the InternalMeeting collection).',
  '- Interviews are NOT meetings. A question about interviews, interviewers or a candidate\'s interview ' +
    'schedule is never answered with count_meetings / list_meetings — hand it off.',
  '- "How many meetings" → count_meetings (it also returns a status breakdown). "Which / what / show ' +
    'meetings" → list_meetings.',
  '- "Upcoming", "next", "coming up" → filters.when "upcoming". "Last week", "held", "past" → filters.when ' +
    '"past" or a scheduledBetween window. A specific day or range → scheduledBetween (YYYY-MM-DD).',
  '- "My meetings" or "meetings I am in" → filters.mine true.',
  '- Meeting descriptions and invitee email lists are not available here; say so if asked.',
].join('\n');

export default {
  domain: 'meetings',
  instructions,
  tools: [countMeetings, listMeetings],
};
