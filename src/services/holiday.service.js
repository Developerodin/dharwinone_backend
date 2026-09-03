import httpStatus from 'http-status';
import Holiday from '../models/holiday.model.js';
import ApiError from '../utils/ApiError.js';

/** Escape special regex chars in a string for safe $regex use */
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Create a new holiday
 * @param {Object} holidayBody
 * @param {Object} user - Current user
 * @returns {Promise<Holiday>}
 */
const createHoliday = async (holidayBody, _user) => {
  const { title, date, endDate, isActive, group } = holidayBody;

  const normalizedDate = new Date(date);
  normalizedDate.setUTCHours(0, 0, 0, 0);

  let normalizedEndDate = null;
  if (endDate != null && endDate !== '') {
    normalizedEndDate = new Date(endDate);
    normalizedEndDate.setUTCHours(0, 0, 0, 0);
    if (normalizedEndDate.getTime() < normalizedDate.getTime()) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'End date must be on or after start date');
    }
  }

  const holiday = await Holiday.create({
    title,
    date: normalizedDate,
    endDate: normalizedEndDate,
    isActive: isActive !== undefined ? isActive : true,
    group: group != null ? group : '',
  });

  return holiday;
};

/**
 * Query holidays
 * @param {Object} filter - Mongo filter
 * @param {Object} options - Query options
 * @returns {Promise<QueryResult>}
 */
const queryHolidays = async (filter, options) => {
  if (filter.startDate || filter.endDate) {
    filter.date = {};
    if (filter.startDate) {
      const startDate = new Date(filter.startDate);
      startDate.setHours(0, 0, 0, 0);
      filter.date.$gte = startDate;
      delete filter.startDate;
    }
    if (filter.endDate) {
      const endDate = new Date(filter.endDate);
      endDate.setHours(23, 59, 59, 999);
      filter.date.$lte = endDate;
      delete filter.endDate;
    }
  }

  if (filter.date && !filter.date.$gte) {
    const dateFilter = new Date(filter.date);
    dateFilter.setHours(0, 0, 0, 0);
    const nextDay = new Date(dateFilter);
    nextDay.setDate(nextDay.getDate() + 1);
    filter.date = {
      $gte: dateFilter,
      $lt: nextDay,
    };
  }

  if (filter.title && typeof filter.title === 'string') {
    const trimmed = filter.title.trim();
    if (trimmed) {
      filter.title = { $regex: escapeRegex(trimmed), $options: 'i' };
    } else {
      delete filter.title;
    }
  }

  if (filter.group && typeof filter.group === 'string') {
    const trimmed = filter.group.trim();
    if (trimmed) {
      filter.group = { $regex: escapeRegex(trimmed), $options: 'i' };
    } else {
      delete filter.group;
    }
  }

  const holidays = await Holiday.paginate(filter, options);
  return holidays;
};

/**
 * Get holiday by id
 * @param {ObjectId} id
 * @returns {Promise<Holiday>}
 */
const getHolidayById = async (id) => {
  const holiday = await Holiday.findById(id);
  if (!holiday) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Holiday not found');
  }
  return holiday;
};

/**
 * Update holiday by id
 * @param {ObjectId} holidayId
 * @param {Object} updateBody
 * @param {Object} user - Current user
 * @returns {Promise<Holiday>}
 */
const updateHolidayById = async (holidayId, updateBody, _user) => {
  const holiday = await getHolidayById(holidayId);

  if (updateBody.date) {
    const normalizedDate = new Date(updateBody.date);
    normalizedDate.setUTCHours(0, 0, 0, 0);
    updateBody.date = normalizedDate;
  }
  if (updateBody.endDate !== undefined) {
    if (updateBody.endDate == null || updateBody.endDate === '') {
      updateBody.endDate = null;
    } else {
      const normalizedEndDate = new Date(updateBody.endDate);
      normalizedEndDate.setUTCHours(0, 0, 0, 0);
      const start = updateBody.date ? new Date(updateBody.date) : holiday.date;
      if (normalizedEndDate.getTime() < new Date(start).getTime()) {
        throw new ApiError(httpStatus.BAD_REQUEST, 'End date must be on or after start date');
      }
      updateBody.endDate = normalizedEndDate;
    }
  }

  Object.assign(holiday, updateBody);
  await holiday.save();
  return holiday;
};

/**
 * Delete holiday by id
 * @param {ObjectId} holidayId
 * @param {Object} user - Current user
 * @returns {Promise<Holiday>}
 */
const deleteHolidayById = async (holidayId, _user) => {
  const holiday = await getHolidayById(holidayId);
  await Holiday.findByIdAndDelete(holidayId);
  return holiday;
};

export {
  createHoliday,
  queryHolidays,
  getHolidayById,
  updateHolidayById,
  deleteHolidayById,
};
