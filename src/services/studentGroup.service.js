import mongoose from 'mongoose';
import httpStatus from 'http-status';
import StudentGroup from '../models/studentGroup.model.js';
import Student from '../models/student.model.js';
import ApiError from '../utils/ApiError.js';
import { collationForSortBy } from '../utils/mongoCollation.js';
import attendanceService from './attendance.service.js';

const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const exactNameRegex = (name) => new RegExp(`^${escapeRegex(name)}$`, 'i');

const applyStudentGroupListFilter = (filter = {}) => {
  const next = { ...filter };
  if (typeof next.name === 'string') {
    const trimmed = next.name.trim();
    if (trimmed) next.name = { $regex: escapeRegex(trimmed), $options: 'i' };
    else delete next.name;
  }
  return next;
};

const assertUniqueGroupName = async (trimmedName, excludeId) => {
  const query = { name: { $regex: exactNameRegex(trimmedName) } };
  if (excludeId) query._id = { $ne: excludeId };
  const existing = await StudentGroup.findOne(query).select('_id').lean();
  if (existing) {
    throw new ApiError(httpStatus.BAD_REQUEST, `A group with the name "${trimmedName}" already exists. Use a different name.`);
  }
};

const createStudentGroup = async (groupBody, user) => {
  const { name, description, studentIds } = groupBody;

  const trimmedName = (name || '').trim();
  await assertUniqueGroupName(trimmedName);

  const idsToValidate = studentIds && studentIds.length > 0 ? studentIds : [];
  if (idsToValidate.length > 0) {
    const count = await Student.countDocuments({ _id: { $in: idsToValidate } });
    if (count !== idsToValidate.length) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Some students not found. Check that all student IDs exist.');
    }
  }

  const group = await StudentGroup.create({
    name: trimmedName,
    description,
    students: idsToValidate,
    createdBy: user._id,
    isActive: true,
  });

  await group.populate('createdBy', 'name email');
  const plain = group.toObject ? group.toObject() : group;
  plain.studentCount = (plain.students || []).length;
  delete plain.students;
  return plain;
};

const queryStudentGroups = async (filter, options) => {
  const result = await StudentGroup.paginate(applyStudentGroupListFilter(filter), {
    ...options,
    collation: collationForSortBy(options.sortBy),
  });
  if (result.results && result.results.length > 0) {
    const count = result.results.length;
    for (let i = 0; i < count; i++) {
      const doc = result.results[i];
      await doc.populate('createdBy', 'name email');
      const plain = doc.toObject ? doc.toObject() : doc;
      const studentCount = (doc.students || []).length;
      plain.studentCount = studentCount;
      delete plain.students;
      result.results[i] = plain;
    }
  }
  return result;
};

const getStudentGroupById = async (id) => {
  const group = await StudentGroup.findById(id).populate('createdBy', 'name email').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }
  const studentIds = (group.students || []).map((s) => String(s));
  group.studentCount = studentIds.length;
  group.students = studentIds;
  return group;
};

const getGroupStudents = async (groupId, query = {}) => {
  const group = await StudentGroup.findById(groupId).select('students').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }
  const studentIds = (group.students || []).map((s) => s.toString());
  const totalResults = studentIds.length;
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip = (page - 1) * limit;
  const pageIds = studentIds.slice(skip, skip + limit);
  if (pageIds.length === 0) {
    return { results: [], page, limit, totalPages: Math.ceil(totalResults / limit) || 1, totalResults };
  }
  const students = await Student.find({ _id: { $in: pageIds } })
    .populate('user', 'name email')
    .lean();
  const orderMap = new Map(pageIds.map((id, i) => [id, i]));
  students.sort((a, b) => orderMap.get(String(a._id)) - orderMap.get(String(b._id)));
  return {
    results: students,
    page,
    limit,
    totalPages: Math.ceil(totalResults / limit),
    totalResults,
  };
};

