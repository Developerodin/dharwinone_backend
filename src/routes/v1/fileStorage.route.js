import express from 'express';
import multer from 'multer';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import * as fileStorageValidation from '../../validations/fileStorage.validation.js';
import * as fileStorageController from '../../controllers/fileStorage.controller.js';

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

router
  .route('/list')
  .get(auth(), validate(fileStorageValidation.list), fileStorageController.list);

router
  .route('/upload')
  .post(auth(), upload.single('file'), validate(fileStorageValidation.upload), fileStorageController.upload);

router
  .route('/download')
  .get(auth(), validate(fileStorageValidation.getDownload), fileStorageController.download);

router
  .route('/object')
  .delete(auth(), validate(fileStorageValidation.deleteObject), fileStorageController.deleteObject);

router
  .route('/folder')
  .post(auth(), validate(fileStorageValidation.createFolder), fileStorageController.createFolder);

export default router;
