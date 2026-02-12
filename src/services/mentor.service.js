import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Mentor from '../models/mentor.model.js';
import { createUser } from './user.service.js';
import { getRoleByName } from './role.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { uploadFileToS3 } from './upload.service.js';

/**
 * Register a new mentor
 * Creates both User and Mentor profile records
 * @param {Object} mentorBody - Registration data including user fields and mentor profile fields
 * @param {boolean} isAdminRegistration - Whether this is an admin registering the mentor
 * @returns {Promise<{user: User, mentor: Mentor}>}
 */
const registerMentor = async (mentorBody, isAdminRegistration = false) => {
  // Find Mentor role
  const mentorRole = await getRoleByName('Mentor');
  if (!mentorRole) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Mentor role not found. Please contact administrator.');
  }

  // Extract user fields and mentor profile fields
  const { phone, dateOfBirth, gender, address, expertise, experience, certifications, skills, bio, profileImageUrl, ...userFields } = mentorBody;

  // Prepare user data
  const userData = {
    ...userFields,
    roleIds: [mentorRole.id], // Automatically assign Mentor role ID
    status: 'active', // Mentors are active by default
    isEmailVerified: isAdminRegistration ? true : false, // Admin registration = verified, self-registration = not verified
  };

  // Create user
  const user = await createUser(userData);

  // Prepare mentor profile data
  const mentorData = {
    user: user.id, // Reference to Users table
    phone,
    dateOfBirth,
    gender,
    address,
    expertise: expertise || [],
    experience: experience || [],
    certifications: certifications || [],
    skills: skills || [],
    bio,
    profileImageUrl,
    status: 'active',
  };

  // Create mentor profile
  const mentor = await Mentor.create(mentorData);

  return { user, mentor };
};

/**
 * Query for mentors
 * @param {Object} filter - Mongo filter (status, search)
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryMentors = async (filter, options) => {
  const { search, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };
  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoFilter.$or = [
      { phone: { $regex: searchRegex } },
    ];
  }
  const mentors = await Mentor.paginate(mongoFilter, {
    ...options,
    populate: 'user',
  });
  return mentors;
};

/**
 * Get mentor by id
 * @param {ObjectId} id
 * @returns {Promise<Mentor>}
 */
const getMentorById = async (id) => {
  return Mentor.findById(id).populate('user', 'name email role roleIds status isEmailVerified');
};

/**
 * Get mentor by user id
 * @param {ObjectId} userId
 * @returns {Promise<Mentor>}
 */
const getMentorByUserId = async (userId) => {
  return Mentor.findOne({ user: userId }).populate('user', 'name email role roleIds status isEmailVerified');
};

/**
 * Update mentor by id
 * @param {ObjectId} mentorId
 * @param {Object} updateBody
 * @returns {Promise<Mentor>}
 */
const updateMentorById = async (mentorId, updateBody) => {
  const mentor = await getMentorById(mentorId);
  if (!mentor) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Mentor not found');
  }
  Object.assign(mentor, updateBody);
  await mentor.save();
  return mentor;
};

/**
 * Delete mentor by id
 * @param {ObjectId} mentorId
 * @returns {Promise<Mentor>}
 */
const deleteMentorById = async (mentorId) => {
  const mentor = await getMentorById(mentorId);
  if (!mentor) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Mentor not found');
  }
  await mentor.deleteOne();
  return mentor;
};

/**
 * Upload and set mentor profile image
 * @param {ObjectId} mentorId
 * @param {Express.Multer.File} file
 * @param {Object} currentUser
 * @returns {Promise<Mentor>}
 */
const updateMentorProfileImage = async (mentorId, file, currentUser) => {
  const mentor = await getMentorById(mentorId);
  if (!mentor) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Mentor not found');
  }

  // Upload to S3 under dedicated folder
  const uploadResult = await uploadFileToS3(file, currentUser.id || currentUser._id, 'mentor-profile-images');

  mentor.profileImage = {
    key: uploadResult.key,
    url: uploadResult.url,
    originalName: uploadResult.originalName,
    size: uploadResult.size,
    mimeType: uploadResult.mimeType,
    uploadedAt: new Date(),
  };

  // Optionally keep legacy field in sync for older clients
  mentor.profileImageUrl = uploadResult.url;

  await mentor.save();
  return mentor;
};

/**
 * Get a fresh presigned URL for mentor profile image
 * @param {ObjectId} mentorId
 * @returns {Promise<{url: string, mimeType?: string}>}
 */
const getMentorProfileImageUrl = async (mentorId) => {
  const mentor = await getMentorById(mentorId);
  if (!mentor) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Mentor not found');
  }

  const image = mentor.profileImage;
  if (!image?.key) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Profile image not found');
  }

  const url = await generatePresignedDownloadUrl(image.key, 3600);
  return {
    url,
    mimeType: image.mimeType,
  };
};

export {
  registerMentor,
  queryMentors,
  getMentorById,
  getMentorByUserId,
  updateMentorById,
  deleteMentorById,
  updateMentorProfileImage,
  getMentorProfileImageUrl,
};