const updateStudentGroupById = async (groupId, updateBody, _user) => {
  const group = await StudentGroup.findById(groupId);
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }

  if (updateBody.name !== undefined) {
    const trimmedName = (updateBody.name || '').trim();
    await assertUniqueGroupName(trimmedName, groupId);
    updateBody.name = trimmedName;
  }

  if (updateBody.studentIds !== undefined) {
    const ids = updateBody.studentIds;
    // Prune refs to students that no longer exist — a member deleted after being
    // added would otherwise make the group permanently un-editable (surfaces in UI
    // as an "Unknown student" chip). ponytail: self-heal orphans instead of throwing.
    let validIds = ids;
    if (ids.length > 0) {
      const existing = await Student.find({ _id: { $in: ids } }).select('_id').lean();
      validIds = existing.map((s) => s._id);
    }
    group.students = validIds;
    delete updateBody.studentIds;
  }

  Object.assign(group, updateBody);
  await group.save();
  await group.populate('createdBy', 'name email');
  const plain = group.toObject ? group.toObject() : group;
  plain.studentCount = (plain.students || []).length;
  delete plain.students;
  return plain;
};

const deleteStudentGroupById = async (groupId, _user) => {
  const exists = await StudentGroup.findById(groupId).select('_id').lean();
  if (!exists) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }
  await StudentGroup.findByIdAndDelete(groupId);
};

const addStudentsToGroup = async (groupId, studentIds, _user) => {
  const count = await Student.countDocuments({ _id: { $in: studentIds } });
  if (count !== studentIds.length) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Some students not found. Check that all student IDs exist.');
  }

  const group = await StudentGroup.findById(groupId).select('students holidays').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }
  const currentIds = (group.students || []).map((s) => String(s));
  const newIds = studentIds.filter((id) => !currentIds.includes(String(id)));
  if (newIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'All students are already in the group');
  }

  const newIdsAsObjectIds = newIds.map((id) => new mongoose.Types.ObjectId(id));
  await StudentGroup.findByIdAndUpdate(groupId, { $addToSet: { students: { $each: newIdsAsObjectIds } } });

  const holidayIds = (group.holidays || []).map((h) => String(h));
  if (holidayIds.length > 0) {
    await attendanceService.addHolidaysToStudents(newIds, holidayIds, _user);
  }

  const updated = await StudentGroup.findById(groupId).populate('createdBy', 'name email').lean();
  if (updated) {
    updated.studentCount = (updated.students || []).length;
    delete updated.students;
  }
  return updated;
};

const removeStudentsFromGroup = async (groupId, studentIds, user) => {
  const idsStr = studentIds.map((id) => String(id));
  const group = await StudentGroup.findById(groupId).select('students holidays').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }
  const currentIds = (group.students || []).map((s) => String(s));
  const filtered = currentIds.filter((id) => !idsStr.includes(id));
  if (filtered.length === currentIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'None of the specified students are in the group');
  }

  const filteredObjectIds = filtered.map((id) => new mongoose.Types.ObjectId(id));
  await StudentGroup.findByIdAndUpdate(groupId, { $set: { students: filteredObjectIds } });

  const holidayIds = (group.holidays || []).map((h) => String(h));
  if (holidayIds.length > 0) {
    await attendanceService.removeHolidaysFromStudents(idsStr, holidayIds, user);
  }

  const updated = await StudentGroup.findById(groupId).populate('createdBy', 'name email').lean();
  if (updated) {
    updated.studentCount = (updated.students || []).length;
    delete updated.students;
  }
  return updated;
};

const assignHolidaysToGroup = async (groupId, holidayIds, user) => {
  const group = await StudentGroup.findById(groupId).select('students').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }
  const studentIds = (group.students || []).map((s) => String(s));
  if (studentIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group has no students');
  }
  return await attendanceService.addHolidaysToStudents(studentIds, holidayIds, user);
};

const removeHolidaysFromGroup = async (groupId, holidayIds, user) => {
  const group = await StudentGroup.findById(groupId).select('students').lean();
  if (!group) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student group not found');
  }
  const studentIds = (group.students || []).map((s) => String(s));
  if (studentIds.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Group has no students');
  }
  return await attendanceService.removeHolidaysFromStudents(studentIds, holidayIds, user);
};

export {
  applyStudentGroupListFilter,
  createStudentGroup,
  queryStudentGroups,
  getStudentGroupById,
  getGroupStudents,
  updateStudentGroupById,
  deleteStudentGroupById,
  addStudentsToGroup,
  removeStudentsFromGroup,
  assignHolidaysToGroup,
  removeHolidaysFromGroup,
};
