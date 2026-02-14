import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';
import { autoGenerateCertificateIfEligible } from './certificate.service.js';

/**
 * Get or create student course progress
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<StudentCourseProgress>}
 */
const getOrCreateProgress = async (studentId, moduleId) => {
  let progress = await StudentCourseProgress.findOne({ student: studentId, module: moduleId });
  
  if (!progress) {
    // Verify student is assigned to this module
    const module = await TrainingModule.findById(moduleId);
    if (!module) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
    }
    
    const student = await Student.findById(studentId);
    if (!student) {
      throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
    }
    
    // Check if student is assigned to module
    const isAssigned = module.students.some(
      (id) => id.toString() === studentId.toString()
    );
    
    if (!isAssigned) {
      throw new ApiError(httpStatus.FORBIDDEN, 'Student is not assigned to this module');
    }
    
    // Create progress record
    progress = await StudentCourseProgress.create({
      student: studentId,
      module: moduleId,
      enrolledAt: new Date(),
    });
  }
  
  return progress;
};

/**
 * Default progress for a module when student has no progress record yet (so assigned courses still show in list).
 */
const defaultProgressRow = (moduleId) => ({
  progress: { percentage: 0, completedItems: [], lastAccessedAt: null, lastAccessedItem: null },
  quizScores: { totalQuizzes: 0, completedQuizzes: 0, averageScore: 0, totalScore: 0 },
  enrolledAt: new Date(),
  startedAt: null,
  completedAt: null,
  status: 'enrolled',
  certificate: { issued: false, issuedAt: null, certificateId: null, certificateUrl: null },
});

/**
 * Query student courses (all modules assigned to student, with or without progress).
 * Ensures data is visible on the candidate "My Courses" list even before they start a course.
 * @param {ObjectId} studentId
 * @param {Object} filter - Filter options (status)
 * @param {Object} options - Query options (sortBy, limit, page)
 * @returns {Promise<QueryResult>}
 */
const queryStudentCourses = async (studentId, filter, options) => {
  const { status } = filter;
  const limit = Math.min(Number(options.limit) || 10, 100);
  const page = Number(options.page) || 1;
  const sortBy = options.sortBy || 'enrolledAt:desc';

  // Find all modules where student is assigned (with full populate)
  const modules = await TrainingModule.find({ students: studentId })
    .populate('categories')
    .populate({ path: 'students', select: 'user', populate: { path: 'user', select: 'name email' } })
    .populate({ path: 'mentorsAssigned', select: 'user', populate: { path: 'user', select: 'name email' } })
    .lean();

  if (modules.length === 0) {
    return {
      results: [],
      page,
      limit,
      totalPages: 0,
      totalResults: 0,
    };
  }

  const moduleIds = modules.map((m) => m._id);
  const progressList = await StudentCourseProgress.find({
    student: studentId,
    module: { $in: moduleIds },
  }).lean();

  const progressByModule = new Map();
  progressList.forEach((p) => progressByModule.set(p.module.toString(), p));

  // Build one result per module (progress or default)
  let results = modules.map((module) => {
    const progress = progressByModule.get(module._id.toString());
    if (progress) {
      return {
        module: {
          id: module._id.toString(),
          moduleName: module.moduleName,
          shortDescription: module.shortDescription,
          coverImage: module.coverImage,
          categories: module.categories,
          playlist: module.playlist,
          status: module.status,
          createdAt: module.createdAt,
          updatedAt: module.updatedAt,
        },
        progress: {
          percentage: progress.progress?.percentage ?? 0,
          completedItems: progress.progress?.completedItems ?? [],
          lastAccessedAt: progress.progress?.lastAccessedAt,
          lastAccessedItem: progress.progress?.lastAccessedItem,
        },
        quizScores: progress.quizScores ?? {},
        enrolledAt: progress.enrolledAt,
        startedAt: progress.startedAt,
        completedAt: progress.completedAt,
        status: progress.status || 'enrolled',
        certificate: progress.certificate ?? { issued: false, issuedAt: null, certificateId: null, certificateUrl: null },
      };
    }
    return {
      module: {
        id: module._id.toString(),
        moduleName: module.moduleName,
        shortDescription: module.shortDescription,
        coverImage: module.coverImage,
        categories: module.categories,
        playlist: module.playlist,
        status: module.status,
        createdAt: module.createdAt,
        updatedAt: module.updatedAt,
      },
      ...defaultProgressRow(module._id),
    };
  });

  // Filter by status if provided
  if (status) {
    results = results.filter((r) => r.status === status);
  }

  // Sort: by lastAccessedAt desc, then enrolledAt desc, then by module name
  const [sortField, sortOrder] = (sortBy || 'enrolledAt:desc').split(':');
  const desc = sortOrder === 'desc';
  results.sort((a, b) => {
    const aVal = sortField === 'enrolledAt' ? (a.enrolledAt ? new Date(a.enrolledAt).getTime() : 0) : (a.progress?.lastAccessedAt ? new Date(a.progress.lastAccessedAt).getTime() : 0);
    const bVal = sortField === 'enrolledAt' ? (b.enrolledAt ? new Date(b.enrolledAt).getTime() : 0) : (b.progress?.lastAccessedAt ? new Date(b.progress.lastAccessedAt).getTime() : 0);
    if (aVal !== bVal) return desc ? bVal - aVal : aVal - bVal;
    const aName = a.module.moduleName || '';
    const bName = b.module.moduleName || '';
    return aName.localeCompare(bName);
  });

  const totalResults = results.length;
  const totalPages = Math.ceil(totalResults / limit) || 1;
  const start = (page - 1) * limit;
  const paginatedResults = results.slice(start, start + limit);

  return {
    results: paginatedResults,
    page,
    limit,
    totalPages,
    totalResults,
  };
};

