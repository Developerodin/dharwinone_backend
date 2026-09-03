import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import Employee from '../models/employee.model.js';
import { autoGenerateCertificateIfEligible } from './certificate.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { wrap as wrapPresignedCache } from '../utils/presignedUrlCache.js';
import { refreshTrainingCoverImageUrl } from '../utils/trainingCoverImageUrl.js';
import { queryStudentCourses } from './studentCourseQuery.service.js';
import logger from '../config/logger.js';

const signedDownloadUrl = wrapPresignedCache(generatePresignedDownloadUrl);

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
    const ownerId = student.user;
    if (ownerId) {
      const cand = await Employee.findOne({ owner: ownerId }).select('_id').lean();
      if (cand?._id) {
        const { queueSopReminderCheckForCandidate } = await import('./sopReminder.service.js');
        queueSopReminderCheckForCandidate(String(cand._id));
      }
    }
  }

  return progress;
};

const LEARN_MODULE_SELECT =
  'moduleName shortDescription coverImage categories playlist status createdAt updatedAt students';

/**
 * Slim progress payload for complete/incomplete/start (no full mongoose document).
 * @param {import('mongoose').Document} progress
 */
const toCourseProgressPayload = (progress) => ({
  progress: {
    percentage: progress.progress?.percentage ?? 0,
    completedItems: progress.progress?.completedItems ?? [],
    lastAccessedAt: progress.progress?.lastAccessedAt,
    lastAccessedItem: progress.progress?.lastAccessedItem,
  },
  status: progress.status,
  completedAt: progress.completedAt,
  startedAt: progress.startedAt,
  quizScores: progress.quizScores,
  certificate: progress.certificate,
});

/**
 * Get single student course with learn-page fields only (no roster populate, no quiz attempts).
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @returns {Promise<Object>}
 */
const getStudentCourse = async (studentId, moduleId) => {
  const [module, studentExists] = await Promise.all([
    TrainingModule.findById(moduleId)
      .select(LEARN_MODULE_SELECT)
      .populate({ path: 'categories', select: 'name description' })
      .lean(),
    Student.exists({ _id: studentId }),
  ]);

  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  if (!studentExists) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const isAssigned = (module.students || []).some((sid) => sid && sid.toString() === studentId.toString());
  if (!isAssigned) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Student is not assigned to this module');
  }

  const [progress] = await Promise.all([
    getOrCreateProgress(studentId, moduleId),
    refreshTrainingCoverImageUrl(module.coverImage, signedDownloadUrl).catch((error) => {
      logger.error('Failed to regenerate cover image URL:', error);
    }),
  ]);

  const totalsChanged = await syncProgressTotals(progress, module);
  if (totalsChanged) {
    await progress.save();
  }

  const completedIds = new Set((progress.progress.completedItems || []).map((ci) => ci.playlistItemId));
  const playlistWithProgress = (module.playlist || []).map((item, index) => {
    const itemId = index.toString();
    return {
      ...item,
      playlistItemId: itemId,
      isCompleted: completedIds.has(itemId),
    };
  });

  const categories = (module.categories || []).map((c) => ({
    id: c.id ?? (c._id != null ? String(c._id) : undefined),
    name: c.name,
    description: c.description,
  }));

  return {
    module: {
      id: module._id.toString(),
      moduleName: module.moduleName,
      shortDescription: module.shortDescription,
      coverImage: module.coverImage,
      categories,
      playlist: playlistWithProgress,
      status: module.status,
      createdAt: module.createdAt,
      updatedAt: module.updatedAt,
    },
    ...toCourseProgressPayload(progress),
    enrolledAt: progress.enrolledAt,
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
 * Recompute progress percentage and status from completedItems vs playlist length.
 * Mutates `progress`; caller must save.
 * @returns {Promise<boolean>} true if percentage or status changed
 */
const syncProgressTotals = async (progress, module) => {
  const totalItems = module?.playlist?.length ?? 0;
  const completedCount = progress.progress.completedItems.length;
  const nextPercentage = totalItems > 0 ? Math.round((completedCount / totalItems) * 100) : 0;

  let changed = progress.progress.percentage !== nextPercentage;
  progress.progress.percentage = nextPercentage;

  if (nextPercentage === 100) {
    if (progress.status !== 'completed') {
      progress.status = 'completed';
      changed = true;
    }
    if (!progress.completedAt) {
      progress.completedAt = new Date();
      changed = true;
    }
  } else if (nextPercentage > 0 && progress.status === 'enrolled') {
    progress.status = 'in-progress';
    changed = true;
  } else if (nextPercentage > 0 && nextPercentage < 100 && progress.status === 'completed') {
    progress.status = 'in-progress';
    progress.completedAt = undefined;
    changed = true;
  }

  if (changed) {
    progress.markModified('progress');
  }

  return changed;
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
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  const alreadyCompleted = progress.progress.completedItems.some(
    (item) => item.playlistItemId === playlistItemId
  );

  if (!alreadyCompleted) {
    progress.progress.completedItems.push({
      playlistItemId,
      completedAt: new Date(),
      contentType,
    });
    progress.progress.lastAccessedAt = new Date();
    progress.progress.lastAccessedItem = { playlistItemId };
  }

  const totalsChanged = await syncProgressTotals(progress, module);
  if (!alreadyCompleted || totalsChanged) {
    progress.markModified('progress');
    await progress.save();
  }

  if (progress.progress.percentage === 100 && !alreadyCompleted) {
    await autoGenerateCertificateIfEligible(studentId, moduleId);
  }

  return progress;
};

/**
 * Remove a playlist item from completedItems and recompute percentage.
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId
 * @returns {Promise<StudentCourseProgress>}
 */
const markItemIncomplete = async (studentId, moduleId, playlistItemId) => {
  const progress = await getOrCreateProgress(studentId, moduleId);
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  progress.progress.completedItems = progress.progress.completedItems.filter(
    (item) => item.playlistItemId !== playlistItemId
  );
  progress.progress.lastAccessedAt = new Date();
  progress.progress.lastAccessedItem = { playlistItemId };
  progress.markModified('progress');

  await syncProgressTotals(progress, module);
  progress.markModified('progress');
  await progress.save();

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
  markItemIncomplete,
  updateLastAccessed,
  recalculateProgress,
  toCourseProgressPayload,
};
