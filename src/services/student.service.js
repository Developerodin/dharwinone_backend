import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Candidate from '../models/candidate.model.js';
import Student from '../models/student.model.js';
import User from '../models/user.model.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { uploadFileToS3 } from './upload.service.js';
// eslint-disable-next-line import/no-cycle
import { createUser } from './user.service.js';
import { getRoleByName } from './role.service.js';
import { getShiftById } from './shift.service.js';

/**
 * Register a new student
 * Creates both User and Student profile records
 * @param {Object} studentBody - Registration data including user fields and student profile fields
 * @param {boolean} isAdminRegistration - Whether this is an admin registering the student
 * @returns {Promise<{user: User, student: Student}>}
 */
const registerStudent = async (studentBody, isAdminRegistration = false) => {
  // Find Student role
  const studentRole = await getRoleByName('Student');
  if (!studentRole) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Student role not found. Please contact administrator.');
  }

  // Extract user fields and student profile fields
  const { phone, dateOfBirth, gender, address, education, experience, skills, documents, bio, profileImageUrl, ...userFields } = studentBody;

  // Prepare user data
  const userData = {
    ...userFields,
    roleIds: [studentRole.id], // Automatically assign Student role ID
    status: 'active', // Students are active by default
    isEmailVerified: isAdminRegistration ? true : false, // Admin registration = verified, self-registration = not verified
  };

  // Create user
  const user = await createUser(userData);

  // Prepare student profile data
  const studentData = {
    user: user.id, // Reference to Users table
    phone,
    dateOfBirth,
    gender,
    address,
    education: education || [],
    experience: experience || [],
    skills: skills || [],
    documents: documents || [],
    bio,
    profileImageUrl,
    status: 'active',
  };

  // Create student profile
  const student = await Student.create(studentData);

  return { user, student };
};

/**
 * Query for students
 * @param {Object} filter - Mongo filter (status, search)
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryStudents = async (filter, options) => {
  const { search, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };

  if (!mongoFilter.status) {
    mongoFilter.status = 'active';
  }

  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoFilter.$or = [
      { phone: { $regex: searchRegex } },
    ];
  }
  const students = await Student.paginate(mongoFilter, {
    ...options,
    populate: 'user',
  });
  return students;
};

/**
 * Get student by id
 * @param {ObjectId} id
 * @returns {Promise<Student>}
 */
const getStudentById = async (id) => {
  return Student.findById(id)
    .populate('user', 'name email role roleIds status isEmailVerified')
    .populate('shift', 'name description timezone startTime endTime isActive');
};

/**
 * Get student by user id
 * @param {ObjectId} userId
 * @returns {Promise<Student>}
 */
const getStudentByUserId = async (userId) => {
  return Student.findOne({ user: userId }).populate('user', 'name email role roleIds status isEmailVerified');
};

/**
 * Update student by id
 * @param {ObjectId} studentId
 * @param {Object} updateBody
 * @returns {Promise<Student>}
 */
const updateStudentById = async (studentId, updateBody) => {
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  Object.assign(student, updateBody);
  await student.save();
  return student;
};

/**
 * Delete student by id
 * @param {ObjectId} studentId
 * @returns {Promise<Student>}
 */
const deleteStudentById = async (studentId) => {
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  student.status = 'inactive';
  await student.save();

  const userId = student.user?._id || student.user;
  if (userId) {
    const user = await User.findById(userId);
    if (user) {
      const studentRole = await getRoleByName('Student');

      if (studentRole) {
        user.roleIds = (user.roleIds || []).filter(
          (rid) => rid.toString() !== studentRole._id.toString()
        );
      }

      user.status = 'disabled';
      await user.save();

      const Token = (await import('../models/token.model.js')).default;
      await Token.deleteMany({ user: user._id });
    }
  }

  return student;
};

/**
 * Upload and set student profile image
 * @param {ObjectId} studentId
 * @param {Express.Multer.File} file
 * @param {Object} currentUser
 * @returns {Promise<Student>}
 */
