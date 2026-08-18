import multer from 'multer';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';

const storage = multer.memoryStorage();

const excelFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        httpStatus.BAD_REQUEST,
        `File type ${file.mimetype} is not allowed. Use Excel files (.xlsx, .xls)`
      ),
      false
    );
  }
};

const excelUpload = multer({
  storage,
  fileFilter: excelFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadSingle = (fieldName = 'file') => (req, res, next) => {
  excelUpload.single(fieldName)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(httpStatus.BAD_REQUEST, 'File size too large. Maximum 10MB.'));
        }
      }
      return next(err);
    }
    next();
  });
};

// Resume and document upload for job applications
const resumeFileFilter = (req, file, cb) => {
  const allowedMimeTypes = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/jpeg',
    'image/jpg',
    'image/png',
  ];
  if (allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        httpStatus.BAD_REQUEST,
        `File type ${file.mimetype} is not allowed. Use PDF, DOC, DOCX, JPG, or PNG files`
      ),
      false
    );
  }
};

const jobApplicationUpload = multer({
  storage,
  fileFilter: resumeFileFilter,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB per file
});

const uploadJobApplicationFiles = (req, res, next) => {
  jobApplicationUpload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'documents', maxCount: 5 }
  ])(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(httpStatus.BAD_REQUEST, 'File size too large. Maximum 10MB per file.'));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return next(new ApiError(httpStatus.BAD_REQUEST, 'Too many files. Maximum 5 additional documents.'));
        }
      }
      return next(err);
    }
    next();
  });
};

// Image/video file filter for support ticket attachments
const imageVideoFileFilter = (req, file, cb) => {
  const allowedImageTypes = [
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/svg+xml',
  ];
  const allowedVideoTypes = [
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-matroska',
  ];
  // Documents/logs advertised by the ticket UI.
  // .log usually arrives as text/plain; do not allow application/octet-stream
  // (would open arbitrary binaries). Extension fallback covers mislabeled Office files.
  const allowedDocTypes = [
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/rtf',
    'text/rtf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ];
  const allowedDocExtensions = [
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.csv',
    '.rtf',
    '.odt',
    '.ods',
    '.odp',
    '.txt',
    '.log',
  ];
  const allowedTypes = [...allowedImageTypes, ...allowedVideoTypes, ...allowedDocTypes];
  const mime = file.mimetype || '';
  const originalName = (file.originalname || '').toLowerCase();
  const hasAllowedDocExt = allowedDocExtensions.some((ext) => originalName.endsWith(ext));
  // Some clients send Office/OOXML as octet-stream or empty MIME; trust extension only then.
  const unlabeledMime = !mime || mime === 'application/octet-stream';

  if (allowedTypes.includes(mime) || (unlabeledMime && hasAllowedDocExt)) {
    cb(null, true);
  } else {
    cb(
      new ApiError(
        httpStatus.BAD_REQUEST,
        `File type ${file.mimetype} is not allowed. Allowed: Images (JPEG, PNG, GIF, WEBP, BMP, SVG), Videos (MP4, WEBM, MOV, AVI, MKV), and Documents (PDF, DOC, DOCX, XLS, XLSX, PPT, PPTX, CSV, RTF, ODT, ODS, ODP, TXT, LOG)`
      ),
      false
    );
  }
};

const imageVideoUpload = multer({
  storage,
  fileFilter: imageVideoFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB per file
});

const uploadImagesVideos = (fieldName = 'attachments', maxCount = 10) => (req, res, next) => {
  imageVideoUpload.array(fieldName, maxCount)(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(httpStatus.BAD_REQUEST, 'File size too large. Maximum 100MB per file.'));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return next(new ApiError(httpStatus.BAD_REQUEST, `Too many files. Maximum ${maxCount} allowed.`));
        }
      }
      return next(err);
    }
    next();
  });
};

const studentProfileImageFilter = (req, file, cb) => {
  const ok = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(file.mimetype);
  cb(
    ok ? null : new ApiError(httpStatus.BAD_REQUEST, 'Only JPEG, PNG, WebP, and GIF images are allowed for profile photos'),
    ok
  );
};

/** Student profile image: strict image types, 5MB max */
const studentProfileImageUpload = multer({
  storage,
  fileFilter: studentProfileImageFilter,
  limits: { fileSize: 5 * 1024 * 1024 },
});

const chatAttachmentFileFilter = (req, file, cb) => {
  const mime = file.mimetype || '';
  const originalName = (file.originalname || '').toLowerCase();
  const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
  const hasVideoExt = videoExtensions.some((ext) => originalName.endsWith(ext));
  const unlabeledMime = !mime || mime === 'application/octet-stream';
  const ok =
    mime.startsWith('image/') ||
    mime.startsWith('audio/') ||
    mime.startsWith('video/') ||
    (unlabeledMime && hasVideoExt) ||
    [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'text/plain',
      'text/csv',
    ].includes(mime);
  cb(
    ok ? null : new ApiError(httpStatus.BAD_REQUEST, `File type ${mime || 'unknown'} is not allowed for chat uploads`),
    ok
  );
};

/** Chat message attachments: images, audio, video, office/PDF/txt; 100MB per file */
const chatAttachmentsUpload = multer({
  storage,
  fileFilter: chatAttachmentFileFilter,
  limits: { fileSize: 100 * 1024 * 1024 },
});

const uploadChatAttachments = (req, res, next) => {
  chatAttachmentsUpload.fields([
    { name: 'files', maxCount: 10 },
    { name: 'file', maxCount: 10 },
  ])(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(httpStatus.BAD_REQUEST, 'File size too large. Maximum 100MB per file.'));
        }
        if (err.code === 'LIMIT_FILE_COUNT') {
          return next(new ApiError(httpStatus.BAD_REQUEST, 'Too many files. Maximum 10 allowed.'));
        }
      }
      return next(err);
    }
    next();
  });
};

// Single-file document upload — used by candidate-self and admin-on-behalf-of-candidate doc endpoints.
const uploadDocumentFile = (req, res, next) => {
  jobApplicationUpload.single('file')(req, res, (err) => {
    if (err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return next(new ApiError(httpStatus.BAD_REQUEST, 'File size too large. Maximum 10MB.'));
        }
      }
      return next(err);
    }
    next();
  });
};

export { uploadSingle, uploadJobApplicationFiles, uploadImagesVideos, studentProfileImageUpload, chatAttachmentsUpload, uploadChatAttachments, uploadDocumentFile };
