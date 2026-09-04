import httpStatus from 'http-status';
import Shift from '../models/shift.model.js';
import Student from '../models/student.model.js';
import Employee from '../models/employee.model.js';
import ApiError from '../utils/ApiError.js';
import { collationForSortBy } from '../utils/mongoCollation.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const createSingleShift = async (shiftBody) => {
  const { name, description, timezone, startTime, endTime, isActive } = shiftBody;
  const [startHours, startMinutes] = startTime.split(':').map(Number);
  const [endHours, endMinutes] = endTime.split(':').map(Number);
  const startTotalMinutes = startHours * 60 + startMinutes;
  const endTotalMinutes = endHours * 60 + endMinutes;
  if (endTotalMinutes === startTotalMinutes) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'End time cannot be the same as start time');
  }
  const shift = await Shift.create({
    name,
    description,
    timezone,
    startTime,
    endTime,
    isActive: isActive !== undefined ? isActive : true,
  });
  return shift;
};

const createShift = async (shiftBody, _user) => {
  if (Array.isArray(shiftBody)) {
    if (shiftBody.length === 0) throw new ApiError(httpStatus.BAD_REQUEST, 'At least one shift is required');
    if (shiftBody.length > 100) throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot create more than 100 shifts at once');
    const shifts = [];
    const errors = [];
    for (let i = 0; i < shiftBody.length; i++) {
      try {
        shifts.push(await createSingleShift(shiftBody[i]));
      } catch (err) {
        errors.push({ index: i, shift: shiftBody[i], error: err.message });
      }
    }
    if (shifts.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Failed to create shifts: ${errors.map((e) => `Shift ${e.index + 1}: ${e.error}`).join('; ')}`);
    }
    return errors.length > 0 ? { shifts, errors, partialSuccess: true } : shifts;
  }
  return await createSingleShift(shiftBody);
};

const queryShifts = async (filter, options) => {
  const query = { ...filter };
  if (query.name && typeof query.name === 'string' && query.name.trim()) {
    query.name = { $regex: escapeRegex(query.name.trim()), $options: 'i' };
  }
  return await Shift.paginate(query, {
    ...options,
    collation: collationForSortBy(options.sortBy),
  });
};

const getShiftById = async (id) => {
  const shift = await Shift.findById(id);
  if (!shift) throw new ApiError(httpStatus.NOT_FOUND, 'Shift not found');
  return shift;
};

const updateShiftById = async (shiftId, updateBody, _user) => {
  const shift = await getShiftById(shiftId);
  const startTime = updateBody.startTime ?? shift.startTime;
  const endTime = updateBody.endTime ?? shift.endTime;
  if (startTime && endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    if (eh * 60 + em === sh * 60 + sm) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'End time cannot be the same as start time');
    }
  }
  Object.assign(shift, updateBody);
  await shift.save();
  return shift;
};

const deleteShiftById = async (shiftId, _user) => {
  await getShiftById(shiftId);
  const [studentCount, employeeCount] = await Promise.all([
    Student.countDocuments({ shift: shiftId }),
    Employee.countDocuments({ shift: shiftId }),
  ]);
  const total = studentCount + employeeCount;
  if (total > 0) {
    throw new ApiError(
      httpStatus.CONFLICT,
      `Cannot delete shift: assigned to ${studentCount} student(s) and ${employeeCount} employee(s)`
    );
  }
  await Shift.findByIdAndDelete(shiftId);
};

const ASSIGNEE_PAGE_DEFAULT = 25;
const ASSIGNEE_PAGE_MAX = 100;

function idStr(value) {
  if (value == null || value === '') return '';
  if (typeof value === 'object') {
    if (value._id) return String(value._id);
    if (value.id) return String(value.id);
  }
  const s = String(value);
  return s === '[object Object]' ? '' : s;
}

function emptyAssigneeRow() {
  return {
    studentId: '',
    candidateId: '',
    employeeId: '',
    name: '',
    email: '',
    type: 'Employee',
  };
}

/** Owner user ids so dual-profile assign can write Employee.shift too. */
const ownerUserIdsFromStudents = (students = []) => [
  ...new Set(students.map((student) => idStr(student.user)).filter(Boolean)),
];

/** Last-write-wins Student.shift + linked Employee.shift. No employee doc → employee filter is null. */
const shiftAssignDualWriteFilters = (students = [], shiftId) => {
  const ownerIds = ownerUserIdsFromStudents(students);
  return {
    student: { _id: { $in: students.map((s) => s._id).filter(Boolean) } },
    employee: ownerIds.length ? { owner: { $in: ownerIds } } : null,
    update: { $set: { shift: shiftId } },
  };
};

/** One row per person. Training wins type when both profiles exist. */
const mergeShiftAssigneeRows = (students = [], employees = []) => {
  const byUserId = new Map();
  const rowFor = (key) => {
    const existing = byUserId.get(key);
    if (existing) return existing;
    const row = emptyAssigneeRow();
    byUserId.set(key, row);
    return row;
  };

  for (const student of students) {
    const userId = idStr(student.user);
    if (!userId) continue;
    const row = rowFor(userId);
    const user = student.user;
    if (user?.name) row.name = user.name;
    if (user?.email) row.email = user.email;
    const studentId = idStr(student._id) || idStr(student.id);
    if (studentId) row.studentId = studentId;
    row.type = 'Training';
  }

  for (const employee of employees) {
    const ownerId = idStr(employee.owner);
    const row = rowFor(ownerId || `employee:${idStr(employee._id) || idStr(employee.id)}`);
    if (!row.name) row.name = employee.fullName || employee.owner?.name || '';
    if (!row.email) row.email = employee.email || employee.owner?.email || '';
    if (employee.employeeId) row.employeeId = employee.employeeId;
    const candidateId = idStr(employee._id) || idStr(employee.id);
    if (candidateId) row.candidateId = candidateId;
    row.type = row.studentId ? 'Training' : 'Employee';
  }

  return [...byUserId.values()];
};

function assigneeSearchHaystack(row) {
  return [row.name, row.email, row.employeeId].join(' ').toLowerCase();
}

/** Filter + page after merge so a dual-profile person is one row. In-memory; aggregation+$facet if a shift exceeds a few thousand. */
const paginateShiftAssigneeRows = (people = [], options = {}) => {
  const limit = Math.min(Math.max(Number(options.limit) || ASSIGNEE_PAGE_DEFAULT, 1), ASSIGNEE_PAGE_MAX);
  const needle = String(options.search || '').trim().toLowerCase();
  const filtered = needle ? people.filter((row) => assigneeSearchHaystack(row).includes(needle)) : people;
  const totalResults = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / limit));
  const page = Math.min(Math.max(Number(options.page) || 1, 1), totalPages);
  return {
    people: filtered.slice((page - 1) * limit, page * limit),
    page,
    limit,
    totalResults,
    totalPages,
    count: totalResults,
  };
};

const queryShiftAssignees = async (shiftId, options = {}) => {
  await getShiftById(shiftId);
  const [students, employees] = await Promise.all([
    Student.find({ shift: shiftId }).select('user').populate('user', 'name email').lean(),
    Employee.find({ shift: shiftId })
      .select('owner fullName email employeeId')
      .populate('owner', 'name email')
      .lean(),
  ]);
  const people = mergeShiftAssigneeRows(students, employees).sort((a, b) =>
    String(a.name || '').localeCompare(String(b.name || ''))
  );
  return { shiftId, ...paginateShiftAssigneeRows(people, options) };
};

export {
  createShift,
  queryShifts,
  getShiftById,
  updateShiftById,
  deleteShiftById,
  ownerUserIdsFromStudents,
  shiftAssignDualWriteFilters,
  mergeShiftAssigneeRows,
  paginateShiftAssigneeRows,
  queryShiftAssignees,
};
