import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';
import TrainingModule from '../models/trainingModule.model.js';
import { uploadFileToS3 } from './upload.service.js';
import { generatePresignedDownloadUrl } from '../config/s3.js';

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
            const pdfUpload = await uploadFileToS3(item.pdfFile, currentUser.id || currentUser._id, 'training-module-pdfs');
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
          // Inline quiz questions in training module schema
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

        case 'test':
          processedItem.testLinkOrReference = item.testLinkOrReference;
          break;
      }

      processedPlaylist.push(processedItem);
    }
  }

  // Create training module
  const trainingModule = await TrainingModule.create({
    categories: moduleBody.categories || [],
    moduleName: moduleBody.moduleName,
    coverImage: coverImageData,
    shortDescription: moduleBody.shortDescription,
    students: moduleBody.students || [],
    mentorsAssigned: moduleBody.mentorsAssigned || [],
    playlist: processedPlaylist,
    status: moduleBody.status || 'draft',
  });

  return trainingModule.populate([
    { path: 'categories' },
    { path: 'students', populate: { path: 'user' } },
    { path: 'mentorsAssigned', populate: { path: 'user' } },
  ]);
};

/**
 * Query for training modules
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @returns {Promise<QueryResult>}
 */
const queryTrainingModules = async (filter, options) => {
  const { search, category, status, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };

  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoFilter.$or = [{ moduleName: { $regex: searchRegex } }, { shortDescription: { $regex: searchRegex } }];
  }

  if (category) {
    mongoFilter.categories = category;
  }

  if (status) {
    mongoFilter.status = status;
  }

  const modules = await TrainingModule.paginate(mongoFilter, {
    ...options,
    // Populate categories, students (with user), mentors (with user)
    populate: 'categories,students,mentorsAssigned,students.user,mentorsAssigned.user',
  });

  // Regenerate presigned URLs for cover images
  if (modules.results && modules.results.length > 0) {
    for (const module of modules.results) {
      if (module.coverImage?.key) {
        try {
          const url = await generatePresignedDownloadUrl(module.coverImage.key, 7 * 24 * 3600);
          module.coverImage.url = url;
        } catch (error) {
          logger.error('Failed to regenerate cover image URL:', error);
        }
      }
    }
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
    { path: 'students', populate: { path: 'user' } },
    { path: 'mentorsAssigned', populate: { path: 'user' } },
  ]);

  if (!module) {
    return null;
  }

  // Regenerate presigned URLs
  if (module.coverImage?.key) {
    try {
      const url = await generatePresignedDownloadUrl(module.coverImage.key, 7 * 24 * 3600);
      module.coverImage.url = url;
    } catch (error) {
      logger.error('Failed to regenerate cover image URL:', error);
    }
  }

  // Regenerate URLs for playlist items
  for (const item of module.playlist) {
    if (item.videoFile?.key) {
      try {
        const url = await generatePresignedDownloadUrl(item.videoFile.key, 7 * 24 * 3600);
        item.videoFile.url = url;
      } catch (error) {
        logger.error('Failed to regenerate video URL:', error);
      }
    }

    if (item.pdfDocument?.key) {
      try {
        const url = await generatePresignedDownloadUrl(item.pdfDocument.key, 7 * 24 * 3600);
        item.pdfDocument.url = url;
      } catch (error) {
        logger.error('Failed to regenerate PDF URL:', error);
      }
    }
  }

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
            const pdfUpload = await uploadFileToS3(item.pdfFile, currentUser.id || currentUser._id, 'training-module-pdfs');
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
          if (item.quizData?.questions) {
            processedItem.quiz = {
              questions: normalizeQuizQuestions(item.quizData.questions),
            };
          } else if (item.quiz?.questions) {
            processedItem.quiz = {
              questions: normalizeQuizQuestions(item.quiz.questions),
            };
          } else if (item._id) {
            // Keep existing inline quiz if frontend didn't resend it
            const existingItem = module.playlist.find((p) => p._id.toString() === String(item._id));
            if (existingItem?.quiz?.questions) {
              processedItem.quiz = existingItem.quiz;
            }
          }
          break;

        case 'test':
          processedItem.testLinkOrReference = item.testLinkOrReference;
          break;
      }

      processedPlaylist.push(processedItem);
    }
    module.playlist = processedPlaylist;
    // Prevent raw payload from overwriting normalized/merged playlist below
    updateBody.playlist = processedPlaylist;
  }

  // Update other fields
  Object.assign(module, updateBody);
  await module.save();

  return getTrainingModuleById(moduleId);
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

export {
  createTrainingModule,
  queryTrainingModules,
  getTrainingModuleById,
  updateTrainingModuleById,
  deleteTrainingModuleById,
};
