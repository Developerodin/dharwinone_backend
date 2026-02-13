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
 * Query student courses (modules assigned to student)
 * @param {ObjectId} studentId
 * @param {Object} filter - Filter options (status)
 * @param {Object} options - Query options (sortBy, limit, page)
 * @returns {Promise<QueryResult>}
 */
const queryStudentCourses = async (studentId, filter, options) => {
  const { status, ...restFilter } = filter;
  
  // Find all modules where student is assigned
  const modules = await TrainingModule.find({ students: studentId });
  const moduleIds = modules.map((m) => m._id);
  
  if (moduleIds.length === 0) {
    return {
      results: [],
      page: options.page || 1,
      limit: options.limit || 10,
      totalPages: 0,
      totalResults: 0,
    };
  }
  
  // Build progress filter
  const progressFilter = {
    student: studentId,
    module: { $in: moduleIds },
    ...restFilter,
  };
  
  if (status) {
    progressFilter.status = status;
  }
  
  // Get progress records with populated module
  const progressRecords = await StudentCourseProgress.paginate(progressFilter, {
    ...options,
    populate: [
      {
        path: 'module',
        populate: [
          { path: 'categories' },
          { path: 'students', select: 'user', populate: { path: 'user', select: 'name email' } },
          { path: 'mentorsAssigned', select: 'user', populate: { path: 'user', select: 'name email' } },
        ],
      },
    ],
    sortBy: options.sortBy || 'enrolledAt:desc',
  });
  
  // Transform results to combine module + progress
  const results = progressRecords.results.map((progress) => {
    const module = progress.module;
    return {
      module: {
        id: module.id,
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
  });
  
  return {
    ...progressRecords,
    results,
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
  
  const isAssigned = module.students.some(
    (id) => id.toString() === studentId.toString()
  );
  
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
