import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import catchAsync from '../utils/catchAsync.js';
import {
  createHoliday,
  queryHolidays,
  getHolidayById,
  updateHolidayById,
  deleteHolidayById,
} from '../services/holiday.service.js';

const create = catchAsync(async (req, res) => {
  const holiday = await createHoliday(req.body, req.user);
  res.status(httpStatus.CREATED).send({
    success: true,
    message: 'Holiday created successfully',
    data: holiday,
  });
});

const list = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['title', 'group', 'date', 'startDate', 'endDate', 'isActive']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await queryHolidays(filter, options);
  res.status(httpStatus.OK).send({
    success: true,
    data: result,
  });
});

const get = catchAsync(async (req, res) => {
  const holiday = await getHolidayById(req.params.holidayId);
  res.status(httpStatus.OK).send({
    success: true,
    data: holiday,
  });
});

const update = catchAsync(async (req, res) => {
  const holiday = await updateHolidayById(req.params.holidayId, req.body, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Holiday updated successfully',
    data: holiday,
  });
});

const remove = catchAsync(async (req, res) => {
  await deleteHolidayById(req.params.holidayId, req.user);
  res.status(httpStatus.OK).send({
    success: true,
    message: 'Holiday deleted successfully',
  });
});

export { create, list, get, update, remove };
