import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import Student from '../models/student.model.js';
import User from '../models/user.model.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { uploadFileToS3 } from './upload.service.js';
// eslint-disable-next-line import/no-cycle
import { createUser } from './user.service.js';
import { getRoleByName } from './role.service.js';
import { getShiftById } from './shift.service.js';
import { applyPersonProfileFallback, collectStudentFilterFacets, studentToPlain } from '../utils/studentProfileDisplay.js';

const STUDENT_USER_SELECT = 'name email role roleIds status isEmailVerified phoneNumber';

const overlayPersonProfiles = async (students) => {
  if (!students?.length) return [];
  const plains = students.map(studentToPlain);
  const userIds = plains
    .map((student) => student.user?.id || student.user?._id || student.user)
    .filter(Boolean);
  if (!userIds.length) {
    return plains.map((student) => applyPersonProfileFallback(student, null));
  }
  const employees = await Employee.find({ owner: { $in: userIds } })
    .select('owner phoneNumber shortBio skills qualifications degree')
    .lean();
  const byOwner = new Map(employees.map((row) => [String(row.owner), row]));
  return plains.map((student) => {
    const ownerId = student.user?.id || student.user?._id || student.user;
    return applyPersonProfileFallback(student, byOwner.get(String(ownerId)) || null);
  });
};

const serializeStudentForApi = async (student) => {
  if (!student) return student;
  const [overlaid] = await overlayPersonProfiles([student]);
  return overlaid;
};

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

const EXPORT_MAX_ROWS = 10000;

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseStringList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  return String(value)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
};

const buildExperienceYearsExpr = () => ({
  $round: [
    {
      $reduce: {
        input: { $ifNull: ['$experience', []] },
        initialValue: 0,
        in: {
          $add: [
            '$$value',
            {
              $cond: [
                { $ne: ['$$this.startDate', null] },
                {
                  $let: {
                    vars: {
                      endDate: {
                        $cond: [
                          { $eq: ['$$this.isCurrent', true] },
                          { $ifNull: ['$$this.endDate', '$$NOW'] },
                          '$$this.endDate',
                        ],
                      },
                    },
                    in: {
                      $cond: [
                        { $ne: ['$$endDate', null] },
                        {
                          $max: [
                            0,
                            {
                              $divide: [
                                { $subtract: ['$$endDate', '$$this.startDate'] },
                                31557600000,
                              ],
                            },
                          ],
                        },
                        0,
                      ],
                    },
                  },
                },
                0,
              ],
            },
          ],
        },
      },
    },
    0,
  ],
});

const mergeUserIdFilter = (mongoFilter, userIds) => {
  if (!userIds.length) {
    mongoFilter.user = { $in: [] };
    return;
  }
  if (mongoFilter.user?.$in) {
    const allowed = new Set(userIds.map(String));
    const narrowed = mongoFilter.user.$in.filter((id) => allowed.has(String(id)));
    mongoFilter.user = narrowed.length ? { $in: narrowed } : { $in: [] };
    return;
  }
  if (mongoFilter.user?.$nin) {
    const blocked = new Set(mongoFilter.user.$nin.map(String));
    const allowed = userIds.filter((id) => !blocked.has(String(id)));
    mongoFilter.user = allowed.length ? { $in: allowed } : { $in: [] };
    return;
  }
  mongoFilter.user = { ...(mongoFilter.user || {}), $in: userIds };
};

/**
 * Build Mongo filter for student list queries.
 * @param {Object} filter
 * @returns {Promise<Object>}
 */
