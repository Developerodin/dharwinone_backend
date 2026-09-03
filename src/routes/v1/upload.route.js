import express from 'express';
import multer from 'multer';
import auth from '../../middlewares/auth.js';
import { uploadSingleDocument } from '../../controllers/upload.controller.js';

const router = express.Router();

// Use memory storage so file buffer is available for S3 upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.UPLOAD_MAX_FILE_BYTES) || 25 * 1024 * 1024 },
});

// POST /v1/upload/single — auth-only; files are stored under the caller's user id (see uploadFileToS3).
// Self-service profile photos and wizard document uploads must work for Candidate/Student roles that
// lack uploads.document (e.g. settings personal-information only grants personal-information.manage).
router.post('/single', auth(), upload.single('file'), uploadSingleDocument);

export default router;

