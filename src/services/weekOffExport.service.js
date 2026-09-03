import XLSX from 'xlsx';
import Student from '../models/student.model.js';
import Employee from '../models/employee.model.js';
import { defangCell } from '../utils/xlsxWorkbook.js';

const VALID_WEEK_OFF_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ORDER = new Map(VALID_WEEK_OFF_DAYS.map((day, index) => [day, index]));

function sortWeekOffDays(days) {
  return [...new Set(days)].sort((a, b) => (DAY_ORDER.get(a) ?? 99) - (DAY_ORDER.get(b) ?? 99));
}

function applySheetFormatting(ws, headers, aoa) {
  ws['!cols'] = headers.map((h, col) => {
    const longest = aoa.reduce((max, row) => {
      const len = String(row[col] ?? '').length;
      return len > max ? len : max;
    }, h.length);
    return { wch: Math.min(Math.max(longest + 2, 10), 60) };
  });
  const lastCol = XLSX.utils.encode_col(headers.length - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}${aoa.length}` };
}

/**
 * Merge student and employee week-off rows by owner user id.
 * @param {Array<Record<string, any>>} students
 * @param {Array<Record<string, any>>} employees
 * @returns {Array<{ employeeId: string, name: string, email: string, weekOff: string[], department: string, designation: string, profileTypes: string[] }>}
 */
export function mergeWeekOffExportRows(students = [], employees = []) {
  const byUserId = new Map();

  const ensureRow = (key, seed = {}) => {
    const existing = byUserId.get(key) || {
      employeeId: '',
      name: '',
      email: '',
      weekOff: new Set(),
      department: '',
      designation: '',
      profileTypes: new Set(),
    };
    if (seed.employeeId) existing.employeeId = seed.employeeId;
    if (seed.name) existing.name = seed.name;
    if (seed.email) existing.email = seed.email;
    if (seed.department) existing.department = seed.department;
    if (seed.designation) existing.designation = seed.designation;
    byUserId.set(key, existing);
    return existing;
  };

  for (const student of students) {
    const user = student.user;
    const userId = user?._id?.toString?.() ?? user?.toString?.();
    if (!userId) continue;
    const row = ensureRow(userId, {
      name: user?.name || '',
      email: user?.email || '',
    });
    row.profileTypes.add('Training');
    for (const day of student.weekOff || []) row.weekOff.add(day);
  }

  for (const employee of employees) {
    const owner = employee.owner;
    const ownerId = owner?._id?.toString?.() ?? owner?.toString?.();
    const key = ownerId || `employee:${employee._id?.toString?.() ?? employee.id}`;
    const row = ensureRow(key, {
      name: employee.fullName || owner?.name || '',
      email: employee.email || owner?.email || '',
      department: employee.department || '',
      designation: employee.designation || '',
      employeeId: employee.employeeId || '',
    });
    row.profileTypes.add('Employee');
    for (const day of employee.weekOff || []) row.weekOff.add(day);
  }

  return [...byUserId.values()].map((row) => ({
    employeeId: row.employeeId || '',
    name: row.name,
    email: row.email,
    weekOff: sortWeekOffDays([...row.weekOff]),
    department: row.department,
    designation: row.designation,
    profileTypes: [...row.profileTypes].sort(),
  }));
}

/**
 * Keep rows whose week-off intersects any selected filter day (OR semantics).
 * @param {Array<{ weekOff?: string[] }>} rows
 * @param {string[]} selectedDays
 * @returns {Array<Record<string, any>>}
 */
export function filterRowsByMatchingWeekOffDays(rows = [], selectedDays = []) {
  const selectedSet = new Set(selectedDays);
  return rows.filter((row) => (row.weekOff || []).some((day) => selectedSet.has(day)));
}

/**
 * Build summary counts for each selected filter day.
 * @param {Array<{ weekOff: string[] }>} rows
 * @param {string[]} selectedDays
 * @returns {Array<{ day: string, count: number }>}
 */
export function buildWeekOffSummaryCounts(rows = [], selectedDays = []) {
  return selectedDays.map((day) => ({
    day,
    count: rows.filter((row) => (row.weekOff || []).includes(day)).length,
  }));
}

/**
 * Build an in-memory .xlsx workbook for week-off export.
 * @param {Array<Record<string, any>>} rows
 * @param {string[]} selectedDays
 * @returns {Buffer}
 */
export function buildWeekOffExportBuffer(rows = [], selectedDays = []) {
  const detailHeaders = [
    'Employee ID',
    'Name',
    'Email',
    'Week-Off Days',
    'Department',
    'Designation',
    'Profile Type',
  ];
  const detailAoa = [detailHeaders];
  for (const row of rows) {
    detailAoa.push(
      [
        row.employeeId || '',
        row.name || '',
        row.email || '',
        (row.weekOff || []).join(', '),
        row.department || '',
        row.designation || '',
        (row.profileTypes || []).join(', '),
      ].map(defangCell)
    );
  }

  const summaryHeaders = ['Day', 'Count'];
  const summaryCounts = buildWeekOffSummaryCounts(rows, selectedDays);
  const summaryAoa = [summaryHeaders];
  for (const { day, count } of summaryCounts) {
    summaryAoa.push([day, count].map(defangCell));
  }

  const wb = XLSX.utils.book_new();
  const detailWs = XLSX.utils.aoa_to_sheet(detailAoa);
  applySheetFormatting(detailWs, detailHeaders, detailAoa);
  const summaryWs = XLSX.utils.aoa_to_sheet(summaryAoa);
  applySheetFormatting(summaryWs, summaryHeaders, summaryAoa);
  XLSX.utils.book_append_sheet(wb, detailWs, 'Detail');
  XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Query and merge week-off export rows for the selected days.
 * @param {string[]} selectedDays
 * @returns {Promise<Array<Record<string, any>>>}
 */
export async function queryWeekOffExportRows(selectedDays) {
  const [students, employees] = await Promise.all([
    Student.find({ weekOff: { $in: selectedDays } })
      .select('weekOff user')
      .populate('user', 'name email')
      .lean(),
    Employee.find({ weekOff: { $in: selectedDays } })
      .select('weekOff owner fullName email department designation employeeId')
      .populate('owner', 'name email')
      .lean(),
  ]);

  const merged = mergeWeekOffExportRows(students, employees);
  return filterRowsByMatchingWeekOffDays(merged, selectedDays);
}

/**
 * Build the full week-off export workbook for selected days.
 * @param {string[]} selectedDays
 * @returns {Promise<{ buffer: Buffer, rowCount: number }>}
 */
export async function buildWeekOffExportForDays(selectedDays) {
  const rows = await queryWeekOffExportRows(selectedDays);
  return {
    buffer: buildWeekOffExportBuffer(rows, selectedDays),
    rowCount: rows.length,
  };
}
