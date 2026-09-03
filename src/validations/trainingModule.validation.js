import Joi from 'joi';
import { objectId } from './custom.validation.js';

const uploadedFileSchema = Joi.object({
  key: Joi.string().trim().required(),
  url: Joi.string().trim().required(),
  originalName: Joi.string().trim().optional(),
  size: Joi.number().optional(),
  mimeType: Joi.string().trim().optional(),
  uploadedAt: Joi.alternatives().try(Joi.date(), Joi.string()).optional(),
});

const playlistItemSchema = Joi.object({
  _id: Joi.string().custom(objectId).optional(),
  contentType: Joi.string()
    .valid('upload-video', 'youtube-link', 'pdf-document', 'blog', 'quiz', 'essay')
    .required(),
  title: Joi.string().required().trim(),
  duration: Joi.number().integer().min(0).default(0),
  order: Joi.number().integer().min(0).optional(),
  sectionTitle: Joi.string().trim().optional(),
  sectionIndex: Joi.number().integer().min(0).optional(),
  difficulty: Joi.string()
    .valid('easy', 'medium', 'hard')
    .default('medium')
    .when('contentType', {
      is: 'quiz',
      then: Joi.optional(),
      otherwise: Joi.forbidden(),
    }),
  // Content-specific fields
  videoFile: uploadedFileSchema.optional(),
  pdfDocument: uploadedFileSchema.optional(),
  youtubeUrl: Joi.string().uri().when('contentType', {
    is: 'youtube-link',
    then: Joi.required(),
    otherwise: Joi.optional().allow('', null),
  }).messages({
    'string.uri': 'YouTube URL must be a valid URL',
  }),
  blogContent: Joi.string().when('contentType', {
    is: 'blog',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  quizData: Joi.object({
    questions: Joi.array()
      .items(
        Joi.object({
          questionText: Joi.string().required(),
          allowMultipleAnswers: Joi.boolean().default(false),
          options: Joi.array()
            .items(
              Joi.object({
                text: Joi.string().required(),
                isCorrect: Joi.boolean().default(false),
              })
            )
            .min(2)
            .required(),
        })
      )
      .min(1),
  }).when('contentType', {
    is: 'quiz',
    then: Joi.optional(),
    otherwise: Joi.optional(),
  }),
  quiz: Joi.object({
    questions: Joi.array()
      .items(
        Joi.object({
          questionText: Joi.string().required(),
          allowMultipleAnswers: Joi.boolean().default(false),
          options: Joi.array()
            .items(
              Joi.object({
                text: Joi.string().required(),
                isCorrect: Joi.boolean().default(false),
              })
            )
            .min(2)
            .required(),
        })
      )
      .min(1),
  }).when('contentType', {
    is: 'quiz',
    then: Joi.optional(),
    otherwise: Joi.optional(),
  }),
  essayData: Joi.object({
    passPercentage: Joi.number().min(0).max(100).optional(),
    questions: Joi.array()
      .items(
        Joi.object({
          questionText: Joi.string().required(),
          expectedAnswer: Joi.string().allow('').optional(),
          maxMarks: Joi.number().min(1).optional(),
        })
      )
      .min(1),
  }).when('contentType', {
    is: 'essay',
    then: Joi.optional(),
    otherwise: Joi.optional(),
  }),
  essay: Joi.object({
    passPercentage: Joi.number().min(0).max(100).optional(),
    questions: Joi.array()
      .items(
        Joi.object({
          questionText: Joi.string().required(),
          expectedAnswer: Joi.string().allow('').optional(),
          maxMarks: Joi.number().min(1).optional(),
        })
      )
      .min(1),
  }).when('contentType', {
    is: 'essay',
    then: Joi.optional(),
    otherwise: Joi.optional(),
  }),
});

/** Multipart may send id lists as a real array, JSON string, or "". */
const idArrayField = Joi.alternatives()
  .try(
    Joi.array().items(Joi.custom(objectId)),
    Joi.string().allow('').custom((value, helpers) => {
      if (value === '' || value == null) return [];
      try {
        const parsed = JSON.parse(value);
        if (!Array.isArray(parsed)) {
          return helpers.error('any.invalid');
        }
        const { error, value: coerced } = Joi.array().items(Joi.custom(objectId)).validate(parsed);
        if (error) {
          return helpers.error('any.invalid');
        }
        return coerced;
      } catch (err) {
        if (typeof value === 'string' && value.trim() && !value.trim().startsWith('[')) {
          const { error, value: coerced } = Joi.array().items(Joi.custom(objectId)).validate([value.trim()]);
          if (!error) return coerced;
        }
        return helpers.error('any.invalid');
      }
    })
  );

const createIdArrayField = idArrayField.default([]);

const createTrainingModule = {
  body: Joi.object().keys({
    categories: createIdArrayField,
    positions: createIdArrayField,
    moduleName: Joi.string().required().trim(),
    shortDescription: Joi.string().required().trim(),
    students: createIdArrayField,
    mentorsAssigned: createIdArrayField,
    playlist: Joi.array().items(playlistItemSchema).default([]),
    status: Joi.string().valid('draft', 'published', 'archived').default('draft'),
  }),
};

const getTrainingModules = {
  query: Joi.object().keys({
    search: Joi.string().allow(''),
    category: Joi.alternatives().try(Joi.custom(objectId), Joi.string()),
    instructor: Joi.string().allow(''),
    status: Joi.string().valid('draft', 'published', 'archived'),
    mine: Joi.boolean(),
    sortBy: Joi.string(),
    limit: Joi.number().integer().max(2000),
    page: Joi.number().integer(),
  }),
};

const getTrainingModule = {
  params: Joi.object().keys({
    moduleId: Joi.custom(objectId).required(),
  }),
};

const updateTrainingModule = {
  params: Joi.object().keys({
    moduleId: Joi.custom(objectId).required(),
  }),
  body: Joi.object()
    .keys({
      categories: idArrayField,
      positions: idArrayField,
      moduleName: Joi.string().trim(),
      shortDescription: Joi.string().trim(),
      students: idArrayField,
      mentorsAssigned: idArrayField,
      playlist: Joi.array().items(playlistItemSchema),
      status: Joi.string().valid('draft', 'published', 'archived'),
    })
    .min(1),
};

const deleteTrainingModule = {
  params: Joi.object().keys({
    moduleId: Joi.custom(objectId).required(),
  }),
};

const getModuleEmployees = {
  params: Joi.object().keys({
    moduleId: Joi.string().required().custom(objectId),
  }),
  query: Joi.object().keys({
    search: Joi.string().allow('').optional(),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
    page: Joi.number().integer(),
  }),
};

export {
  createTrainingModule,
  getTrainingModules,
  getTrainingModule,
  getModuleEmployees,
  updateTrainingModule,
  deleteTrainingModule,
};
