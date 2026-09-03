import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import Mentor from '../models/mentor.model.js';
import Category from '../models/category.model.js';
import User from '../models/user.model.js';
import * as studentService from './student.service.js';
import { uploadFileToS3 } from './upload.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';
import { wrap as wrapPresignedCache } from '../utils/presignedUrlCache.js';
import logger from '../config/logger.js';
import { hasApiPermissionFromContext } from '../utils/permissionCheck.js';

const signedDownloadUrl = wrapPresignedCache(generatePresignedDownloadUrl);

// Heavy fields excluded from list-view payload — saves megabytes per response.
// Detail view (getTrainingModuleById) still returns the full doc.
const LIST_EXCLUDE_FIELDS = [
  '-playlist.videoFile',
  '-playlist.pdfDocument',
  '-playlist.blogContent',
  '-playlist.quiz',
  '-playlist.essay',
  '-playlist.testLinkOrReference',
].join(' ');

/**
 * Resolve category query (ObjectId or display name) to a category _id.
 * @param {string} category
 * @returns {Promise<string|import('mongoose').Types.ObjectId|null>}
 */
const resolveCategoryId = async (category) => {
  if (!category) return null;
  const raw = String(category).trim();
  if (/^[a-fA-F0-9]{24}$/.test(raw)) return raw;
  const doc = await Category.findOne({ name: raw }).select('_id').lean();
  return doc?._id ?? null;
};

/**
 * Mentor ids whose linked user name equals the instructor chip label.
 * @param {string} instructor
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
const mentorIdsForInstructorName = async (instructor) => {
  const name = String(instructor || '').trim();
  if (!name) return [];
  const users = await User.find({ name }).select('_id').lean();
  if (!users.length) return [];
  const mentors = await Mentor.find({ user: { $in: users.map((u) => u._id) } })
    .select('_id')
    .lean();
  return mentors.map((m) => m._id);
};

/**
 * Mentor ids whose user name matches a search substring.
 * @param {string} trimmed
 * @returns {Promise<import('mongoose').Types.ObjectId[]>}
 */
const mentorIdsMatchingSearch = async (trimmed) => {
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const users = await User.find({ name: new RegExp(escaped, 'i') })
    .select('_id')
    .limit(50)
    .lean();
  if (!users.length) return [];
  const mentors = await Mentor.find({ user: { $in: users.map((u) => u._id) } })
    .select('_id')
    .lean();
  return mentors.map((m) => m._id);
};

/**
 * Category and instructor labels for the agent curriculum toolbar (all assigned modules).
 * @param {object} assignmentFilter
 * @returns {Promise<{ categories: string[], instructors: string[] }>}
 */
const loadMineCatalogFacets = async (assignmentFilter) => {
  const docs = await TrainingModule.find(assignmentFilter)
    .select('categories mentorsAssigned')
    .populate('categories', 'name')
    .populate({ path: 'mentorsAssigned', select: 'user', populate: { path: 'user', select: 'name' } })
    .lean();
  const categorySet = new Set();
  const instructorSet = new Set();
  for (const doc of docs) {
    for (const cat of doc.categories || []) {
      if (cat?.name) categorySet.add(cat.name);
    }
    const mentorName = doc.mentorsAssigned?.[0]?.user?.name;
    instructorSet.add(mentorName || 'Instructor');
  }
  return {
    categories: [...categorySet].sort((a, b) => a.localeCompare(b)),
    instructors: [...instructorSet].sort((a, b) => a.localeCompare(b)),
  };
};

const normalizeQuizQuestions = (questions = []) =>
  questions.map((q) => ({
    questionText: q.questionText,
    allowMultipleAnswers: q.allowMultipleAnswers || false,
    options: (q.options || []).map((opt) => ({
      text: opt.text,
      isCorrect: opt.isCorrect || false,
    })),
  }));

/**
 * Coerce a Q&A question maxMarks; missing or invalid values become 100.
 * @param {unknown} value
 * @returns {number}
 */
const questionMaxMarks = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return 100
  return n
}

