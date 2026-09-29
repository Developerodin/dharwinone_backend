import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { dayRange } from '../employees/common.js';
import {
  COMPANY_HOLIDAY_PERMISSIONS, MAX_SCHEDULE_LIST, scheduleScope, scheduleDeps, userIdOf, hasAnyPermission,
  loadScheduleProfile, assignedHolidays, shapeHoliday, todayStartIso,
} from './common.js';

const day = Joi.string().min(10).max(10).description('YYYY-MM-DD');

/**
 * scope "mine" (default) = the holidays ASSIGNED to the viewer's own Employee (else Student) profile —
 * what the portal shows them. The legacy fetch_holidays read every active Holiday, which is not what
 * any one person gets. scope "company" = the Holidays page (holiday.service queryHolidays, students.read).
 */
export default defineTool({
  name: 'list_holidays',
  domain: 'schedule',
  kind: 'read',
  description:
    'List holidays. scope "mine" (default): holidays assigned to the signed-in user — "my holidays", "when is ' +
    'my next holiday", "upcoming holidays". scope "company": every holiday defined on the Holidays page — only ' +
    'when the user asks about all/company holidays. window { from, to } as YYYY-MM-DD; default is from today on.',
  measure:
    'mine: active holidays ASSIGNED to the viewer\'s own Employee (else Student) profile; company: active ' +
    'Holiday records on the Holidays page. Both inside the window, which defaults to today onwards.',
  input: Joi.object({
    scope: Joi.string().valid('mine', 'company').default('mine'),
    window: Joi.object({ from: day, to: day }),
    limit: Joi.number().integer().min(1).max(MAX_SCHEDULE_LIST).default(20),
  }),
  access: { note: 'mine = self only; company needs students.read (holiday.route.js GET /)' },
  async execute({ scope = 'mine', window, limit = 20 } = {}, ctx) {
    const user = scheduleScope(ctx);
    const deps = scheduleDeps(ctx);
    const range = dayRange('date', window);
    const from = range.dateFrom || todayStartIso();
    const to = range.dateTo || null;
    const windowOut = { from: from.slice(0, 10), to: to ? to.slice(0, 10) : null };

    if (scope === 'company') {
      if (!hasAnyPermission(user, COMPANY_HOLIDAY_PERMISSIONS)) {
        return { error: 'Seeing every company holiday needs students.read; ask for "my holidays" instead.' };
      }
      const date = { $gte: new Date(from), ...(to ? { $lte: new Date(to) } : {}) };
      const page = await deps.queryHolidays({ isActive: true, date }, { limit, page: 1, sortBy: 'date:asc' });
      return {
        scope,
        window: windowOut,
        total: page?.totalResults ?? 0,
        holidays: (page?.results || []).map(shapeHoliday),
      };
    }

    const uid = userIdOf(user);
    const profile = (await loadScheduleProfile(deps.Employee, { owner: uid }))
      || (await loadScheduleProfile(deps.Student, { user: uid }));
    if (!profile) {
      return { scope, window: windowOut, total: 0, holidays: [], note: 'No employee or student profile is linked to your account.' };
    }
    const all = assignedHolidays(profile, { from, to });
    return { scope, window: windowOut, total: all.length, holidays: all.slice(0, limit) };
  },
  render(result) {
    if (!result || result.error) return null;
    return {
      blocks: result.holidays.length ? [{
        type: 'table',
        id: 'holiday-list',
        tableType: 'holiday-list',
        title: `${result.scope === 'company' ? 'Company holidays' : 'Your holidays'} (${result.total})`,
        columns: [
          { key: 'title', label: 'Holiday', priority: 'primary' },
          { key: 'date', label: 'Date', priority: 'primary', format: 'date' },
          { key: 'endDate', label: 'Until', priority: 'secondary', format: 'date' },
        ],
        rows: result.holidays.map((h) => ({ title: h.title ?? '—', date: h.date ?? '—', endDate: h.endDate ?? '—' })),
        layout: 'auto',
      }] : [],
      facts: { counts: [{ kind: 'list_holidays', label: 'holidays', total: result.total }] },
    };
  },
});