const updateStudentProfileImage = async (studentId, file, currentUser) => {
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  // Upload to S3 under dedicated folder
  const uploadResult = await uploadFileToS3(file, currentUser.id || currentUser._id, 'student-profile-images');

  student.profileImage = {
    key: uploadResult.key,
    url: uploadResult.url,
    originalName: uploadResult.originalName,
    size: uploadResult.size,
    mimeType: uploadResult.mimeType,
    uploadedAt: new Date(),
  };

  // Optionally keep legacy field in sync for older clients
  student.profileImageUrl = uploadResult.url;

  await student.save();
  return student;
};

/**
 * Get a fresh presigned URL for student profile image
 * @param {ObjectId} studentId
 * @returns {Promise<{url: string, mimeType?: string}>}
 */
const getStudentProfileImageUrl = async (studentId) => {
  const student = await getStudentById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const image = student.profileImage;
  if (!image?.key) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Profile image not found');
  }

  const url = await generatePresignedDownloadUrl(image.key, 3600);
  return {
    url,
    mimeType: image.mimeType,
  };
};

/**
 * Delete student profile by user id (cascade when user is deleted)
 * @param {ObjectId} userId
 * @returns {Promise<Student|null>} Deleted student or null if none
 */
const deleteStudentByUserId = async (userId) => {
  const student = await Student.findOne({ user: userId });
  if (!student) return null;
  await student.deleteOne();
  return student;
};

/**
 * Get or create a Student profile for attendance. Used for Candidate, Agent, and other non-admin roles
 * who need to fill attendance but may not have a Student profile yet.
 * Admins are excluded (they manage others' attendance, not their own).
 * @param {Object} user - req.user
 * @returns {Promise<Student|null>} Student or null if user is admin
 */
const getOrCreateStudentForAttendance = async (user) => {
  if (!user?.id && !user?._id) return null;
  const userId = user.id || user._id;

  const userDoc = await User.findById(userId).select('role roleIds').lean();
  if (!userDoc) return null;

  let isAdmin = userDoc.role === 'admin' || userDoc.role === 'Administrator';
  if (!isAdmin && userDoc.roleIds?.length > 0) {
    const Role = (await import('../models/role.model.js')).default;
    const adminRoles = await Role.find({ name: { $in: ['admin', 'Administrator'] }, status: 'active' }).select('_id').lean();
    const adminIds = new Set(adminRoles.map((r) => r._id.toString()));
    isAdmin = userDoc.roleIds.some((id) => id && adminIds.has(id.toString()));
  }
  if (isAdmin) return null;

  let student = await Student.findOne({ user: userId });
  if (student) {
    if (student.status === 'inactive') {
      student.status = 'active';
      await student.save();
    }
    return getStudentById(student.id);
  }

  const candidate = await Candidate.findOne({ owner: userId }).select('joiningDate').lean();
  const joiningDate = candidate?.joiningDate || null;

  student = await Student.create({
    user: userId,
    status: 'active',
    joiningDate,
  });
  return getStudentById(student.id);
};

/**
 * Ensure a Student profile exists for a user who has the Student role.
 * Creates one if missing. No-op if user lacks Student role or already has a profile.
 * @param {ObjectId} userId
 * @returns {Promise<Student|null>} Created/existing student or null
 */
const ensureStudentProfileForUser = async (userId) => {
  const studentRole = await getRoleByName('Student');
  if (!studentRole) return null;

  const user = await User.findById(userId);
  if (!user) return null;

  const hasStudentRole = (user.roleIds || []).some(
    (id) => id && id.toString() === studentRole._id.toString()
  );
  if (!hasStudentRole) return null;

  const existing = await Student.findOne({ user: userId });
  if (existing) {
    if (existing.status === 'inactive') {
      existing.status = 'active';
      await existing.save();
    }
    return existing;
  }

  const student = await Student.create({
    user: userId,
    status: 'active',
  });
  return getStudentById(student.id);
};

