import express from 'express';
import auth from '../../middlewares/auth.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import validate from '../../middlewares/validate.js';
import * as recruiterNoteValidation from '../../validations/recruiterNote.validation.js';
import * as recruiterNoteController from '../../controllers/recruiterNote.controller.js';

const router = express.Router();

router
  .route('/:recruiterId/notes')
  .get(
    auth(),
    requirePermissions('recruiters.read'),
    validate(recruiterNoteValidation.listNotes),
    recruiterNoteController.listNotes
  )
  .post(
    auth(),
    requirePermissions('recruiters.update'),
    validate(recruiterNoteValidation.createNote),
    recruiterNoteController.createNote
  );

router
  .route('/notes/:noteId')
  .delete(
    auth(),
    requirePermissions('recruiters.update'),
    validate(recruiterNoteValidation.deleteNote),
    recruiterNoteController.deleteNote
  );

router
  .route('/:recruiterId/share-email')
  .post(
    auth(),
    requirePermissions('recruiters.read'),
    validate(recruiterNoteValidation.shareByEmail),
    recruiterNoteController.shareByEmail
  );

export default router;