/**
 * Get single student course with full details
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<Object>}
 */
const getStudentCourse = async (studentId, moduleId) => {
  // Verify student is assigned to module
  const module = await TrainingModule.findById(moduleId).populate([
    { path: 'categories' },
    { path: 'students', select: 'user', populate: { path: 'user', select: 'name email' } },
    { path: 'mentorsAssigned', select: 'user', populate: { path: 'user', select: 'name email' } },
  ]);
  
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  
  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  
  // When populated, module.students are documents with _id; when not, they are ObjectIds
  const isAssigned = module.students.some((s) => {
    const sid = s && (s._id != null ? s._id : s);
    return sid && sid.toString() === studentId.toString();
  });

  if (!isAssigned) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Student is not assigned to this module');
  }
  
  // Get or create progress
  const progress = await getOrCreateProgress(studentId, moduleId);
  
  // Get quiz attempts for this course
  const quizAttempts = await StudentQuizAttempt.find({
    student: studentId,
    module: moduleId,
  }).sort({ createdAt: -1 });
  
  // Mark which playlist items are completed
  const playlistWithProgress = module.playlist.map((item, index) => {
    const itemId = index.toString();
    const isCompleted = progress.progress.completedItems.some(
      (ci) => ci.playlistItemId === itemId
    );
    
    // Get quiz attempts for this item
    const itemQuizAttempts = quizAttempts.filter(
      (qa) => qa.playlistItemId === itemId
    );
    
    return {
      ...item.toObject(),
      playlistItemId: itemId,
      isCompleted,
      quizAttempts: item.contentType === 'quiz' ? itemQuizAttempts : undefined,
    };
  });
  
  return {
    module: {
      id: module.id,
      moduleName: module.moduleName,
      shortDescription: module.shortDescription,
      coverImage: module.coverImage,
      categories: module.categories,
      playlist: playlistWithProgress,
      status: module.status,
      createdAt: module.createdAt,
      updatedAt: module.updatedAt,
    },
    progress: {
      percentage: progress.progress.percentage,
      completedItems: progress.progress.completedItems,
      lastAccessedAt: progress.progress.lastAccessedAt,
      lastAccessedItem: progress.progress.lastAccessedItem,
    },
    quizScores: progress.quizScores,
    enrolledAt: progress.enrolledAt,
    startedAt: progress.startedAt,
    completedAt: progress.completedAt,
    status: progress.status,
    certificate: progress.certificate,
  };
};

