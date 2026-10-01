// Department comes from Employee.department (the profile string). Team comes from an active
// TeamMember row (Teams page: isActive != false) joined to TeamGroup.name.
//
// A person on more than one team is counted in each. Group totals then do not add up to the
// request / people total. One department per profile, so department groups do partition.
//
// ponytail: both rollups group the already-scoped rows in JS. Fine for a company leave queue
// and a ≤92-day attendance window. Switch leave to an aggregate with explicit ObjectId casts
// in $match, and attendance to one employeeDays array from aggregateOrgAttendance, if either
// outgrows that.

export const NOT_SET = 'Not set';
export const MAX_GROUPS = 25;
export const TEAM_GROUP_DENIED = 'Grouping by team needs the Teams page (teams.read).';
export const TEAM_GROUP_NOTE =
  'A person on more than one workforce team is counted in each team. Group counts do not add up to total.';
export const ATTENDANCE_GROUP_METRIC =
  'Share of employee-days marked Present, excluding week-offs, holidays and days the person was not employed. ' +
  'attendancePct is null when a group has no Present, Absent, Leave or Incomplete days.';
export const LEAVE_GROUP_METRIC =
  'Leave requests in the Leave Requests page scope (every status unless filters.status is set). ' +
  'leaveDays counts booked days, clipped to filters.dates when that window is set.';

const WORKED = ['Present', 'Absent', 'Leave', 'Incomplete'];
const COUNTED_STATUS = ['Present', 'Absent', 'Leave', 'Holiday', 'WeekOff', 'Incomplete'];

const labelOf = (value) => {
  const s = value == null ? '' : String(value).trim();
  return s || NOT_SET;
};

const dayCount = (dates, window) => {
  const ms = (dates || []).map((d) => new Date(d).getTime()).filter((n) => !Number.isNaN(n));
  if (!window) return ms.length;
  const from = window.from.getTime();
  const to = window.to.getTime();
  return ms.filter((n) => n >= from && n <= to).length;
};

/** Stable identity for one attendance employee-day's person. No owner, employeeId or email → days of that row do not merge. */
export function personKey(row) {
  if (row?.owner) return `owner:${String(row.owner)}`;
  if (row?.employeeId) return `eid:${row.employeeId}`;
  if (row?.email) return `email:${String(row.email).toLowerCase()}`;
  return `anon:${row?.name || ''}|${row?.date || ''}`;
}

/** undefined when the row did not carry a department; null when it carried a blank one. */
function stampedDepartment(row) {
  if (!row || !Object.prototype.hasOwnProperty.call(row, 'department')) return undefined;
  const s = row.department == null ? '' : String(row.department).trim();
  return s || null;
}

function indexEmployees(emps) {
  const byEid = new Map();
  const byEmail = new Map();
  const byOwner = new Map();
  for (const emp of emps || []) {
    if (emp?.employeeId) byEid.set(String(emp.employeeId), emp);
    if (emp?.owner && !byOwner.has(String(emp.owner))) byOwner.set(String(emp.owner), emp);
    const email = emp?.email ? String(emp.email).toLowerCase() : '';
    if (!email) continue;
    // email is unique on Employee. Two hits means dirty data — don't guess a department.
    byEmail.set(email, byEmail.has(email) ? null : emp);
  }
  return { byEid, byEmail, byOwner };
}

function resolveEmployee(row, index) {
  if (row?.owner && index.byOwner.has(String(row.owner))) return index.byOwner.get(String(row.owner));
  if (row?.employeeId && index.byEid.has(String(row.employeeId))) return index.byEid.get(String(row.employeeId));
  if (row?.email) return index.byEmail.get(String(row.email).toLowerCase()) ?? null;
  return null;
}

/**
 * employeeId (unique) first, else a unique Employee.email match on the login email.
 * includeTeams false skips the Teams collections — department grouping must not read them.
 */
export async function loadAttendanceAssignments(rows, deps, { includeTeams }) {
  const employeeIds = [...new Set((rows || []).map((r) => r?.employeeId).filter(Boolean).map(String))];
  const ownerIds = [...new Set((rows || []).map((r) => r?.owner).filter(Boolean).map(String))];
  const emails = [...new Set(
    (rows || []).filter((r) => !r?.employeeId && !r?.owner && r?.email).map((r) => String(r.email).toLowerCase()),
  )];
  const or = [];
  if (employeeIds.length) or.push({ employeeId: { $in: employeeIds } });
  if (ownerIds.length) or.push({ owner: { $in: ownerIds } });
  if (emails.length) or.push({ email: { $in: emails } });
  const emps = or.length
    ? await deps.Employee.find({ $or: or }).select('_id employeeId email department').lean()
    : [];
  const index = indexEmployees(emps);
  const resolved = new Map();
  const stamped = new Map();
  for (const row of rows || []) {
    const key = personKey(row);
    if (!resolved.has(key)) resolved.set(key, resolveEmployee(row, index));
    const dept = stampedDepartment(row);
    if (dept !== undefined && !stamped.has(key)) stamped.set(key, dept);
  }

  const teamsByEmp = new Map();
  if (includeTeams) {
    const ids = [...resolved.values()].map((e) => e?._id).filter(Boolean);
    if (ids.length) {
      const members = await deps.TeamMember.find({ employeeId: { $in: ids }, isActive: { $ne: false } })
        .select('employeeId teamId').lean();
      const teamIds = [...new Set(members.map((m) => m.teamId).filter(Boolean))];
      const teams = teamIds.length
        ? await deps.Team.find({ _id: { $in: teamIds } }).select('name').lean()
        : [];
      const nameById = new Map(teams.map((t) => [String(t._id ?? t.id), t.name]));
      for (const member of members) {
        const name = nameById.get(String(member.teamId));
        if (!name || !String(name).trim()) continue;
        const id = String(member.employeeId);
        if (!teamsByEmp.has(id)) teamsByEmp.set(id, new Set());
        teamsByEmp.get(id).add(String(name).trim());
      }
    }
  }

  const assignments = new Map();
  for (const [key, emp] of resolved) {
    const fromProfile = emp?.department && String(emp.department).trim() ? String(emp.department).trim() : null;
    assignments.set(key, {
      department: stamped.has(key) ? stamped.get(key) : fromProfile,
      teams: emp ? [...(teamsByEmp.get(String(emp._id)) || [])].sort() : [],
    });
  }
  return assignments;
}

