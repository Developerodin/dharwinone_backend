import express from 'express';
import multer from 'multer';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
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
  .get(auth(), requirePermissions('files-storage.read'), validate(fileStorageValidation.list), fileStorageController.list);

router
  .route('/upload')
  .post(
    auth(),
    requirePermissions('files-storage.manage'),
    upload.single('file'),
    validate(fileStorageValidation.upload),
    fileStorageController.upload
  );

router
  .route('/download')
  .get(auth(), requirePermissions('files-storage.read'), validate(fileStorageValidation.getDownload), fileStorageController.download);

router
  .route('/object')
  .delete(auth(), requirePermissions('files-storage.manage'), validate(fileStorageValidation.deleteObject), fileStorageController.deleteObject);

router
  .route('/folder')
  .post(auth(), requirePermissions('files-storage.manage'), validate(fileStorageValidation.createFolder), fileStorageController.createFolder);

router
  .route('/send-to-chat')
  .post(
    auth(),
    requirePermissions('files-storage.read', 'chats.read'),
    validate(fileStorageValidation.sendToChat),
    fileStorageController.sendToChat
  );

export default router;
