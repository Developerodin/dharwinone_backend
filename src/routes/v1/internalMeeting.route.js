import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as internalMeetingValidation from '../../validations/internalMeeting.validation.js';
import * as internalMeetingController from '../../controllers/internalMeeting.controller.js';

const router = express.Router();

router
  .route('/')
  .post(
    auth(),
    requirePermissions('meetings.create'),
    validate(internalMeetingValidation.createInternalMeeting),
    internalMeetingController.create
  )
  .get(
    // Auth only — scope returns all:all | read:own | invitee:own so Employees
    // see Communication invites on the dashboard without meetings.read.
    auth(),
    validate(internalMeetingValidation.getInternalMeetings),
    internalMeetingController.list
  );

router
  .route('/:id/resend-invitations')
  .post(
    auth(),
    requirePermissions('meetings.edit'),
    validate(internalMeetingValidation.resendInternalInvitations),
    internalMeetingController.resendInvitations
  );

router
  .route('/:id/recordings')
  .get(
    auth(),
    // Recording is a VIEW-tier action (row icon shown to any user who can see the list).
    requirePermissions('meetings.read'),
    validate(internalMeetingValidation.getInternalMeetingRecordings),
    internalMeetingController.getRecordings
  );

// One-off meeting "Cancel meeting" — DELETE tier, deliberately separate from the generic
// PATCH /:id (EDIT tier) below. Recurring meetings/series are cancelled via DELETE /:id
// (mode=single|future|series), which already requires meetings.delete.
router
  .route('/:id/cancel')
  .patch(
    auth(),
    requirePermissions('meetings.delete'),
    validate(internalMeetingValidation.cancelInternalMeeting),
    internalMeetingController.cancel
  );

router
  .route('/:id')
  .get(
    // Reading a meeting's details is a VIEW action, not an EDIT one: this endpoint backs
    // both the read-only detail view and the edit-form prefill. Gating it on `meetings.edit`
    // made the detail view unreachable for view-only roles. WHICH meetings are readable is
    // still enforced by internalMeetingScope in the controller (404 when out of scope).
    auth(),
    requirePermissions('meetings.read'),
    validate(internalMeetingValidation.getInternalMeeting),
    internalMeetingController.get
  )
  .patch(
    auth(),
    requirePermissions('meetings.edit'),
    validate(internalMeetingValidation.updateInternalMeeting),
    internalMeetingController.update
  )
  .delete(
    auth(),
    requirePermissions('meetings.delete'),
    validate(internalMeetingValidation.deleteInternalMeeting),
    internalMeetingController.remove
  );

export default router;
