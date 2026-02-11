import express from 'express';
import multer from 'multer';
import auth from '../../middlewares/auth.js';
import { uploadSingleDocument } from '../../controllers/upload.controller.js';

const router = express.Router();

// Use memory storage so file buffer is available for S3 upload
const upload = multer({ storage: multer.memoryStorage() });

// POST /v1/upload/single
router.post('/single', auth(), upload.single('file'), uploadSingleDocument);

export default router;

