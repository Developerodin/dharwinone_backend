import express from 'express';
import multer from 'multer';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as trainingModuleValidation from '../../validations/trainingModule.validation.js';
import * as trainingModuleController from '../../controllers/trainingModule.controller.js';

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
