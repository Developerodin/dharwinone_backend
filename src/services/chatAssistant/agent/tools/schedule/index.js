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

export default {
  domain: 'schedule',
  summary: "Work schedules: a person's shift and week-off, company shifts and rosters, assigned or company holidays.",
  instructions,
  tools: [getWorkSchedule, listShifts, listHolidays],
};
