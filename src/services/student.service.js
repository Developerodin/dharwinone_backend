import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Student from '../models/student.model.js';
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
  await student.remove();
  return student;
};

export {
  registerStudent,
  queryStudents,
  getStudentById,
  getStudentByUserId,
  updateStudentById,
  deleteStudentById,
};
