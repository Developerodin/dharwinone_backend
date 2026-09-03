import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as trainingModuleService from '../services/trainingModule.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

/**
 * Parse a JSON-encoded array field from multipart without throwing on "".
 * @param {unknown} value
 * @returns {unknown}
 */
function parseJsonField(value) {
  if (value == null || value === '') return value;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ApiError(httpStatus.BAD_REQUEST, `Invalid JSON in request body (${message})`);
  }
}

/**
 * Coerce remaining string JSON fields after Joi (playlist).
 * @param {Record<string, unknown>} moduleData
 */
function parseMultipartJsonFields(moduleData) {
  for (const key of ['categories', 'students', 'mentorsAssigned', 'positions', 'playlist']) {
    if (typeof moduleData[key] === 'string') {
      moduleData[key] = parseJsonField(moduleData[key]);
    }
  }
}

const createTrainingModule = catchAsync(async (req, res) => {
  // Extract files from req.files (handled by multer)
  const moduleData = { ...req.body };

  parseMultipartJsonFields(moduleData);

  // Handle cover image file
  if (req.files && req.files.coverImage) {
    moduleData.coverImageFile = Array.isArray(req.files.coverImage)
      ? req.files.coverImage[0]
      : req.files.coverImage;
  }

  // Handle playlist item files
  if (moduleData.playlist && Array.isArray(moduleData.playlist)) {
    moduleData.playlist = moduleData.playlist.map((item, index) => {
      const processedItem = { ...item };

      // Handle video file upload
      if (item.contentType === 'upload-video' && req.files[`playlist[${index}].videoFile`]) {
        const videoFile = Array.isArray(req.files[`playlist[${index}].videoFile`])
          ? req.files[`playlist[${index}].videoFile`][0]
          : req.files[`playlist[${index}].videoFile`];
        processedItem.videoFile = videoFile;
      }

      // Handle PDF file upload
      if (item.contentType === 'pdf-document' && req.files[`playlist[${index}].pdfFile`]) {
        const pdfFile = Array.isArray(req.files[`playlist[${index}].pdfFile`])
          ? req.files[`playlist[${index}].pdfFile`][0]
          : req.files[`playlist[${index}].pdfFile`];
        processedItem.pdfFile = pdfFile;
      }

      return processedItem;
    });
  }

  const module = await trainingModuleService.createTrainingModule(moduleData, req.user);

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.TRAINING_MODULE_CREATE || 'TRAINING_MODULE_CREATE',
    EntityTypes.TRAINING_MODULE || 'TRAINING_MODULE',
    module.id,
    {},
    req
  );

  res.status(httpStatus.CREATED).send(module);
});

const getTrainingModules = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['search', 'category', 'status', 'mine', 'instructor']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await trainingModuleService.queryTrainingModules(filter, options, req.user);
  res.send(result);
});

const getTrainingModule = catchAsync(async (req, res) => {
  const module = await trainingModuleService.getTrainingModuleById(req.params.moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  res.send(module);
});

const getModuleEmployees = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await trainingModuleService.queryEmployeesForModule(req.params.moduleId, filter, options);
  res.send(result);
});

const updateTrainingModule = catchAsync(async (req, res) => {
  const moduleData = { ...req.body };

  parseMultipartJsonFields(moduleData);

  // Handle cover image file
  if (req.files && req.files.coverImage) {
    moduleData.coverImageFile = Array.isArray(req.files.coverImage)
      ? req.files.coverImage[0]
      : req.files.coverImage;
  }

  // Handle playlist item files
  if (moduleData.playlist && Array.isArray(moduleData.playlist)) {
    moduleData.playlist = moduleData.playlist.map((item, index) => {
      const processedItem = { ...item };

      // Handle video file upload
      if (item.contentType === 'upload-video' && req.files[`playlist[${index}].videoFile`]) {
        const videoFile = Array.isArray(req.files[`playlist[${index}].videoFile`])
          ? req.files[`playlist[${index}].videoFile`][0]
          : req.files[`playlist[${index}].videoFile`];
        processedItem.videoFile = videoFile;
      }

      // Handle PDF file upload
      if (item.contentType === 'pdf-document' && req.files[`playlist[${index}].pdfFile`]) {
        const pdfFile = Array.isArray(req.files[`playlist[${index}].pdfFile`])
          ? req.files[`playlist[${index}].pdfFile`][0]
          : req.files[`playlist[${index}].pdfFile`];
        processedItem.pdfFile = pdfFile;
      }

      return processedItem;
    });
  }

  const module = await trainingModuleService.updateTrainingModuleById(
    req.params.moduleId,
    moduleData,
    req.user
  );

  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.TRAINING_MODULE_UPDATE || 'TRAINING_MODULE_UPDATE',
    EntityTypes.TRAINING_MODULE || 'TRAINING_MODULE',
    module.id,
    {},
    req
  );

  res.send(module);
});

const deleteTrainingModule = catchAsync(async (req, res) => {
  await trainingModuleService.deleteTrainingModuleById(req.params.moduleId);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.TRAINING_MODULE_DELETE || 'TRAINING_MODULE_DELETE',
    EntityTypes.TRAINING_MODULE || 'TRAINING_MODULE',
    req.params.moduleId,
    {},
    req
  );
  res.status(httpStatus.NO_CONTENT).send();
});

export {
  createTrainingModule,
  getTrainingModules,
  getTrainingModule,
  getModuleEmployees,
  updateTrainingModule,
  deleteTrainingModule,
};
