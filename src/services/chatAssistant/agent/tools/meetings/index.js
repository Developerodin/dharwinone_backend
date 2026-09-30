import countMeetings from './countMeetings.tool.js';
import listMeetings from './listMeetings.tool.js';
import getMeeting from './getMeeting.tool.js';

const instructions = [
  'Meetings: internal / team meetings from Communication → Meetings (the InternalMeeting collection).',
  '- Interviews are NOT meetings. A question about interviews, interviewers or a candidate\'s interview ' +
    'schedule is never answered with the meeting tools — hand it off.',
  '- "How many meetings" → count_meetings (it also returns a status breakdown). "Which / what / show ' +
    'meetings" → list_meetings.',
  '- "Upcoming", "next", "coming up" → filters.when "upcoming". "Last week", "held", "past" → filters.when ' +
    '"past" or a scheduledBetween window. "Earlier today", "this morning\'s meetings" → filters.when ' +
    '"earlier_today". "Ended", "finished" → filters.status "ended" — ended includes meetings auto-ended when ' +
    'their slot passed, so never say one was held or attended from status alone. A specific day or range → ' +
    'scheduledBetween (YYYY-MM-DD).',
  '- "My meetings", "meetings I am in", "how many meetings do I have" → filters.mine true on the first call. ' +
    'Never count everyone\'s meetings first and then yours.',
  '- One meeting\'s details — who attended, was it recorded, the recording link, its summary, decisions or ' +
    'action items → get_meeting (by id from list_meetings, or by title plus an optional date). Several ' +
    'matches → ask which one. A null summary or empty attendees means it was not captured; say so, never ' +
    'fill it in. The recording link is a signed link that expires.',
  '- hasRecording null means the viewer cannot see recordings (needs meetings.read), not "no recording".',
  '- Meeting descriptions and invitee email lists are not available here; say so if asked.',
].join('\n');

export default {
  domain: 'meetings',
  summary: 'Internal team meetings: schedule, status, attendees, recordings, summaries, decisions and action items.',
  instructions,
  tools: [countMeetings, listMeetings, getMeeting],
};
