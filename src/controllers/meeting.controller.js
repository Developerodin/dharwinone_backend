import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import { buildMeetingsMongoFilter } from '../utils/meetingQueryFilter.js';
import * as meetingService from '../services/meeting.service.js';
import recordingService from '../services/recording.service.js';
import { writeAtsAudit } from '../services/atsAudit.service.js';
import { writeDedupedInterviewViewAudit } from '../utils/interviewViewAuditDedup.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const auditActorId = (req) => String(req.user?.id || req.user?._id || '');

const create = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const result = await meetingService.createMeeting(req.body, userId);
  res.status(httpStatus.CREATED).send(result);
});

const list = catchAsync(async (req, res) => {
  const filter = buildMeetingsMongoFilter(req.query);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const scopeOptions =
    String(req.query.scope || '').trim().toLowerCase() === 'mine' ? { listScope: 'mine' } : {};
  const result = await meetingService.queryMeetings(filter, options, req.user, scopeOptions);
  res.send(result);
});

const listMyInterviews = catchAsync(async (req, res) => {
  const options = pick(req.query, ['sortBy', 'limit', 'page', 'applicationId', 'includePast']);
  const result = await meetingService.queryMyInterviews(req.user, options);
  res.send(result);
});

const get = catchAsync(async (req, res) => {
  const meeting = await meetingService.getMeetingById(req.params.id, req.user);
  if (!meeting) {
    return res.status(httpStatus.NOT_FOUND).send({ message: 'Meeting not found' });
  }
  res.send(meeting);
});

const update = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const before = await meetingService.getMeetingById(req.params.id, req.user);
  if (!before) {
    return res.status(httpStatus.NOT_FOUND).send({ message: 'Meeting not found' });
  }
  const result = await meetingService.updateMeetingById(req.params.id, req.body, userId, req.user);
  const changes = [];
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'interviewResult')) {
    changes.push({
      field: 'interviewResult',
      from: before.interviewResult ?? null,
      to: result.interviewResult ?? null,
    });
  }
  if (Object.prototype.hasOwnProperty.call(req.body || {}, 'interviewScorecard')) {
    changes.push({
      field: 'interviewScorecard',
      from: before.interviewScorecard ?? null,
      to: result.interviewScorecard ?? null,
    });
  }
  const auditAction =
    changes.some((c) => c.field === 'interviewResult') && changes.length
      ? ActivityActions.INTERVIEW_RESULT_UPDATE
      : ActivityActions.INTERVIEW_UPDATE;
  await writeAtsAudit(
    auditActorId(req),
    {
      action: auditAction,
      entityType: EntityTypes.MEETING,
      entityId: String(req.params.id),
      metadata: {
        fieldsUpdated: Object.keys(req.body || {}),
        ...(changes.length ? { changes } : {}),
      },
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.send(result);
});

const remove = catchAsync(async (req, res) => {
  await meetingService.deleteMeetingById(req.params.id, req.user);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_DELETE,
      entityType: EntityTypes.MEETING,
      entityId: String(req.params.id),
      metadata: {},
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.status(httpStatus.NO_CONTENT).send();
});

const resendInvitations = catchAsync(async (req, res) => {
  const result = await meetingService.resendMeetingInvitations(req.params.id, req.user);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_INVITATION_RESEND,
      entityType: EntityTypes.MEETING,
      entityId: String(req.params.id),
      metadata: {},
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.send(result);
});

const getRecordings = catchAsync(async (req, res) => {
  const meeting = await meetingService.getMeetingById(req.params.id, req.user);
  if (!meeting) {
    return res.status(httpStatus.NOT_FOUND).send({ message: 'Meeting not found' });
  }
  const list = await recordingService.listByMeetingId(req.params.id);
  await writeDedupedInterviewViewAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_RECORDING_VIEW,
      entityType: EntityTypes.MEETING,
      entityId: String(req.params.id),
      metadata: { recordingCount: list?.length ?? 0 },
    },
    req
  );
  res.send(list);
});

const endMeetingByRoomPublic = catchAsync(async (req, res) => {
  const { roomName } = req.body;
  const hostEmail = req.user?.email;
  if (!hostEmail) {
    return res.status(httpStatus.UNAUTHORIZED).send({ message: 'Authentication required for host actions' });
  }
  const result = await meetingService.endMeetingByRoomPublic(roomName, hostEmail);
  res.send(result);
});

const moveToPreboarding = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const result = await meetingService.moveMeetingToPreboarding(req.params.id, userId, req.user);
  await writeAtsAudit(
    auditActorId(req),
    {
      action: ActivityActions.INTERVIEW_MOVE_TO_PREBOARDING,
      entityType: EntityTypes.MEETING,
      entityId: String(req.params.id),
      metadata: {},
    },
    req,
    { editContext: { staffEdit: true } }
  );
  res.send(result);
});

const internalTransfer = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const body = pick(req.body, ['designation', 'departmentId', 'effectiveDate']);
  const result = await meetingService.transferEmployeeInternally(req.params.id, userId, body, req.user);
  res.send(result);
});

const getLinkage = catchAsync(async (req, res) => {
  const result = await meetingService.getMeetingLinkage(req.params.id, req.user);
  res.send(result);
});

const patchLinkage = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const body = pick(req.body, ['applicationId', 'round', 'interviewLanguage', 'expectedRevision']);
  const result = await meetingService.patchMeetingLinkage(req.params.id, body, userId, req.user);
  res.send(result);
});

const createApplication = catchAsync(async (req, res) => {
  const userId = req.user?._id?.toString() || req.user?.id;
  const result = await meetingService.createExplicitApplicationForMeeting(req.params.id, userId, req.user);
  res.status(httpStatus.CREATED).send(result);
});

export {
  create,
  list,
  listMyInterviews,
  get,
  update,
  remove,
  resendInvitations,
  getRecordings,
  endMeetingByRoomPublic,
  moveToPreboarding,
  internalTransfer,
  getLinkage,
  patchLinkage,
  createApplication,
};