const buildStudentMongoFilter = async (filter) => {
  const {
    search,
    position,
    employeeRoleOnly,
    studentRoleOnly,
    excludeResignedEmployed,
    status,
    names,
    skills,
    education,
    email,
    experienceMin,
    experienceMax,
    ...restFilter
  } = filter;
  const mongoFilter = { ...restFilter };
  if (position) mongoFilter.position = position;
  delete mongoFilter.status;

  const truthy = (v) => v === true || v === 'true' || v === '1' || v === 1;

  if (status === 'all') {
    // no status constraint
  } else if (status === 'inactive') {
    mongoFilter.status = 'inactive';
  } else {
    mongoFilter.status = 'active';
  }

  const nameFilters = parseStringList(names);
  const skillFilters = parseStringList(skills);
  const educationFilters = parseStringList(education);
  const emailFilters = parseStringList(email);

  if (nameFilters.length) {
    const matchingUsers = await User.find({
      $or: nameFilters.map((name) => ({
        name: { $regex: escapeRegex(name), $options: 'i' },
      })),
    })
      .select('_id')
      .lean();
    mergeUserIdFilter(
      mongoFilter,
      matchingUsers.map((u) => u._id)
    );
  }

  if (emailFilters.length) {
    const matchingUsers = await User.find({
      $or: emailFilters.map((value) => ({
        email: { $regex: escapeRegex(value), $options: 'i' },
      })),
    })
      .select('_id')
      .lean();
    mergeUserIdFilter(
      mongoFilter,
      matchingUsers.map((u) => u._id)
    );
  }

  if (skillFilters.length) {
    const skillClauses = skillFilters.map((skill) => {
      const regex = { $regex: escapeRegex(skill), $options: 'i' };
      return { $or: [{ skills: regex }, { 'skills.name': regex }] };
    });
    // Facets/rows overlay Candidate (Employee) skills when Student.skills is empty.
    // Match that displayed set: Student.skills OR (empty Student.skills AND Employee.skills).
    const matchingEmployees = await Employee.find({
      $and: skillFilters.map((skill) => ({
        'skills.name': { $regex: escapeRegex(skill), $options: 'i' },
      })),
    })
      .select('owner')
      .lean();
    const overlayOwnerIds = matchingEmployees.map((row) => row.owner).filter(Boolean);
    if (overlayOwnerIds.length) {
      const studentSkillsMatch =
        skillClauses.length === 1 ? skillClauses[0] : { $and: skillClauses };
      mongoFilter.$and = [
        ...(mongoFilter.$and || []),
        {
          $or: [
            studentSkillsMatch,
            {
              $and: [
                { user: { $in: overlayOwnerIds } },
                { $or: [{ skills: { $exists: false } }, { skills: { $size: 0 } }] },
              ],
            },
          ],
        },
      ];
    } else {
      mongoFilter.$and = [...(mongoFilter.$and || []), ...skillClauses];
    }
  }

  if (educationFilters.length) {
    const educationClauses = educationFilters.map((edu) => ({
      $or: [
        { 'education.degree': { $regex: escapeRegex(edu), $options: 'i' } },
        { 'education.institution': { $regex: escapeRegex(edu), $options: 'i' } },
        { 'education.institute': { $regex: escapeRegex(edu), $options: 'i' } },
        { 'education.fieldOfStudy': { $regex: escapeRegex(edu), $options: 'i' } },
      ],
    }));
    mongoFilter.$and = [...(mongoFilter.$and || []), { $or: educationClauses }];
  }

  const minExp = experienceMin != null && experienceMin !== '' ? Number(experienceMin) : null;
  const maxExp = experienceMax != null && experienceMax !== '' ? Number(experienceMax) : null;
  if (Number.isFinite(minExp) || Number.isFinite(maxExp)) {
    const experienceClauses = [];
    const yearsExpr = buildExperienceYearsExpr();
    if (Number.isFinite(minExp)) {
      experienceClauses.push({ $gte: [yearsExpr, minExp] });
    }
    if (Number.isFinite(maxExp)) {
      experienceClauses.push({ $lte: [yearsExpr, maxExp] });
    }
    mongoFilter.$expr = {
      $and: [...(mongoFilter.$expr?.$and || []), ...experienceClauses],
    };
  }

  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    const [matchingUsers, matchingCandidatesByEmployeeId] = await Promise.all([
      User.find({
        $or: [{ name: { $regex: searchRegex } }, { email: { $regex: searchRegex } }],
      })
        .select('_id')
        .lean(),
      Employee.find({ employeeId: { $regex: searchRegex } })
        .select('owner')
        .lean(),
    ]);
    const matchingUserIds = new Set();
    matchingUsers.forEach((u) => matchingUserIds.add(u._id.toString()));
    matchingCandidatesByEmployeeId.forEach((c) => {
      if (c.owner) matchingUserIds.add(c.owner.toString());
    });
    const userIdsArray = Array.from(matchingUserIds);
    mongoFilter.$or = [
      { phone: { $regex: searchRegex } },
      ...(userIdsArray.length > 0 ? [{ user: { $in: userIdsArray } }] : []),
    ];
  }

  if (truthy(employeeRoleOnly)) {
    const employeeRole = await getRoleByName('Employee');
    if (!employeeRole) {
      mongoFilter.user = { $in: [] };
    } else {
      const roleScopedUsers = await User.find({
        roleIds: employeeRole._id,
        status: { $in: ['active', 'pending'] },
      })
        .select('_id')
        .lean();
      const allowedUserIds = roleScopedUsers.map((u) => u._id);
      mongoFilter.user = allowedUserIds.length ? { $in: allowedUserIds } : { $in: [] };
    }
  }

  if (truthy(studentRoleOnly)) {
    const studentRole = await getRoleByName('Student');
    if (!studentRole) {
      mergeUserIdFilter(mongoFilter, []);
    } else if (status === 'inactive') {
      // Deactivated students lose the Student role; rely on student.status only.
    } else if (status === 'all') {
      const roleScopedUsers = await User.find({
        roleIds: studentRole._id,
        status: { $in: ['active', 'pending'] },
      })
        .select('_id')
        .lean();
      const roleUserIds = roleScopedUsers.map((u) => u._id);
      const roleScopeClause = {
        $or: [
          { status: 'inactive' },
          ...(roleUserIds.length > 0 ? [{ user: { $in: roleUserIds } }] : [{ user: { $in: [] } }]),
        ],
      };
      mongoFilter.$and = [...(mongoFilter.$and || []), roleScopeClause];
    } else {
      const roleScopedUsers = await User.find({
        roleIds: studentRole._id,
        status: { $in: ['active', 'pending'] },
      })
        .select('_id')
        .lean();
      mergeUserIdFilter(
        mongoFilter,
        roleScopedUsers.map((u) => u._id)
      );
    }
  }

  if (truthy(excludeResignedEmployed)) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const resignedRows = await Employee.find({
      owner: { $exists: true, $ne: null },
      $or: [
        { referralPipelineStatus: 'resigned' },
        { resignDate: { $exists: true, $ne: null, $lte: todayStart } },
      ],
    })
      .select('owner')
      .lean();
    const resignedUserIds = resignedRows.map((r) => r.owner).filter(Boolean);
    if (resignedUserIds.length) {
      const blocked = new Set(resignedUserIds.map(String));
      if (mongoFilter.user?.$in) {
        const narrowed = mongoFilter.user.$in.filter((id) => !blocked.has(String(id)));
        mongoFilter.user = narrowed.length ? { $in: narrowed } : { $in: [] };
      } else {
        mongoFilter.user = { ...(mongoFilter.user || {}), $nin: resignedUserIds };
      }
    }
  }

  return mongoFilter;
};

