import multer from 'multer';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

const ALLOWED_MIMES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const MAX_BYTES = 5 * 1024 * 1024;

const storage = multer.memoryStorage();

export const teamUpload = multer({
  storage,
  limits: { fileSize: MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIMES.has(file.mimetype)) {
      return cb(new ApiError(httpStatus.BAD_REQUEST, 'Invalid Excel file', false, undefined,
        [{ type: 'invalid_mime', received: file.mimetype }]));
    }
    cb(null, true);
  },
});
