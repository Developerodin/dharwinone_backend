import express from 'express';
import multer from 'multer';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as trainingModuleValidation from '../../validations/trainingModule.validation.js';
import * as trainingModuleController from '../../controllers/trainingModule.controller.js';
import * as aiGenerateController from '../../controllers/trainingModuleAI.controller.js';

const router = express.Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB max file size
  },
});

// Middleware to handle multiple file fields dynamically
const handleFileUploads = (req, res, next) => {
  // Use fields() to handle multiple file fields dynamically
  // This will handle coverImage and any playlist item files
  const fields = [
    { name: 'coverImage', maxCount: 1 },
  ];

  // Add dynamic fields for playlist items (up to 50 items)
  for (let i = 0; i < 50; i++) {
    fields.push({ name: `playlist[${i}].videoFile`, maxCount: 1 });
    fields.push({ name: `playlist[${i}].pdfFile`, maxCount: 1 });
  }

  upload.fields(fields)(req, res, next);
};

router.post(
  '/generate-with-ai',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.generateWithAI
);

router.post(
  '/extract-document',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.extractDocument
);

router.post(
  '/process-document',
  auth(),
  requirePermissions('modules.manage'),
  upload.single('file'),
  aiGenerateController.processDocument
);

router.post(
  '/suggest-topic-description',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.suggestTopicDescription
);

router.post(
  '/playlist-outline-from-title',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.getPlaylistOutline
);

router.post(
  '/generate-from-title',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.generateModuleFromTitle
);

router.post(
  '/save-with-video-assignments',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.saveModuleWithVideoAssignments
);

router.post(
  '/fetch-videos-from-document',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.fetchVideosFromDocument
);

router.post(
  '/enhance-quiz',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.enhanceQuiz
);

router.post(
  '/enhance-essay',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.enhanceEssay
);

router
  .route('/')
  .post(
    auth(),
    requirePermissions('modules.manage'),
    handleFileUploads,
    validate(trainingModuleValidation.createTrainingModule),
    trainingModuleController.createTrainingModule
  )
  .get(
    auth(),
    requirePermissions('modules.read'),
    validate(trainingModuleValidation.getTrainingModules),
    trainingModuleController.getTrainingModules
  );

router.post(
  '/:moduleId/ai-chat',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.aiChat
);

router.post(
  '/:moduleId/clone',
  auth(),
  requirePermissions('modules.manage'),
  aiGenerateController.cloneModule
);

router
  .route('/:moduleId')
  .get(
    auth(),
    requirePermissions('modules.read'),
    validate(trainingModuleValidation.getTrainingModule),
    trainingModuleController.getTrainingModule
  )
  .patch(
    auth(),
    requirePermissions('modules.manage'),
    handleFileUploads,
    validate(trainingModuleValidation.updateTrainingModule),
    trainingModuleController.updateTrainingModule
  )
  .delete(
    auth(),
    requirePermissions('modules.manage'),
    validate(trainingModuleValidation.deleteTrainingModule),
    trainingModuleController.deleteTrainingModule
  );

export default router;
