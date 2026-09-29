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

const MEETING_RE = /\bmeetings?\b/i;
// Other domains own these even when "meeting" appears: hiring (interviews), attendance/leave, tasks, org.
const NOT_MEETINGS_RE = /\b(interview\w*|attendance|leaves?|tasks?|projects?|org(?:anization|anisation)?\s*(?:chart|structure)|reports?\s+to)\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  return MEETING_RE.test(t) && !NOT_MEETINGS_RE.test(t);
}

export default {
  domain: 'meetings',
  instructions,
  tools: [countMeetings, listMeetings],
  matchesTurn,
};
