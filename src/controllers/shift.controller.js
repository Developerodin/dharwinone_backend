import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import * as shiftService from '../services/shift.service.js';

const create = catchAsync(async (req, res) => {
  const result = await shiftService.createShift(req.body, req.user);
  if (result && typeof result === 'object' && result.shifts && Array.isArray(result.shifts)) {
    const { shifts, errors, partialSuccess } = result;
    res.status(httpStatus.CREATED).send({
      success: true,
      message: partialSuccess
        ? `Created ${shifts.length} shift(s), ${errors.length} failed`
        : `${shifts.length} shift(s) created successfully`,
      data: shifts,
      ...(partialSuccess && { errors, partialSuccess: true }),
    });
  } else if (Array.isArray(result)) {
    res.status(httpStatus.CREATED).send({
      success: true,
      message: `${result.length} shift(s) created successfully`,
      data: result,
    });
  } else {
    res.status(httpStatus.CREATED).send({
      success: true,
      message: 'Shift created successfully',
      data: result,
    });
  }
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'timezone', 'isActive']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await shiftService.queryShifts(filter, options);
  res.status(httpStatus.OK).send({ success: true, data: result });
});

const get = catchAsync(async (req, res) => {
  const shift = await shiftService.getShiftById(req.params.shiftId);
  res.status(httpStatus.OK).send({ success: true, data: shift });
});

const update = catchAsync(async (req, res) => {
  const shift = await shiftService.updateShiftById(req.params.shiftId, req.body, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Shift updated successfully',
    data: shift,
  });
});

const remove = catchAsync(async (req, res) => {
  await shiftService.deleteShiftById(req.params.shiftId, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Shift deleted successfully',
  });
});

const listAssignees = catchAsync(async (req, res) => {
  const result = await shiftService.queryShiftAssignees(
    req.params.shiftId,
    pick(req.query, ['page', 'limit', 'search'])
  );
  res.status(httpStatus.OK).send({ success: true, data: result });
});

export { create, list, get, update, remove, listAssignees };