const parseStudentSortBy = (sortBy) => {
  const raw = sortBy || 'createdAt:desc';
  const [field, direction = 'asc'] = raw.split(':');
  return {
    field,
    order: direction === 'desc' ? -1 : 1,
  };
};

const hydrateStudentsInOrder = async (studentDocs) => {
  if (!studentDocs.length) return [];

  const ids = studentDocs.map((doc) => doc._id);
  const order = new Map(ids.map((id, index) => [id.toString(), index]));
  const students = await Student.find({ _id: { $in: ids } })
    .populate('user', STUDENT_USER_SELECT)
    .populate('shift', 'name description timezone startTime endTime isActive')
    .populate('position', 'name');

  const ordered = students.sort((left, right) => order.get(left.id) - order.get(right.id));
  return overlayPersonProfiles(ordered);
};

const getAggregationSortKey = (sortField) => {
  if (sortField === 'name') return '_userNameLower';
  if (sortField === 'education') return '_educationSortKey';
  if (sortField === 'skills') return '_skillsSortKey';
  return '_userNameLower';
};

const queryStudentsWithJoinSort = async (mongoFilter, options, sortField, sortOrder) => {
  const limit = options.limit && parseInt(options.limit, 10) > 0 ? parseInt(options.limit, 10) : 10;
  const page = options.page && parseInt(options.page, 10) > 0 ? parseInt(options.page, 10) : 1;
  const skip = (page - 1) * limit;
  const sortKey = getAggregationSortKey(sortField);

  const [facetResult] = await Student.aggregate([
    { $match: mongoFilter },
    {
      $lookup: {
        from: 'users',
        localField: 'user',
        foreignField: '_id',
        as: '_userDoc',
      },
    },
    { $unwind: { path: '$_userDoc', preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        _userNameLower: { $toLower: { $ifNull: ['$_userDoc.name', ''] } },
        _educationSortKey: {
          $toLower: {
            $let: {
              vars: { edu: { $ifNull: [{ $arrayElemAt: ['$education', 0] }, {}] } },
              in: {
                $trim: {
                  input: {
                    $concat: [
                      { $ifNull: ['$$edu.degree', ''] },
                      {
                        $cond: [
                          {
                            $and: [
                              { $gt: [{ $strLenCP: { $ifNull: ['$$edu.degree', ''] } }, 0] },
                              { $gt: [{ $strLenCP: { $ifNull: ['$$edu.institution', ''] } }, 0] },
                            ],
                          },
                          ' - ',
                          '',
                        ],
                      },
                      { $ifNull: ['$$edu.institution', ''] },
                    ],
                  },
                },
              },
            },
          },
        },
        _skillsSortKey: {
          $toLower: {
            $reduce: {
              input: {
                $sortArray: {
                  input: {
                    $filter: {
                      input: { $ifNull: ['$skills', []] },
                      as: 'skill',
                      cond: { $gt: [{ $strLenCP: { $trim: { input: '$$skill' } } }, 0] },
                    },
                  },
                  sortBy: 1,
                },
              },
              initialValue: '',
              in: {
                $cond: [
                  { $eq: ['$$value', ''] },
                  { $trim: { input: '$$this' } },
                  {
                    $concat: ['$$value', ', ', { $trim: { input: '$$this' } }],
                  },
                ],
              },
            },
          },
        },
      },
    },
    { $sort: { [sortKey]: sortOrder, _id: 1 } },
    {
      $facet: {
        metadata: [{ $count: 'totalResults' }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    },
  ]);

  const totalResults = facetResult?.metadata?.[0]?.totalResults ?? 0;
  const totalPages = Math.ceil(totalResults / limit) || 0;
  const results = await hydrateStudentsInOrder(facetResult?.data ?? []);

  return {
    results,
    page,
    limit,
    totalPages,
    totalResults,
  };
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
  const mongoFilter = await buildStudentMongoFilter(filter);
  const { field, order } = parseStudentSortBy(options?.sortBy);

  if (field === 'name' || field === 'education' || field === 'skills') {
    return queryStudentsWithJoinSort(mongoFilter, options, field, order);
  }

  const result = await Student.paginate(mongoFilter, {
    ...options,
    populate: [
      { path: 'user', select: STUDENT_USER_SELECT },
      'position',
      'shift',
    ],
  });
  result.results = await overlayPersonProfiles(result.results);
  return result;
};

const computeExperienceYears = (experience = []) =>
  Math.round(
    experience.reduce((total, exp) => {
      if (!exp.startDate || !exp.endDate) return total;
      const start = new Date(exp.startDate);
      const end = new Date(exp.endDate);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return total;
      const years = (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
      return total + Math.max(0, years);
    }, 0)
  );

/**
 * Distinct filter option values for the students sidebar.
 * @param {Object} filter
 */
const getStudentFilterOptions = async (filter = {}) => {
  const mongoFilter = await buildStudentMongoFilter(filter);
  const students = await Student.find(mongoFilter)
    .populate('user', 'name email')
    .select('skills education experience user')
    .lean();

  const overlaid = await overlayPersonProfiles(students);
  const facets = collectStudentFilterFacets(overlaid);
  const experiences = students.map((student) => computeExperienceYears(student.experience || []));
  const min = experiences.length ? Math.min(...experiences) : 0;
  const max = experiences.length ? Math.max(...experiences) : 50;

  return {
    ...facets,
    experience: { min, max },
  };
};

/**
 * Export students with the same filters/sort as the list view, capped for safety.
 */
const queryStudentsForExport = async (filter, options = {}) => {
  const firstPage = await queryStudents(filter, {
    ...options,
    page: 1,
    limit: EXPORT_MAX_ROWS,
  });
  const capped = firstPage.totalResults > EXPORT_MAX_ROWS;
  return {
    results: firstPage.results,
    totalResults: firstPage.totalResults,
    capped,
    exportMax: EXPORT_MAX_ROWS,
  };
};

/**
 * Get student by id
 * @param {ObjectId} id
 * @returns {Promise<Student>}
 */
const getStudentById = async (id) => {
  return Student.findById(id)
    .populate('user', STUDENT_USER_SELECT)
    .populate('shift', 'name description timezone startTime endTime isActive')
    .populate('position', 'name');
};

/**
 * Get student by user id
 * @param {ObjectId} userId
 * @returns {Promise<Student>}
 */
const getStudentByUserId = async (userId) => {
  return Student.findOne({ user: userId }).populate('user', STUDENT_USER_SELECT);
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
  if (image?.key) {
    const url = await generatePresignedDownloadUrl(image.key, 3600);
    return {
      url,
      mimeType: image.mimeType,
    };
  }

  const legacyUrl = student.profileImageUrl || image?.url;
  if (legacyUrl) {
    return { url: legacyUrl };
  }

  return null;
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

  let isAdmin = false;
  if (userDoc.roleIds?.length > 0) {
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

  const candidate = await Employee.findOne({ owner: userId }).select('joiningDate').lean();
  const joiningDate = candidate?.joiningDate || null;

  student = await Student.create({
    user: userId,
    status: 'active',
    joiningDate,
  });
  return getStudentById(student.id);
};

/**
 * Get attendance identity for the current user. Used by GET /training/attendance/me.
 * - Admins: null (no self-attendance).
 * - User has a Student: returns that Student (or creates one for Candidate/Student role via getOrCreateStudentForAttendance).
 * - User has no Student and is Agent: returns user identity only { type: 'user', id, user } — no Student created.
 * @param {Object} user - req.user
 * @returns {Promise<{ type: 'student' } & import('./student.model.js').default|null|{ type: 'user', id: string, user: { id: string, name: string, email: string } }>}
 */
const getAttendanceIdentity = async (user) => {
  const userId = user?._id ?? user?.id;
  if (!userId) return null;

  const userDoc = await User.findById(userId).select('roleIds name email').lean();
  if (!userDoc) return null;

  // Admin detection uses ONLY roleIds (RBAC), not the legacy `role` field.
  let isAdmin = false;
  if (userDoc.roleIds?.length > 0) {
    const Role = (await import('../models/role.model.js')).default;
    const adminRoles = await Role.find({ name: { $in: ['admin', 'Administrator'] }, status: 'active' }).select('_id').lean();
    const adminIds = new Set(adminRoles.map((r) => r._id.toString()));
    isAdmin = userDoc.roleIds.some((id) => id && adminIds.has(id.toString()));
  }
  if (isAdmin) return null;

  const student = await Student.findOne({ user: userId });
  if (student) {
    if (student.status === 'inactive') {
      student.status = 'active';
      await student.save();
    }
    return getStudentById(student.id);
  }

  const employee = await Employee.findOne({ owner: userId }).select('_id').lean();
  if (employee) {
    const created = await getOrCreateStudentForAttendance(user);
    if (created) return created;
  }

  // No Student: return user-based identity so agents can use /me APIs without creating a Student.
  return {
    type: 'user',
    id: userId.toString(),
    user: {
      id: userId.toString(),
      name: userDoc.name ?? '',
      email: userDoc.email ?? '',
    },
  };
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
 * @param {{ ensureStudentRoleForCandidateOwner?: boolean }} [options]
 * @returns {Promise<Student>}
 */
const createStudentFromUser = async (userId, options = {}) => {
  const { ensureStudentRoleForCandidateOwner = false } = options;
  const studentRole = await getRoleByName('Student');
  if (!studentRole) {
    throw new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Student role not found.');
  }

  const user = await User.findById(userId);
  if (!user) {
    throw new ApiError(httpStatus.NOT_FOUND, 'User not found');
  }

  let hasStudentRole = (user.roleIds || []).some(
    (id) => id && id.toString() === studentRole._id.toString()
  );
  if (!hasStudentRole && ensureStudentRoleForCandidateOwner) {
    const ownsCandidate = await Employee.exists({ owner: userId });
    if (!ownsCandidate) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        'User does not have the Student role. Assign the Student role in User Management first.'
      );
    }
    await User.updateOne({ _id: userId }, { $addToSet: { roleIds: studentRole._id } });
    hasStudentRole = true;
  }
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
  const candidate = await Employee.findOne({ owner: userId }).select('joiningDate').lean();
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
  buildStudentMongoFilter,
  queryStudents,
  getStudentFilterOptions,
  queryStudentsForExport,
  EXPORT_MAX_ROWS,
  getStudentById,
  getStudentByUserId,
  serializeStudentForApi,
  getOrCreateStudentForAttendance,
  getAttendanceIdentity,
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