/**
 * Create a Student profile for an existing User who has the Student role.
 * Use this when a user was created via User Management with the Student role
 * but has no Training student profile yet (so they don't appear in course assignment).
 * @param {ObjectId} userId
 * @returns {Promise<Student>}
 */
const createStudentFromUser = async (userId) => {
  const studentRole = await getRoleByName('Student');
  if (!studentRole) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Student role not found.');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  const hasStudentRole = (user.roleIds || []).some(
    (id) => id && id.toString() === studentRole._id.toString()
  );
  if (!hasStudentRole) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'User does not have the Student role. Assign the Student role in User Management first.'
    );
  }

  const existing = await Student.findOne({ user: userId });
  if (existing) {
    if (existing.status === 'inactive') {
      existing.status = 'active';
      await existing.save();
      return getStudentById(existing.id);
    }
    throw new ApiError(httpStatus.BAD_REQUEST, 'This user already has a student profile.');
  }

  // Sync joiningDate from Candidate if user has one (attendance starts from joining date)
  const candidate = await Candidate.findOne({ owner: userId }).select('joiningDate').lean();
  const joiningDate = candidate?.joiningDate || null;

  const student = await Student.create({
    user: userId,
    status: 'active',
    joiningDate,
  });
  return getStudentById(student.id);
};

/**
 * List users who have the Student role but no Training student profile.
 * These users will not appear in course assignment until a profile is created.
 * @returns {Promise<Array<{id: string, name: string, email: string}>>}
 */
const getUsersWithStudentRoleWithoutProfile = async () => {
  const studentRole = await getRoleByName('Student');
  if (!studentRole) {
    return [];
  }

  const users = await User.find({
    roleIds: studentRole._id,
    status: 'active',
  })
    .select('_id name email')
    .lean();

  if (users.length === 0) return [];

  const userIds = users.map((u) => u._id);
  const existingStudentUserIds = await Student.find({ user: { $in: userIds } })
    .select('user')
    .lean();
  const set = new Set(existingStudentUserIds.map((s) => s.user.toString()));

  return users
    .filter((u) => !set.has(u._id.toString()))
    .map((u) => ({ id: u._id.toString(), name: u.name, email: u.email }));
};

/**
 * Update week-off days for multiple students
 * @param {Array<string>} studentIds - Array of student IDs
 * @param {Array<string>} weekOff - Array of week-off days (e.g. ['Saturday', 'Sunday'])
 * @param {Object} user - Current user (for permission check)
 * @returns {Promise<Object>}
 */