/**
 * Optional pass percentage on a Q&A item; omit when unset.
 * @param {unknown} value
 * @returns {number|undefined}
 */
const normalizePassPercentage = (value) => {
  if (value == null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined
  return n
}

const normalizeEssayQuestions = (questions = []) =>
  questions.map((q) => ({
    questionText: q.questionText,
    expectedAnswer: q.expectedAnswer || undefined,
    maxMarks: questionMaxMarks(q.maxMarks),
  }));

/**
 * Create a training module
 * @param {Object} moduleBody - Training module data
 * @param {Object} currentUser - Current user
 * @returns {Promise<TrainingModule>}
 */
const createTrainingModule = async (moduleBody, currentUser) => {
  // Handle cover image upload if provided
  let coverImageData = null;
  if (moduleBody.coverImageFile) {
    const uploadResult = await uploadFileToS3(
      moduleBody.coverImageFile,
      currentUser.id || currentUser._id,
      'training-module-cover-images'
    );
    coverImageData = {
      key: uploadResult.key,
      url: uploadResult.url,
      originalName: uploadResult.originalName,
      size: uploadResult.size,
      mimeType: uploadResult.mimeType,
      uploadedAt: new Date(),
    };
  }

  // Process playlist items and handle file uploads
  const processedPlaylist = [];
  if (moduleBody.playlist && Array.isArray(moduleBody.playlist)) {
    for (let i = 0; i < moduleBody.playlist.length; i++) {
      const item = moduleBody.playlist[i];
      const processedItem = {
        contentType: item.contentType,
        title: item.title,
        duration: item.duration || 0,
        order: i,
      };
      if (item.sectionTitle != null) processedItem.sectionTitle = item.sectionTitle;
      if (item.sectionIndex != null) processedItem.sectionIndex = item.sectionIndex;

      // Handle content-specific fields
      switch (item.contentType) {
        case 'upload-video':
          if (item.videoFile?.buffer && item.videoFile?.originalname) {
            const videoUpload = await uploadFileToS3(
              item.videoFile,
              currentUser.id || currentUser._id,
              'training-module-videos'
            );
            processedItem.videoFile = {
              key: videoUpload.key,
              url: videoUpload.url,
              originalName: videoUpload.originalName,
              size: videoUpload.size,
              mimeType: videoUpload.mimeType,
              uploadedAt: new Date(),
            };
          } else if (item.videoFile?.key) {
            // Keep already uploaded file metadata from client payload
            processedItem.videoFile = {
              key: item.videoFile.key,
              url: item.videoFile.url,
              originalName: item.videoFile.originalName,
              size: item.videoFile.size,
              mimeType: item.videoFile.mimeType,
              uploadedAt: item.videoFile.uploadedAt || new Date(),
            };
          }
          break;

        case 'youtube-link':
          processedItem.youtubeUrl = item.youtubeUrl;
          break;

        case 'pdf-document':
          if (item.pdfFile?.buffer && item.pdfFile?.originalname) {
            const pdfUpload = await uploadFileToS3(
              item.pdfFile,
              currentUser.id || currentUser._id,
              'training-module-pdfs'
            );
            processedItem.pdfDocument = {
              key: pdfUpload.key,
              url: pdfUpload.url,
              originalName: pdfUpload.originalName,
              size: pdfUpload.size,
              mimeType: pdfUpload.mimeType,
              uploadedAt: new Date(),
            };
          } else if (item.pdfDocument?.key) {
            // Keep already uploaded file metadata from client payload
            processedItem.pdfDocument = {
              key: item.pdfDocument.key,
              url: item.pdfDocument.url,
              originalName: item.pdfDocument.originalName,
              size: item.pdfDocument.size,
              mimeType: item.pdfDocument.mimeType,
              uploadedAt: item.pdfDocument.uploadedAt || new Date(),
            };
          }
          break;

        case 'blog':
          processedItem.blogContent = item.blogContent;
          break;

        case 'quiz':
          if (item.difficulty) processedItem.difficulty = item.difficulty;
          if (item.quizData?.questions) {
            processedItem.quiz = {
              questions: normalizeQuizQuestions(item.quizData.questions),
            };
          } else if (item.quiz?.questions) {
            processedItem.quiz = {
              questions: normalizeQuizQuestions(item.quiz.questions),
            };
          }
          break;

        case 'essay': {
          const essaySrc = item.essayData?.questions ? item.essayData : item.essay
          if (essaySrc?.questions) {
            processedItem.essay = {
              questions: normalizeEssayQuestions(essaySrc.questions),
              passPercentage: normalizePassPercentage(essaySrc.passPercentage),
            }
          }
          break
        }
      }

      processedPlaylist.push(processedItem);
    }
  }

  const createStatus = moduleBody.status || 'draft';
  if (createStatus === 'published') {
    assertCanPublishPlaylist(processedPlaylist);
  }

  // Create training module
  const trainingModule = await TrainingModule.create({
    categories: moduleBody.categories || [],
    positions: moduleBody.positions || [],
    moduleName: moduleBody.moduleName,
    coverImage: coverImageData,
    shortDescription: moduleBody.shortDescription,
    students: moduleBody.students || [],
    mentorsAssigned: moduleBody.mentorsAssigned || [],
    playlist: processedPlaylist,
    status: moduleBody.status || 'draft',
    ...(moduleBody.estimatedDuration != null && { estimatedDuration: moduleBody.estimatedDuration }),
  });

  return trainingModule.populate([
    { path: 'categories' },
    { path: 'positions', select: 'name department' },
    { path: 'students', populate: { path: 'user' } },
    { path: 'mentorsAssigned', populate: { path: 'user' } },
  ]);
};

/**
 * Resolve the Student / Mentor ObjectIds that belong to the given app user.
 * Returns { studentId, mentorId } — either may be null when the user has no
 * such profile.
 */
const resolveAssignmentIdsForUser = async (currentUser) => {
  if (!currentUser) return { studentId: null, mentorId: null };
  const userId = currentUser.id || currentUser._id;
  if (!userId) return { studentId: null, mentorId: null };
  const [student, mentor] = await Promise.all([
    Student.findOne({ user: userId }).select('_id').lean(),
    Mentor.findOne({ user: userId }).select('_id').lean(),
  ]);
  return {
    studentId: student?._id ?? null,
    mentorId: mentor?._id ?? null,
  };
};

/**
 * True when the caller can list/edit drafts and archived modules.
 * Permissions live on `authContext.permissions` (a Set), not `user.permissions`.
 * @param {object} [currentUser]
 * @returns {boolean}
 */
const callerCanManageTrainingModules = (currentUser) => {
  if (!currentUser) return false;
  if (currentUser.platformSuperUser || currentUser.authContext?.isAdmin) return true;
  const ctxPerms = currentUser.authContext?.permissions;
  if (hasApiPermissionFromContext(ctxPerms, !!currentUser.platformSuperUser, 'modules.manage')) {
    return true;
  }
  if (hasApiPermissionFromContext(ctxPerms, !!currentUser.platformSuperUser, 'training.modules.manage')) {
    return true;
  }
  const extra = [];
  if (ctxPerms instanceof Set) extra.push(...ctxPerms);
  if (Array.isArray(currentUser.permissions)) extra.push(...currentUser.permissions);
  return extra.some((p) => {
    const s = String(p);
    return /training\.modules/i.test(s) && /(create|edit|delete|manage)/i.test(s);
  });
};

/**
 * Publishing requires at least one playlist item.
 * @param {unknown[]} playlist
 */
const assertCanPublishPlaylist = (playlist) => {
  if (!Array.isArray(playlist) || playlist.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Add at least one playlist item before publishing.');
  }
};

/**
 * Query for training modules.
 *
 * Visibility rules (applied here so it cannot be bypassed by FE state):
 * - `mine=true`           → modules where the caller is in `students` or
 *                           `mentorsAssigned`. Status forced to `published`
 *                           unless explicitly overridden.
 * - `status` not provided + non-admin caller (no modules.manage permission)
 *                         → default to `published` (drafts/archived hidden).
 *
 * @param {Object} filter - Mongo filter (search/category/status/mine)
 * @param {Object} options - Query options (sortBy/limit/page)
 * @param {Object} [currentUser] - Authenticated user (req.user). Optional for
 *                                 internal/admin callers.
 * @returns {Promise<QueryResult>}
 */
const queryTrainingModules = async (filter, options, currentUser) => {
  const { search, category, status, mine, instructor, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };
  const isMine = mine === true || mine === 'true';
  let assignmentScope = null;

  if (isMine) {
    const { studentId, mentorId } = await resolveAssignmentIdsForUser(currentUser);
    const orClauses = [];
    if (studentId) orClauses.push({ students: studentId });
    if (mentorId) orClauses.push({ mentorsAssigned: mentorId });
    if (orClauses.length === 0) {
      // No student/mentor profile → no assignments → empty result.
      return { results: [], page: Number(options.page) || 1, limit: Number(options.limit) || 10, totalPages: 0, totalResults: 0 };
    }
    assignmentScope = { $or: orClauses };
    mongoFilter.$or = orClauses;
  }

  // Non-admin callers only ever see published modules unless they explicitly
  // ask for a different status (FE may pass status=draft from an admin
  // dashboard; permission gate above ensures the route is still authorised).
  const canManageModules = callerCanManageTrainingModules(currentUser);

  if (search && search.trim()) {
    const trimmed = search.trim();
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const prefix = new RegExp('^' + escaped, 'i');
    const anywhere = new RegExp(escaped, 'i');
    const mentorIds = await mentorIdsMatchingSearch(trimmed);
    const searchOr = [
      { moduleName: prefix },
      { moduleName: anywhere },
      { shortDescription: anywhere },
    ];
    if (mentorIds.length) searchOr.push({ mentorsAssigned: { $in: mentorIds } });
    const isTextSafe = !isMine && trimmed.length >= 3 && /^[\p{L}\p{N}\s'-]+$/u.test(trimmed);
    if (isTextSafe) {
      mongoFilter.$text = { $search: trimmed };
    } else if (Array.isArray(mongoFilter.$or)) {
      const mineOr = mongoFilter.$or;
      delete mongoFilter.$or;
      mongoFilter.$and = [{ $or: mineOr }, { $or: searchOr }];
    } else {
      mongoFilter.$or = searchOr;
    }
  }

  if (category) {
    const categoryId = await resolveCategoryId(category);
    mongoFilter.categories = categoryId || new mongoose.Types.ObjectId();
  }
  if (instructor) {
    const mentorIds = await mentorIdsForInstructorName(instructor);
    mongoFilter.mentorsAssigned = { $in: mentorIds.length ? mentorIds : [new mongoose.Types.ObjectId()] };
  }
  if (status) {
    mongoFilter.status = status;
  } else if (!canManageModules) {
    mongoFilter.status = 'published';
  }

  const catalogPopulate = [
    { path: 'categories', select: 'name' },
    { path: 'mentorsAssigned', select: 'user', populate: { path: 'user', select: 'name' } },
  ];

  // Note: lean:true is intentionally NOT used. The toJSON plugin renames
  // _id -> id only on Mongoose docs, and the FE filters by `id` on modules,
  // categories, and mentors. Lean docs would ship `_id` and FE folder
  // grouping silently fails (every folder appears empty).
  const modules = await TrainingModule.paginate(mongoFilter, {
    ...options,
    select: isMine ? `${LIST_EXCLUDE_FIELDS} -playlist -students` : LIST_EXCLUDE_FIELDS,
    // List cards need category names + mentor names + students.length (ids, not populated users).
    populate: catalogPopulate,
  });

  // Signed URLs only for rows that actually have a cover key (skip empty Promise.all).
  if (modules.results?.length) {
    const coverJobs = [];
    for (const m of modules.results) {
      if (!m.coverImage?.key) continue;
      coverJobs.push(
        signedDownloadUrl(m.coverImage.key, 7 * 24 * 3600)
          .then((url) => {
            m.coverImage.url = url;
          })
          .catch((error) => {
            logger.error('Failed to regenerate cover image URL:', error);
          })
      );
    }
    if (coverJobs.length) await Promise.all(coverJobs);
  }

  if (isMine && assignmentScope) {
    const facetFilter = { ...assignmentScope };
    if (mongoFilter.status) facetFilter.status = mongoFilter.status;
    modules.facets = await loadMineCatalogFacets(facetFilter);
  }

  return modules;
};

/**
 * Get training module by id
 * @param {ObjectId} id
 * @returns {Promise<TrainingModule>}
 */
const getTrainingModuleById = async (id) => {
  const module = await TrainingModule.findById(id).populate([
    { path: 'categories' },
    { path: 'positions', select: 'name department' },
    { path: 'students', populate: { path: 'user' } },
    { path: 'mentorsAssigned', populate: { path: 'user' } },
  ]);

  if (!module) {
    return null;
  }

  // Regenerate presigned URLs (cached + parallel — was sequential N+1).
  const tasks = [];
  if (module.coverImage?.key) {
    tasks.push(
      signedDownloadUrl(module.coverImage.key, 7 * 24 * 3600)
        .then((url) => { module.coverImage.url = url; })
        .catch((error) => logger.error('Failed to regenerate cover image URL:', error))
    );
  }
  for (const item of module.playlist) {
    if (item.videoFile?.key) {
      tasks.push(
        signedDownloadUrl(item.videoFile.key, 7 * 24 * 3600)
          .then((url) => { item.videoFile.url = url; })
          .catch((error) => logger.error('Failed to regenerate video URL:', error))
      );
    }
    if (item.pdfDocument?.key) {
      tasks.push(
        signedDownloadUrl(item.pdfDocument.key, 7 * 24 * 3600)
          .then((url) => { item.pdfDocument.url = url; })
          .catch((error) => logger.error('Failed to regenerate PDF URL:', error))
      );
    }
  }
  await Promise.all(tasks);

  return module;
};

/**
 * Update training module by id
 * @param {ObjectId} moduleId
 * @param {Object} updateBody
 * @param {Object} currentUser
 * @returns {Promise<TrainingModule>}
 */
const updateTrainingModuleById = async (moduleId, updateBody, currentUser) => {
  const module = await getTrainingModuleById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  const oldStudentIds = new Set((module.students || []).map((s) => String(s._id || s)));
  const oldMentorIds = new Set((module.mentorsAssigned || []).map((m) => String(m._id || m)));

  // Handle cover image upload if new file provided
  if (updateBody.coverImageFile) {
    const uploadResult = await uploadFileToS3(
      updateBody.coverImageFile,
      currentUser.id || currentUser._id,
      'training-module-cover-images'
    );
    module.coverImage = {
      key: uploadResult.key,
      url: uploadResult.url,
      originalName: uploadResult.originalName,
      size: uploadResult.size,
      mimeType: uploadResult.mimeType,
      uploadedAt: new Date(),
    };
    delete updateBody.coverImageFile;
  }

  // Process playlist updates if provided
  if (updateBody.playlist && Array.isArray(updateBody.playlist)) {
    const processedPlaylist = [];
    for (let i = 0; i < updateBody.playlist.length; i++) {
      const item = updateBody.playlist[i];
      const processedItem = {
        contentType: item.contentType,
        title: item.title,
        duration: item.duration || 0,
        order: i,
      };
      if (item.sectionTitle != null) processedItem.sectionTitle = item.sectionTitle;
      if (item.sectionIndex != null) processedItem.sectionIndex = item.sectionIndex;

      // Handle content-specific fields
      switch (item.contentType) {
        case 'upload-video':
          if (item.videoFile?.buffer && item.videoFile?.originalname) {
            const videoUpload = await uploadFileToS3(
              item.videoFile,
              currentUser.id || currentUser._id,
              'training-module-videos'
            );
            processedItem.videoFile = {
              key: videoUpload.key,
              url: videoUpload.url,
              originalName: videoUpload.originalName,
              size: videoUpload.size,
              mimeType: videoUpload.mimeType,
              uploadedAt: new Date(),
            };
          } else if (item.videoFile?.key) {
            // Keep already uploaded file metadata sent by frontend
            processedItem.videoFile = {
              key: item.videoFile.key,
              url: item.videoFile.url,
              originalName: item.videoFile.originalName,
              size: item.videoFile.size,
              mimeType: item.videoFile.mimeType,
              uploadedAt: item.videoFile.uploadedAt || new Date(),
            };
          } else if (item._id) {
            // Keep existing video if no new upload provided
            const existingItem = module.playlist.find((p) => p._id.toString() === String(item._id));
            if (existingItem?.videoFile?.key) {
              processedItem.videoFile = existingItem.videoFile;
            }
          }
          break;

        case 'youtube-link':
          processedItem.youtubeUrl = item.youtubeUrl;
          break;

        case 'pdf-document':
          if (item.pdfFile?.buffer && item.pdfFile?.originalname) {
            const pdfUpload = await uploadFileToS3(
              item.pdfFile,
              currentUser.id || currentUser._id,
              'training-module-pdfs'
            );
            processedItem.pdfDocument = {
              key: pdfUpload.key,
              url: pdfUpload.url,
              originalName: pdfUpload.originalName,
              size: pdfUpload.size,
              mimeType: pdfUpload.mimeType,
              uploadedAt: new Date(),
            };
          } else if (item.pdfDocument?.key) {
            // Keep already uploaded file metadata sent by frontend
            processedItem.pdfDocument = {
              key: item.pdfDocument.key,
              url: item.pdfDocument.url,
              originalName: item.pdfDocument.originalName,
              size: item.pdfDocument.size,
              mimeType: item.pdfDocument.mimeType,
              uploadedAt: item.pdfDocument.uploadedAt || new Date(),
            };
          } else if (item._id) {
            // Keep existing PDF if no new upload provided
            const existingItem = module.playlist.find((p) => p._id.toString() === String(item._id));
            if (existingItem?.pdfDocument?.key) {
              processedItem.pdfDocument = existingItem.pdfDocument;
            }
          }
          break;

        case 'blog':
          processedItem.blogContent = item.blogContent;
          break;

        case 'quiz':
          if (item.difficulty) processedItem.difficulty = item.difficulty;
          if (item.quizData?.questions) {
            processedItem.quiz = {
              questions: normalizeQuizQuestions(item.quizData.questions),
            };
          } else if (item.quiz?.questions) {
            processedItem.quiz = {
              questions: normalizeQuizQuestions(item.quiz.questions),
            };
          } else if (item._id) {
            const existingItem = module.playlist.find((p) => p._id.toString() === String(item._id));
            if (existingItem?.quiz?.questions) {
              processedItem.quiz = existingItem.quiz;
            }
          }
          break;

        case 'essay': {
          const essaySrc = item.essayData?.questions ? item.essayData : item.essay
          if (essaySrc?.questions) {
            processedItem.essay = {
              questions: normalizeEssayQuestions(essaySrc.questions),
              passPercentage: normalizePassPercentage(essaySrc.passPercentage),
            }
          } else if (item._id) {
            const existingItem = module.playlist.find((p) => p._id.toString() === String(item._id))
            if (existingItem?.essay?.questions) {
              processedItem.essay = existingItem.essay
            }
          }
          break
        }
      }

      processedPlaylist.push(processedItem);
    }
    module.playlist = processedPlaylist;
    // Prevent raw payload from overwriting normalized/merged playlist below
    updateBody.playlist = processedPlaylist;
  }

  const nextStatus = updateBody.status ?? module.status;
  if (nextStatus === 'published') {
    const playlist = updateBody.playlist ?? module.playlist;
    assertCanPublishPlaylist(playlist);
  }

  // Update other fields
  Object.assign(module, updateBody);
  await module.save();

  const updated = await getTrainingModuleById(moduleId);
  const newStudentIds = new Set((updated.students || []).map((s) => String(s._id || s)));
  const newMentorIds = new Set((updated.mentorsAssigned || []).map((m) => String(m._id || m)));
  const addedStudents = [...newStudentIds].filter((id) => !oldStudentIds.has(id));
  const removedStudents = [...oldStudentIds].filter((id) => !newStudentIds.has(id));
  const addedMentors = [...newMentorIds].filter((id) => !oldMentorIds.has(id));
  const removedMentors = [...oldMentorIds].filter((id) => !newMentorIds.has(id));

  const moduleName = updated.moduleName || module.moduleName || 'Training module';
  const link = '/training/curriculum/modules';
  const { notify, plainTextEmailBody } = await import('./notification.service.js');

  for (const studentId of addedStudents) {
    const student = await Student.findById(studentId).select('user').lean();
    if (student?.user) {
      const msg = `You have been assigned to "${moduleName}".`;
      notify(student.user, {
        type: 'course',
        title: 'Course assigned',
        message: msg,
        link,
        email: { subject: `Course assigned: ${moduleName}`, text: plainTextEmailBody(msg, link) },
      }).catch(() => {});
    }
  }
  for (const studentId of removedStudents) {
    const student = await Student.findById(studentId).select('user').lean();
    if (student?.user) {
      const msg = `You have been removed from "${moduleName}".`;
      notify(student.user, {
        type: 'course',
        title: 'Removed from course',
        message: msg,
        link,
        email: { subject: `Removed from course: ${moduleName}`, text: plainTextEmailBody(msg, link) },
      }).catch(() => {});
    }
  }
  for (const mentorId of addedMentors) {
    const mentor = await Mentor.findById(mentorId).select('user').lean();
    if (mentor?.user) {
      const msg = `You have been assigned as mentor to "${moduleName}".`;
      notify(mentor.user, {
        type: 'course',
        title: 'Mentor assigned',
        message: msg,
        link,
        email: { subject: `Mentor assigned: ${moduleName}`, text: plainTextEmailBody(msg, link) },
      }).catch(() => {});
    }
  }
  for (const mentorId of removedMentors) {
    const mentor = await Mentor.findById(mentorId).select('user').lean();
    if (mentor?.user) {
      const msg = `You have been removed as mentor from "${moduleName}".`;
      notify(mentor.user, {
        type: 'course',
        title: 'Mentor removed',
        message: msg,
        link,
        email: { subject: `Mentor removed: ${moduleName}`, text: plainTextEmailBody(msg, link) },
      }).catch(() => {});
    }
  }

  return updated;
};

/**
 * Delete training module by id
 * @param {ObjectId} moduleId
 * @returns {Promise<TrainingModule>}
 */
const deleteTrainingModuleById = async (moduleId) => {
  const module = await getTrainingModuleById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  await module.deleteOne();
  return module;
};

/**
 * Active students whose position is linked to this module (TrainingModule.positions).
 * @param {import('mongoose').Types.ObjectId} moduleId
 * @param {Object} filter
 * @param {Object} options
 */
const queryEmployeesForModule = async (moduleId, filter, options) => {
  const module = await TrainingModule.findById(moduleId).select('positions moduleName');
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  const positionIds = (module.positions ?? []).map((p) => String(p._id ?? p)).filter(Boolean);
  if (!positionIds.length) {
    return {
      results: [],
      page: options.page ?? 1,
      limit: options.limit ?? 10,
      totalPages: 0,
      totalResults: 0,
    };
  }
  return studentService.queryStudents(
    { ...filter, position: { $in: positionIds }, status: 'active' },
    options
  );
};

export {
  createTrainingModule,
  queryTrainingModules,
  getTrainingModuleById,
  queryEmployeesForModule,
  updateTrainingModuleById,
  deleteTrainingModuleById,
};
