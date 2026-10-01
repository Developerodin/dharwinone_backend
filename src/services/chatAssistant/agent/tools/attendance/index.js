import getAttendance from './getAttendance.tool.js';
import getAttendanceSummary from './getAttendanceSummary.tool.js';
import countLeaveRequests from './countLeaveRequests.tool.js';
import listLeaveRequests from './listLeaveRequests.tool.js';
import whoIsOnLeaveToday from './whoIsOnLeaveToday.tool.js';
import listBackdatedRequests from './listBackdatedRequests.tool.js';

const instructions = [
  'Attendance & leave: punches / attendance days, leave REQUESTS, who is on leave today, backdated attendance requests.',
  '- Resolve every date phrase ("yesterday", "last month", "in July") from today\'s date into YYYY-MM-DD before calling.',
  '- "My attendance" / "when did I punch in" → get_attendance with no person. A named person → get_attendance ' +
    'with person. Company-wide "how many present/absent", "company attendance", "average daily present" → ' +
    'get_attendance_summary (needs a window; ask for one if none was given).',
  '- "Who is on leave today / off today / out right now" → who_is_on_leave_today. A zero is a real answer.',
  '- Leave requests: "how many / pending / approved" → count_leave_requests; "show / which / whose" → ' +
    'list_leave_requests. "My leaves" → filters.mine true. A named person → filters.person. With no person and no ' +
    'mine the viewer gets every request the Leave Requests page shows them.',
  '- "Who took the most leave" / "rank by leave" → count_leave_requests groupBy "employee" with filters.dates; ' +
    'no period given → ask which period. It counts approved leave days unless the user asks for another status.',
  '- "Which department / team took the most leave" or "leave by department / team" → count_leave_requests ' +
    'groupBy "department" or "team". Department is the employee profile department ("Not set" when blank). ' +
    'Team is the workforce team. Pass filters.status "approved" when they mean absence that was taken. ' +
    'groupBy "team" needs teams.read; if the tool says so, tell the user — do not guess team names.',
  '- "Why was leave rejected / what did the approver say" → list_leave_requests. adminComment is the reviewer ' +
    'comment the Leave Requests page shows; null means none was recorded. Do not invent a reason.',
  '- Backdated attendance / attendance corrections / missed-punch requests → list_backdated_requests. ' +
    '"Why was this correction rejected / what note was left" uses that list: notes is the requester\'s note and ' +
    'adminComment is the reviewer\'s comment, both null when not recorded.',
  '- "Which department / team had the highest attendance" → get_attendance_summary groupBy "department" or ' +
    '"team" (team needs teams.read). Rank by attendancePct. Null attendancePct means that group had no ' +
    'working days in the window. A person on several teams is counted in each.',
  '- "he", "she", "this person" mean the person from the previous turn — pass their real name, never the pronoun.',
  '- If a result has matches, ask which person they meant. notFound "person" means no such employee, not zero.',
  '- Shifts, week-offs, holidays and the org chart are not these tools — call handoff.',
].join('\n');

export default {
  domain: 'attendance',
  summary: 'Attendance punches, by department or team, leave comments, who is on leave, backdated corrections.',
  instructions,
  tools: [getAttendance, getAttendanceSummary, countLeaveRequests, listLeaveRequests, whoIsOnLeaveToday, listBackdatedRequests],
};
