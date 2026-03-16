import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import {
  createBackdatedAttendanceRequest,
  createBackdatedAttendanceRequestForUser,
  queryBackdatedAttendanceRequests,
  getBackdatedAttendanceRequestById,
  approveBackdatedAttendanceRequest,
  rejectBackdatedAttendanceRequest,
  updateBackdatedAttendanceRequest,
  cancelBackdatedAttendanceRequest,
  getBackdatedAttendanceRequestsByStudentId,
  getBackdatedAttendanceRequestsByUserId,
} from '../services/backdatedAttendanceRequest.service.js';

const create = catchAsync(async (req, res) => {
  const { studentId } = req.params;
  const { attendanceEntries, notes } = req.body;

  const request = await createBackdatedAttendanceRequest(studentId, attendanceEntries, notes, req.user);

  res.status(httpStatus.CREATED).send({
    success: true,
    message: 'Backdated attendance request created successfully',
    data: request,
  });
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['student', 'status']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);

  const result = await queryBackdatedAttendanceRequests(filter, options, req.user);

  res.status(httpStatus.OK).send({
    success: true,
    data: result,
  });
});

const get = catchAsync(async (req, res) => {
  const { requestId } = req.params;

  const request = await getBackdatedAttendanceRequestById(requestId, req.user);

  res.status(httpStatus.OK).send({
    success: true,
    data: request,
  });
});

const approve = catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const { adminComment } = req.body;

  const result = await approveBackdatedAttendanceRequest(requestId, adminComment, req.user);

  res.status(httpStatus.OK).send({
    success: true,
    message: result.message,
    data: result.data,
  });
});

const reject = catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const { adminComment } = req.body;

  const request = await rejectBackdatedAttendanceRequest(requestId, adminComment, req.user);

  res.status(httpStatus.OK).send({
    success: true,
    message: 'Backdated attendance request rejected successfully',
    data: request,
  });
});

const update = catchAsync(async (req, res) => {
  const { requestId } = req.params;
  const { attendanceEntries, notes } = req.body;

  const request = await updateBackdatedAttendanceRequest(
    requestId,
    { attendanceEntries, notes },
    req.user
  );

  res.status(httpStatus.OK).send({
    success: true,
    message: 'Backdated attendance request updated successfully',
    data: request,
  });
});

const cancel = catchAsync(async (req, res) => {
  const { requestId } = req.params;

  const request = await cancelBackdatedAttendanceRequest(requestId, req.user);

  res.status(httpStatus.OK).send({
    success: true,
    message: 'Backdated attendance request cancelled successfully',
    data: request,
  });
});

const getByStudent = catchAsync(async (req, res) => {
  const { studentId } = req.params;
  const options = pick(req.query, ['sortBy', 'limit', 'page', 'status']);

  const result = await getBackdatedAttendanceRequestsByStudentId(studentId, options, req.user);

  res.status(httpStatus.OK).send({
    success: true,
    data: result,
  });
});

const createMe = catchAsync(async (req, res) => {
  const { attendanceEntries, notes } = req.body;
  const userId = req.user.id || req.user._id?.toString?.();

  const request = await createBackdatedAttendanceRequestForUser(userId, attendanceEntries, notes, req.user);

  res.status(httpStatus.CREATED).send({
    success: true,
    message: 'Backdated attendance request created successfully',
    data: request,
  });
});

const getByUserMe = catchAsync(async (req, res) => {
  const userId = req.user.id || req.user._id?.toString?.();
  const options = pick(req.query, ['sortBy', 'limit', 'page', 'status']);

  const result = await getBackdatedAttendanceRequestsByUserId(userId, options, req.user);

  res.status(httpStatus.OK).send({
    success: true,
    data: result,
  });
});

export {
  create,
  createMe,
  list,
  get,
  approve,
  reject,
  update,
  cancel,
  getByStudent,
  getByUserMe,
};
