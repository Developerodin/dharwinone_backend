import httpStatus from 'http-status';
import HolidayGroup from '../models/holidayGroup.model.js';
import Holiday from '../models/holiday.model.js';
import Student from '../models/student.model.js';
import ApiError from '../utils/ApiError.js';
import attendanceService from './attendance.service.js';

/**
 * Holiday IDs (active) whose `group` matches the given name.
 * @param {string} name
 * @returns {Promise<string[]>}
 */
const holidayIdsForGroup = async (name) => {
  const holidays = await Holiday.find({ group: name, isActive: true }).select('_id').lean();
  return holidays.map((h) => String(h._id));
};

/**
 * Attach holidayCount + memberCount to group docs.
 * @param {HolidayGroup[]} groups
 * @returns {Promise<Object[]>}
 */
const withCounts = async (groups) => {
  if (!groups.length) return [];
  const names = groups.map((g) => g.name);
  const counts = await Holiday.aggregate([
    { $match: { group: { $in: names } } },
    { $group: { _id: '$group', count: { $sum: 1 } } },
  ]);
  const countByName = new Map(counts.map((c) => [c._id, c.count]));
  return groups.map((g) => {
    const obj = typeof g.toJSON === 'function' ? g.toJSON() : g;
    const memberCount = (obj.members || []).length;
    const out = { ...obj, holidayCount: countByName.get(g.name) ?? 0, memberCount };
    delete out.members;
    return out;
  });
};

const validateStudents = async (ids) => {
  if (!ids || ids.length === 0) return [];
  const count = await Student.countDocuments({ _id: { $in: ids } });
  if (count !== ids.length) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Some members not found. Check that all training-profile IDs exist.');
  }
  return ids;
};

/**
 * Set `group = name` on the given holidays and clear it from any holiday that was in the group
 * but is no longer selected. This makes the group's date list editable from the group itself.
 * @param {string} name - group name
 * @param {string[]} holidayIds - the holidays that should belong to the group
 */
const syncGroupHolidays = async (name, holidayIds) => {
  const ids = holidayIds || [];
  if (ids.length > 0) {
    const count = await Holiday.countDocuments({ _id: { $in: ids } });
    if (count !== ids.length) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Some holidays not found. Check that all date IDs exist.');
    }
    await Holiday.updateMany({ _id: { $in: ids } }, { $set: { group: name } });
  }
  await Holiday.updateMany({ group: name, _id: { $nin: ids } }, { $set: { group: '' } });
};

/**
 * Create a holiday group.
 */
const createHolidayGroup = async (body, user) => {
  const name = body.name.trim();
  const existing = await HolidayGroup.findOne({ name });
  if (existing) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'A holiday group with this name already exists');
  }
  const members = await validateStudents(body.memberIds);
  const group = await HolidayGroup.create({
    name,
    description: body.description?.trim() ?? '',
    isActive: body.isActive !== undefined ? body.isActive : true,
    members,
    createdBy: user?.id ?? user?._id,
  });
  if (body.holidayIds !== undefined) {
    await syncGroupHolidays(name, body.holidayIds);
  }
  return group;
};

/**
 * List holiday groups (paginated) with counts.
 */
const queryHolidayGroups = async (filter, options) => {
  const result = await HolidayGroup.paginate(filter, options);
  result.results = await withCounts(result.results);
  return result;
};

/**
 * Get one group with populated members (name/email) and its holiday dates.
 */
const getHolidayGroupById = async (id) => {
  const group = await HolidayGroup.findById(id)
    .populate({ path: 'members', select: 'user', populate: { path: 'user', select: 'name email' } })
    .lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Holiday group not found');
  }
  const holidays = await Holiday.find({ group: group.name }).select('title date endDate isActive').sort({ date: 1 }).lean();
  return {
    ...group,
    holidays,
    holidayCount: holidays.length,
    memberCount: (group.members || []).length,
  };
};

/**
 * Update a group. Rename cascades to Holiday.group; memberIds replaces the member list.
 */
const updateHolidayGroupById = async (id, body) => {
  const group = await HolidayGroup.findById(id);
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Holiday group not found');
  }
  const oldName = group.name;

  if (body.name !== undefined) {
    const newName = body.name.trim();
    if (newName !== oldName) {
      const clash = await HolidayGroup.findOne({ name: newName, _id: { $ne: id } });
      if (clash) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'A holiday group with this name already exists');
      }
      group.name = newName;
      await Holiday.updateMany({ group: oldName }, { $set: { group: newName } });
    }
  }
  if (body.description !== undefined) group.description = body.description.trim();
  if (body.isActive !== undefined) group.isActive = body.isActive;
  if (body.memberIds !== undefined) {
    group.members = await validateStudents(body.memberIds);
  }

  await group.save();

  if (body.holidayIds !== undefined) {
    await syncGroupHolidays(group.name, body.holidayIds);
  }
  return group;
};

/**
 * Delete a group. Ungroups holiday dates (group set to '') and removes those dates from all
 * members' assigned holidays so dashboards and attendance stay in sync.
 */
const deleteHolidayGroupById = async (id) => {
  const group = await HolidayGroup.findById(id);
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Holiday group not found');
  }

  const studentIds = (group.members || []).map((m) => String(m));
  const holidays = await Holiday.find({ group: group.name }).select('_id').lean();
  const holidayIds = holidays.map((h) => String(h._id));

  let unassignResult = null;
  if (studentIds.length > 0 && holidayIds.length > 0) {
    unassignResult = await attendanceService.removeHolidaysFromStudents(studentIds, holidayIds, null);
  }

  const res = await Holiday.updateMany({ group: group.name }, { $set: { group: '' } });
  await HolidayGroup.findByIdAndDelete(id);
  return {
    group,
    holidaysUngrouped: res.modifiedCount ?? 0,
    membersUnassigned: studentIds.length,
    holidaysRemovedFromMembers: unassignResult?.data?.holidaysRemoved ?? 0,
  };
};

/**
 * Apply all of the group's holiday dates to all of its members.
 */
const assignGroupHolidays = async (id, user) => {
  const group = await HolidayGroup.findById(id).select('name members').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Holiday group not found');
  }
  const studentIds = (group.members || []).map((m) => String(m));
  if (studentIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group has no members. Add employees to the group first.');
  }
  const holidayIds = await holidayIdsForGroup(group.name);
  if (holidayIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group has no active holiday dates. Add dates in Holidays List first.');
  }
  return attendanceService.addHolidaysToStudents(studentIds, holidayIds, user);
};

/**
 * Remove all of the group's holiday dates from all of its members.
 */
const removeGroupHolidays = async (id, user) => {
  const group = await HolidayGroup.findById(id).select('name members').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Holiday group not found');
  }
  const studentIds = (group.members || []).map((m) => String(m));
  if (studentIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group has no members.');
  }
  const holidayIds = await holidayIdsForGroup(group.name);
  if (holidayIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group has no active holiday dates.');
  }
  return attendanceService.removeHolidaysFromStudents(studentIds, holidayIds, user);
};

export {
  createHolidayGroup,
  queryHolidayGroups,
  getHolidayGroupById,
  updateHolidayGroupById,
  deleteHolidayGroupById,
  assignGroupHolidays,
  removeGroupHolidays,
};