function emptyCounts() {
  return Object.fromEntries(COUNTED_STATUS.map((s) => [s, 0]));
}

function capGroups(sorted, countOf) {
  const groups = sorted.slice(0, MAX_GROUPS);
  const otherCount = sorted.slice(MAX_GROUPS).reduce((sum, g) => sum + countOf(g), 0);
  return { groups, ...(otherCount ? { otherCount } : {}) };
}

/**
 * @param {Array<{ employeeId?: string, email?: string, name?: string, status?: string, date?: string }>} employeeDays
 * @param {Map<string, { department: string|null, teams: string[] }>} assignments
 */
export function rollupAttendance(employeeDays, assignments, groupBy) {
  const buckets = new Map();
  const people = new Map();
  for (const row of employeeDays || []) {
    if (!COUNTED_STATUS.includes(row?.status)) continue; // Future / NotEmployee are not attendance
    const key = personKey(row);
    const asg = assignments.get(key) || { department: null, teams: [] };
    const labels = groupBy === 'team'
      ? (asg.teams.length ? asg.teams : [NOT_SET])
      : [labelOf(asg.department)];
    for (const label of labels) {
      if (!buckets.has(label)) buckets.set(label, emptyCounts());
      const counts = buckets.get(label);
      counts[row.status] += 1;
      if (!people.has(label)) people.set(label, new Set());
      people.get(label).add(key);
    }
  }
  const sorted = [...buckets].map(([value, counts]) => {
    const denom = WORKED.reduce((sum, s) => sum + counts[s], 0);
    return {
      value,
      people: people.get(value).size,
      present: counts.Present,
      absent: counts.Absent,
      leave: counts.Leave,
      incomplete: counts.Incomplete,
      holiday: counts.Holiday,
      weekOff: counts.WeekOff,
      attendancePct: denom ? Math.round((counts.Present / denom) * 100) : null,
    };
  }).sort((a, b) => (b.attendancePct ?? -1) - (a.attendancePct ?? -1)
    || b.present - a.present
    || a.value.localeCompare(b.value));
  return capGroups(sorted, (g) => g.people);
}

/**
 * Scoped leave docs → department or team buckets. deps.Student / Employee / (team) are the
 * same collections the profile and Teams page read; the caller already applied row scope.
 */
export async function groupLeaveDocs(docs, { window, groupBy, deps }) {
  const studentIds = [...new Set((docs || []).map((d) => d?.student).filter(Boolean))];
  const students = studentIds.length
    ? await deps.Student.find({ _id: { $in: studentIds } }).select('user').lean()
    : [];
  const ownerByStudent = new Map(students.map((s) => [String(s._id), String(s.user?._id ?? s.user ?? '')]));
  const ownerIds = [...new Set([...ownerByStudent.values()].filter(Boolean))];
  const emps = ownerIds.length
    ? await deps.Employee.find({ owner: { $in: ownerIds } }).select('_id owner department').lean()
    : [];
  // Two Employee profiles for one login: the first one wins. The other department is ignored.
  const empByOwner = new Map();
  for (const emp of emps) {
    const owner = String(emp.owner ?? '');
    if (owner && !empByOwner.has(owner)) empByOwner.set(owner, emp);
  }

  const teamsByEmp = new Map();
  if (groupBy === 'team') {
    const ids = [...empByOwner.values()].map((e) => e._id).filter(Boolean);
    if (ids.length) {
      const members = await deps.TeamMember.find({ employeeId: { $in: ids }, isActive: { $ne: false } })
        .select('employeeId teamId').lean();
      const teamIds = [...new Set(members.map((m) => m.teamId).filter(Boolean))];
      const teams = teamIds.length
        ? await deps.Team.find({ _id: { $in: teamIds } }).select('name').lean()
        : [];
      const nameById = new Map(teams.map((t) => [String(t._id ?? t.id), t.name]));
      for (const member of members) {
        const name = nameById.get(String(member.teamId));
        if (!name || !String(name).trim()) continue;
        const id = String(member.employeeId);
        if (!teamsByEmp.has(id)) teamsByEmp.set(id, new Set());
        teamsByEmp.get(id).add(String(name).trim());
      }
    }
  }

  const buckets = new Map();
  for (const doc of docs || []) {
    const owner = ownerByStudent.get(String(doc.student)) || '';
    const emp = owner ? empByOwner.get(owner) : null;
    const days = dayCount(doc.dates, window);
    const labels = groupBy === 'team'
      ? (emp && teamsByEmp.get(String(emp._id))?.size
        ? [...teamsByEmp.get(String(emp._id))]
        : [NOT_SET])
      : [labelOf(emp?.department)];
    for (const label of labels) {
      const bucket = buckets.get(label) || { count: 0, leaveDays: 0 };
      bucket.count += 1;
      bucket.leaveDays += days;
      buckets.set(label, bucket);
    }
  }
  const sorted = [...buckets].map(([value, bucket]) => ({ value, ...bucket }))
    .sort((a, b) => b.leaveDays - a.leaveDays || b.count - a.count || a.value.localeCompare(b.value));
  return capGroups(sorted, (g) => g.count);
}
