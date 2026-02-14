import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Student from '../models/student.model.js';
import User from '../models/user.model.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { uploadFileToS3 } from './upload.service.js';
import { createUser } from './user.service.js';
import { getRoleByName } from './role.service.js';

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
  return Student.findById(id).populate('user', 'name email role roleIds status isEmailVerified');
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
  await student.deleteOne();
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
    throw new ApiError(httpStatus.BAD_REQUEST, 'This user already has a student profile.');
  }

  const student = await Student.create({
    user: userId,
    status: 'active',
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

export {
  registerStudent,
  queryStudents,
  getStudentById,
  getStudentByUserId,
  updateStudentById,
  deleteStudentById,
  updateStudentProfileImage,
  getStudentProfileImageUrl,
  createStudentFromUser,
  getUsersWithStudentRoleWithoutProfile,
};
