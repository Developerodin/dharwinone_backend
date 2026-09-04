import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import { uploadSingle } from '../../middlewares/upload.js';
import * as recruiterExcelController from '../../controllers/recruiterExcel.controller.js';

const router = express.Router();

router
  .route('/export/excel')
  .get(auth(), requirePermissions('recruiters.manage'), recruiterExcelController.exportExcel);

router
  .route('/template/excel')
  .get(auth(), requirePermissions('recruiters.manage'), recruiterExcelController.getTemplate);

router
  .route('/import/excel')
  .post(auth(), requirePermissions('recruiters.manage'), uploadSingle('file'), recruiterExcelController.importExcel);

export default router;
