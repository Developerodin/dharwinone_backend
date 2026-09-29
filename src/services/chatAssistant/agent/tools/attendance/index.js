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
  '- Backdated attendance / attendance corrections / missed-punch requests → list_backdated_requests.',
  '- "he", "she", "this person" mean the person from the previous turn — pass their real name, never the pronoun.',
  '- If a result has matches, ask which person they meant. notFound "person" means no such employee, not zero.',
  '- Shifts, week-offs, holidays and the org chart are not these tools — call handoff.',
].join('\n');

// Nouns this domain owns. "present" only as an attendance word, not "presentation".
const ATTENDANCE_RE = /\b(attendance|punch(?:ed|es|ing)?|check(?:ed)?[\s-]?(?:in|out)|present(?!ation)|absent(?:ees?)?|absences?|working\s+hours|backdated|missed\s+punch(?:es)?|regulari[sz]\w*)\b/i;
const LEAVE_RE = /\b(leaves?|leave\s+requests?|on\s+leave|time\s+off|sick\s+days?|off\s+today|out\s+of\s+office|ooo)\b/i;
// Other rounds' nouns: shifts / week-offs / holidays / org chart (R6), tasks (R7), meetings (R8),
// policy questions (knowledge base). A strong attendance noun still wins.
const OTHER_DOMAIN_RE = /\b(shifts?|week[\s-]?offs?|holidays?|org(?:ani[sz]ation(?:al)?)?\s*chart|reporting\s+line|tasks?|meetings?|polic(?:y|ies))\b/i;
const STRONG_RE = /\b(attendance|backdated|leave\s+requests?|punch(?:ed)?\s*(?:in|out))\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  if (!ATTENDANCE_RE.test(t) && !LEAVE_RE.test(t)) return false;
  return !(OTHER_DOMAIN_RE.test(t) && !STRONG_RE.test(t));
}

export default {
  domain: 'attendance',
  instructions,
  tools: [getAttendance, getAttendanceSummary, countLeaveRequests, listLeaveRequests, whoIsOnLeaveToday, listBackdatedRequests],
  matchesTurn,
};