/**
 * Start course (set startedAt if not already started)
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<StudentCourseProgress>}
 */
const startCourse = async (studentId, moduleId) => {
  const progress = await getOrCreateProgress(studentId, moduleId);
  
  if (!progress.startedAt) {
    progress.startedAt = new Date();
    progress.status = 'in-progress';
    progress.progress.lastAccessedAt = new Date();
    await progress.save();
  }
  
  return progress;
};

/**
 * Mark playlist item as complete
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId - Index or ID of playlist item
 * @param {string} contentType - Type of content
 * @returns {Promise<StudentCourseProgress>}
 */
const markItemComplete = async (studentId, moduleId, playlistItemId, contentType) => {
  const progress = await getOrCreateProgress(studentId, moduleId);
  
  // Check if already completed
  const alreadyCompleted = progress.progress.completedItems.some(
    (item) => item.playlistItemId === playlistItemId
  );
  
  if (!alreadyCompleted) {
    progress.progress.completedItems.push({
      playlistItemId,
      completedAt: new Date(),
      contentType,
    });
    
    // Get module to calculate total items
    const module = await TrainingModule.findById(moduleId);
    const totalItems = module.playlist.length;
    const completedCount = progress.progress.completedItems.length;
    
    // Calculate progress percentage
    progress.progress.percentage = Math.round((completedCount / totalItems) * 100);
    
    // Update status
    if (progress.progress.percentage === 100) {
      progress.status = 'completed';
      progress.completedAt = new Date();
    } else if (progress.progress.percentage > 0) {
      progress.status = 'in-progress';
    }
    
    progress.progress.lastAccessedAt = new Date();
    progress.progress.lastAccessedItem = { playlistItemId };
    
    await progress.save();
    
    // Auto-generate certificate if course is 100% complete
    if (progress.progress.percentage === 100) {
      await autoGenerateCertificateIfEligible(studentId, moduleId);
    }
  }
  
  return progress;
};

/**
 * Update last accessed item
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId
 * @returns {Promise<StudentCourseProgress>}
 */
const updateLastAccessed = async (studentId, moduleId, playlistItemId) => {
  const progress = await getOrCreateProgress(studentId, moduleId);
  
  progress.progress.lastAccessedAt = new Date();
  progress.progress.lastAccessedItem = { playlistItemId };
  
  await progress.save();
  
  return progress;
};

/**
 * Recalculate progress percentage (useful after module updates)
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<StudentCourseProgress>}
 */
const recalculateProgress = async (studentId, moduleId) => {
  const progress = await StudentCourseProgress.findOne({ student: studentId, module: moduleId });
  
  if (!progress) {
    return null;
  }
  
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    return progress;
  }
  
  const totalItems = module.playlist.length;
  const completedCount = progress.progress.completedItems.length;
  
  progress.progress.percentage = totalItems > 0 
    ? Math.round((completedCount / totalItems) * 100)
    : 0;
  
  // Update status based on percentage
  if (progress.progress.percentage === 100 && !progress.completedAt) {
    progress.status = 'completed';
    progress.completedAt = new Date();
  } else if (progress.progress.percentage > 0 && progress.status === 'enrolled') {
    progress.status = 'in-progress';
  }
  
  await progress.save();
  
  return progress;
};

export {
  getOrCreateProgress,
  queryStudentCourses,
  getStudentCourse,
  startCourse,
  markItemComplete,
  updateLastAccessed,
  recalculateProgress,
};
