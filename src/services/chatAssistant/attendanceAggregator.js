// uat.dharwin.backend/src/services/chatAssistant/attendanceAggregator.js
//
// SINGLE source of truth for company-wide attendance counts. Used by
// fetch_attendance_summary and any future report endpoint. Mirrors
// fetch_employee_attendance_calendar's per-day status logic so the org
// aggregate can NEVER disagree with a per-employee drilldown.
//
// Status precedence per (employee, day):
//   Holiday > Leave > Absent > Incomplete > Present > WeekOff > Future
//   > BeforeJoining > AfterResign

import Attendance from '../../models/attendance.model.js';
import Employee from '../../models/employee.model.js';
import User from '../../models/user.model.js';
import Role from '../../models/role.model.js';
import { visibleUserStatusClause } from './visibilityRules.js';

const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function synthesizeStatus({ recs, isWeekOff, holidayName, isFuture, beforeJoin, afterResign }) {
  if (recs.length) {
    let hadPresent = false;
    let hadLeave = false;
    let hadAbsent = false;
    let hadHoliday = false;
    let earliest = null;
    let latest = null;
    for (const r of recs) {
      if (r.status === 'Present') hadPresent = true;
      if (r.status === 'Absent') hadAbsent = true;
      if (r.status === 'Leave') hadLeave = true;
      if (r.status === 'Holiday') hadHoliday = true;
      if (r.punchIn && (!earliest || new Date(r.punchIn) < earliest)) earliest = new Date(r.punchIn);
      if (r.punchOut && (!latest || new Date(r.punchOut) > latest)) latest = new Date(r.punchOut);
    }
    if (hadHoliday) return 'Holiday';
    if (hadLeave) return 'Leave';
    if (hadAbsent && !hadPresent) return 'Absent';
    if (hadPresent && !latest && earliest) return 'Incomplete';
    if (hadPresent) return 'Present';
  }
  if (beforeJoin || afterResign) return 'NotEmployee';
  if (holidayName) return 'Holiday';
  if (isWeekOff) return 'WeekOff';
  if (isFuture) return 'Future';
  return 'Absent';
}

/**
 * Compute org-wide attendance for a date window.
 *
 * @param {{ adminId: string, from: Date, to: Date, statusFilter?: string }} args
 * @returns {Promise<{
 *   total: number,
 *   perDay: Array<{ date: string, counts: object }>,
 *   employees: Array<object>,
 *   window: { from: string, to: string }
 * }>}
 */
export async function aggregateOrgAttendance({ adminId, from, to, statusFilter }) {
  const isSingleDay =
    from.getUTCFullYear() === to.getUTCFullYear() &&
    from.getUTCMonth() === to.getUTCMonth() &&
    from.getUTCDate() === to.getUTCDate();

  const empRole = await Role.findOne({ name: { $regex: /^employee$/i } }, { _id: 1 }).lean();
  const ownerIds = empRole
    ? await User.find({
        roleIds: empRole._id,
        status: visibleUserStatusClause(),
        platformSuperUser: { $ne: true },
      }).distinct('_id')
    : [];

  const profiles = await Employee.find({ owner: { $in: ownerIds } })
    .populate({ path: 'shift', select: 'name timezone' })
    .populate({ path: 'holidays', select: 'date endDate title' })
    .select('owner fullName employeeId designation department joiningDate resignDate weekOff holidays shift')
    .lean();

  const users = await User.find({ _id: { $in: ownerIds } }, { name: 1, email: 1 }).lean();
  const userById = new Map(users.map((u) => [String(u._id), u]));

  const attRows = await Attendance.find({
    user: { $in: ownerIds },
    date: { $gte: from, $lte: to },
  })
    .select('user date status punchIn punchOut duration leaveType')
    .lean();

  const attByUserDate = new Map();
  for (const r of attRows) {
    if (!r.user || !r.date) continue;
    const k = `${String(r.user)}|${new Date(r.date).toISOString().slice(0, 10)}`;
    if (!attByUserDate.has(k)) attByUserDate.set(k, []);
    attByUserDate.get(k).push(r);
  }

  const todayMs = Date.now();
  const perDay = {};
  const employeeRows = [];

  for (let cursor = new Date(from); cursor <= to; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const iso = cursor.toISOString().slice(0, 10);
    perDay[iso] = {
      Present: 0, Absent: 0, Leave: 0, Holiday: 0,
      WeekOff: 0, Incomplete: 0, Future: 0, NotEmployee: 0,
    };
  }

  for (const profile of profiles) {
    const ownerKey = String(profile.owner);
    const u = userById.get(ownerKey);
    const weekOffSet = new Set(
      Array.isArray(profile.weekOff) && profile.weekOff.length
        ? profile.weekOff
        : ['Saturday', 'Sunday']
    );
    const holidayMap = {};
    for (const h of profile.holidays || []) {
      if (!h?.date) continue;
      const start = new Date(h.date);
      const end = h.endDate ? new Date(h.endDate) : start;
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        holidayMap[d.toISOString().slice(0, 10)] = h.title || 'Holiday';
      }
    }
    const joinMs = profile.joiningDate ? new Date(profile.joiningDate).getTime() : 0;
    const resignMs = profile.resignDate ? new Date(profile.resignDate).getTime() : Number.POSITIVE_INFINITY;

    for (const iso of Object.keys(perDay)) {
      const dayMs = new Date(`${iso}T00:00:00Z`).getTime();
      const recs = attByUserDate.get(`${ownerKey}|${iso}`) || [];
      const dayName = dayNames[new Date(`${iso}T00:00:00Z`).getUTCDay()];

      const status = synthesizeStatus({
        recs,
        isWeekOff: weekOffSet.has(dayName),
        holidayName: holidayMap[iso],
        isFuture: dayMs > todayMs,
        beforeJoin: joinMs && dayMs < joinMs,
        afterResign: resignMs && dayMs > resignMs,
      });

      if (perDay[iso][status] !== undefined) perDay[iso][status] += 1;

      if (isSingleDay && (!statusFilter || status.toLowerCase() === String(statusFilter).toLowerCase())) {
        const earliest = recs.reduce(
          (a, r) => (r.punchIn && (!a || new Date(r.punchIn) < a) ? new Date(r.punchIn) : a),
          null,
        );
        const latest = recs.reduce(
          (a, r) => (r.punchOut && (!a || new Date(r.punchOut) > a) ? new Date(r.punchOut) : a),
          null,
        );
        const totalMs = recs.reduce((s, r) => s + (Number(r.duration) || 0), 0);
        employeeRows.push({
          employeeId: profile.employeeId || null,
          name: u?.name || profile.fullName,
          email: u?.email || null,
          designation: profile.designation || null,
          status,
          punchIn: earliest ? earliest.toISOString().slice(11, 16) : null,
          punchOut: latest ? latest.toISOString().slice(11, 16) : null,
          durationHours: totalMs ? +(totalMs / 3600000).toFixed(2) : 0,
        });
      }
    }
  }

  return {
    total: profiles.length,
    perDay: Object.entries(perDay).map(([date, counts]) => ({ date, counts })),
    employees: employeeRows.sort((a, b) => (a.name || '').localeCompare(b.name || '')),
    window: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
  };
}
