import getWorkSchedule from './getWorkSchedule.tool.js';
import listShifts from './listShifts.tool.js';
import listHolidays from './listHolidays.tool.js';

const instructions = [
  'Schedule: shifts, week-offs and holidays.',
  '- "My shift / what time do I work / my week off" → get_work_schedule with no person. Another named ' +
    'employee\'s shift or week-off → get_work_schedule with person.',
  '- "My holidays / next holiday / upcoming holidays" → list_holidays (scope mine — the holidays assigned to ' +
    'the user). Only "all company holidays" / "holiday calendar for everyone" is scope company.',
  '- "What shifts do we have / how many shifts" → list_shifts. "Who works the night shift" → list_shifts with ' +
    'name and includeAssignees.',
  '- Leaves, attendance and missed-punch requests are not schedule tools.',
].join('\n');

// Schedule nouns. Deliberately NOT attendance / leave / punch (R5), tasks / projects (R7) or
// meetings (R8): "holiday" alone is schedule, "leave" is not.
const SCHEDULE_RE = /\b(shifts?|week[\s-]?offs?|weekly\s+off|holidays?|work(?:ing)?\s+hours|what\s+time\s+do\s+i\s+(?:start|work|log\s*in)|my\s+schedule|work\s+schedule)\b/i;
const OTHER_DOMAIN_RE = /\b(attendance|leaves?|punch(?:es|ed)?|backdated|tasks?|projects?|sprints?|meetings?)\b/i;

export function matchesTurn(text) {
  const t = String(text || '');
  return SCHEDULE_RE.test(t) && !OTHER_DOMAIN_RE.test(t);
}

export default {
  domain: 'schedule',
  instructions,
  tools: [getWorkSchedule, listShifts, listHolidays],
  matchesTurn,
};