const updateWeekOffForStudents = async (studentIds, weekOff, user) => {
  if (!user) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Authentication required');
  }

  const students = await Student.find({ _id: { $in: studentIds } });
  if (students.length !== studentIds.length) {
    const foundIds = students.map((s) => String(s._id));
    const missingIds = studentIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some students not found: ${missingIds.join(', ')}`);
  }

  const weekOffToPersist = Array.isArray(weekOff) ? [...weekOff] : [];
  const updateResult = await Student.updateMany(
    { _id: { $in: studentIds } },
    { $set: { weekOff: weekOffToPersist } }
  );

  const updatedStudents = await Student.find({ _id: { $in: studentIds } }).populate('user', 'name email');
  return {
    success: true,
    message: `Week-off updated for ${updateResult.modifiedCount} student(s)`,
    data: {
      updatedCount: updateResult.modifiedCount,
      weekOff: weekOffToPersist,
      students: updatedStudents,
    },
  };
};

const VALID_WEEK_OFF_DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Bulk import week-off by candidate email (e.g. from Excel).
 * @param {Array<{ email: string, weekOff: string[] }>} entries
 * @param {Object} user - Current user (for permission)
 * @returns {Promise<{ success, message, data: { updatedCount, skipped } }>}
 */
const importWeekOffByEmail = async (entries, user) => {
  if (!user) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Authentication required');
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'At least one entry is required (email and weekOff)');
  }

  const skipped = [];
  let updatedCount = 0;
  const emails = [...new Set(entries.map((e) => String(e?.email ?? '').trim().toLowerCase()).filter(Boolean))];
  if (emails.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'No valid emails in entries');
  }

  const users = await User.find({ email: { $in: emails } }).select('_id email').lean();
  const emailToUserId = new Map(users.map((u) => [String(u.email).toLowerCase(), u._id.toString()]));
  const students = await Student.find({ user: { $in: users.map((u) => u._id) } }).select('user weekOff').lean();
  const userIdToStudent = new Map(students.map((s) => [s.user?.toString?.() ?? s.user, s]));

  for (const entry of entries) {
    const email = String(entry?.email ?? '').trim();
    if (!email) {
      skipped.push({ email: entry?.email ?? '', reason: 'Empty email' });
      continue;
    }
    const normalized = email.toLowerCase();
    const userId = emailToUserId.get(normalized);
    if (!userId) {
      skipped.push({ email, reason: 'No user found with this email' });
      continue;
    }
    const student = userIdToStudent.get(userId);
    if (!student) {
      skipped.push({ email, reason: 'User has no student profile' });
      continue;
    }
    let weekOff = Array.isArray(entry.weekOff) ? entry.weekOff : [];
    weekOff = weekOff
      .map((d) => String(d).trim())
      .filter((d) => VALID_WEEK_OFF_DAYS.includes(d));
    weekOff = [...new Set(weekOff)];

    await Student.updateOne({ _id: student._id }, { $set: { weekOff } });
    updatedCount += 1;
  }

  return {
    success: true,
    message: `Week-off updated for ${updatedCount} candidate(s)${skipped.length ? `; ${skipped.length} skipped` : ''}`,
    data: { updatedCount, skipped },
  };
};

/**
 * Get week-off days for a student
 * @param {string} studentId - Student ID
 * @returns {Promise<Object>}
 */
const getStudentWeekOff = async (studentId) => {
  const student = await Student.findById(studentId).select('weekOff').populate('user', 'name email');
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  const user = student.user || {};
  return {
    studentId: student._id,
    studentName: user.name || 'Unknown',
    studentEmail: user.email || '',
    weekOff: student.weekOff || [],
  };
};

/**
 * Assign shift to multiple students
 * @param {Array<string>} studentIds
 * @param {string} shiftId
 * @param {Object} user
 */
const assignShiftToStudents = async (studentIds, shiftId, _user) => {
  const shift = await getShiftById(shiftId);

  const students = await Student.find({ _id: { $in: studentIds } });
  if (students.length !== studentIds.length) {
    const foundIds = students.map((s) => String(s._id));
    const missingIds = studentIds.filter((id) => !foundIds.includes(String(id)));
    throw new ApiError(httpStatus.NOT_FOUND, `Some students not found: ${missingIds.join(', ')}`);
  }

  const updateResult = await Student.updateMany(
    { _id: { $in: studentIds } },
    { $set: { shift: shiftId } }
  );

  const updatedStudents = await Student.find({ _id: { $in: studentIds } })
    .populate('user', 'name email')
    .populate('shift', 'name description timezone startTime endTime isActive');

  return {
    success: true,
    message: `Shift assigned to ${updateResult.modifiedCount} student(s)`,
    data: {
      updatedCount: updateResult.modifiedCount,
      shift: {
        id: shift._id,
        name: shift.name,
        description: shift.description,
        timezone: shift.timezone,
        startTime: shift.startTime,
        endTime: shift.endTime,
        isActive: shift.isActive,
      },
      students: updatedStudents,
    },
  };
};

export {
  registerStudent,
  queryStudents,
  getStudentById,
  getStudentByUserId,
  getOrCreateStudentForAttendance,
  updateStudentById,
  deleteStudentById,
  deleteStudentByUserId,
  ensureStudentProfileForUser,
  updateStudentProfileImage,
  getStudentProfileImageUrl,
  createStudentFromUser,
  getUsersWithStudentRoleWithoutProfile,
  updateWeekOffForStudents,
  importWeekOffByEmail,
  getStudentWeekOff,
  assignShiftToStudents,
};
