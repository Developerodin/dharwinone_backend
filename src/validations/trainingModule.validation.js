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
  contentType: Joi.string().valid('upload-video', 'youtube-link', 'pdf-document', 'blog', 'quiz', 'test').required(),
  title: Joi.string().required().trim(),
  duration: Joi.number().integer().min(0).default(0),
  order: Joi.number().integer().min(0).optional(),
  // Content-specific fields
  videoFile: uploadedFileSchema.optional(),
  pdfDocument: uploadedFileSchema.optional(),
  youtubeUrl: Joi.string().uri().when('contentType', {
    is: 'youtube-link',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  blogContent: Joi.string().when('contentType', {
    is: 'blog',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  testLinkOrReference: Joi.string().when('contentType', {
    is: 'test',
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
});

const createTrainingModule = {
  body: Joi.object().keys({
    categories: Joi.array().items(Joi.custom(objectId)).default([]),
    moduleName: Joi.string().required().trim(),
    shortDescription: Joi.string().required().trim(),
    students: Joi.array().items(Joi.custom(objectId)).default([]),
    mentorsAssigned: Joi.array().items(Joi.custom(objectId)).default([]),
    playlist: Joi.array().items(playlistItemSchema).default([]),
    status: Joi.string().valid('draft', 'published', 'archived').default('draft'),
  }),
};

const getTrainingModules = {
  query: Joi.object().keys({
    search: Joi.string(),
    category: Joi.custom(objectId),
    status: Joi.string().valid('draft', 'published', 'archived'),
    sortBy: Joi.string(),
    limit: Joi.number().integer(),
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
      categories: Joi.array().items(Joi.custom(objectId)),
      moduleName: Joi.string().trim(),
      shortDescription: Joi.string().trim(),
      students: Joi.array().items(Joi.custom(objectId)),
      mentorsAssigned: Joi.array().items(Joi.custom(objectId)),
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

export { createTrainingModule, getTrainingModules, getTrainingModule, updateTrainingModule, deleteTrainingModule };
