import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import { teamUpload } from '../../middlewares/teamUploadMulter.js';
import {
  teamsImport as teamsImportRateLimit,
  teamsExport as teamsExportRateLimit,
} from '../../middlewares/rateLimiter.js';
import * as teamValidation from '../../validations/team.validation.js';
import * as teamController from '../../controllers/team.controller.js';
import * as teamExcelController from '../../controllers/teamExcel.controller.js';

const router = express.Router();

router
  .route('/')
  .post(auth(), requirePermissions('teams.manage'), validate(teamValidation.createTeamMember), teamController.create)
  .get(auth(), requirePermissions('teams.read'), validate(teamValidation.getTeamMembers), teamController.list);

router.post(
  '/import',
  auth(),
  requirePermissions('teams.manage'),
  teamsImportRateLimit,
  teamUpload.single('file'),
  validate(teamValidation.importTeams),
  teamExcelController.importExcel
);

router.get(
  '/export',
  auth(),
  requirePermissions('teams.manage'),
  teamsExportRateLimit,
  validate(teamValidation.exportTeams),
  teamExcelController.exportExcel
);

router.get('/import-template', auth(), requirePermissions('teams.manage'), teamExcelController.downloadTemplate);

router.get(
  '/import-logs',
  auth(),
  requirePermissions('teams.manage'),
  validate(teamValidation.listImportLogs),
  teamExcelController.listImportLogs
);

router.route('/orphans/retry-match').post(auth(), requirePermissions('teams.manage'), teamController.retryOrphanMatch);

router
  .route('/:teamMemberId/move')
  .post(auth(), requirePermissions('teams.manage'), validate(teamValidation.moveTeamMember), teamController.moveToTeam);

router
  .route('/:teamMemberId/link')
  .post(auth(), requirePermissions('teams.manage'), validate(teamValidation.linkOrphan), teamController.linkOrphan);

router
  .route('/:teamMemberId/remove')
  .post(auth(), requirePermissions('teams.manage'), validate(teamValidation.softRemoveTeamMember), teamController.softRemove);

router
  .route('/:teamMemberId')
  .get(auth(), requirePermissions('teams.read'), validate(teamValidation.getTeamMember), teamController.get)
  .patch(auth(), requirePermissions('teams.manage'), validate(teamValidation.updateTeamMember), teamController.update)
  .delete(auth(), requirePermissions('teams.manage'), validate(teamValidation.deleteTeamMember), teamController.remove);

export default router;

