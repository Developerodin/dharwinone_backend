import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import {
  createHolidayGroup,
  queryHolidayGroups,
  getHolidayGroupById,
  updateHolidayGroupById,
  deleteHolidayGroupById,
  assignGroupHolidays,
  removeGroupHolidays,
} from '../services/holidayGroup.service.js';

const create = catchAsync(async (req, res) => {
  const group = await createHolidayGroup(req.body, req.user);
  res.status(httpStatus.CREATED).send({
    success: true,
    message: 'Holiday group created successfully',
    data: group,
  });
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'isActive']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryHolidayGroups(filter, options);
  res.status(httpStatus.OK).send({ success: true, data: result });
});

const get = catchAsync(async (req, res) => {
  const group = await getHolidayGroupById(req.params.groupId);
  res.status(httpStatus.OK).send({ success: true, data: group });
});

const update = catchAsync(async (req, res) => {
  const group = await updateHolidayGroupById(req.params.groupId, req.body);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Holiday group updated successfully',
    data: group,
  });
});

const remove = catchAsync(async (req, res) => {
  const result = await deleteHolidayGroupById(req.params.groupId);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Holiday group deleted successfully',
    data: { holidaysUngrouped: result.holidaysUngrouped },
  });
});

const assign = catchAsync(async (req, res) => {
  const result = await assignGroupHolidays(req.params.groupId, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Group holidays assigned to all members',
    data: result,
  });
});

const unassign = catchAsync(async (req, res) => {
  const result = await removeGroupHolidays(req.params.groupId, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Group holidays removed from all members',
    data: result,
  });
});

export { create, list, get, update, remove, assign, unassign };
