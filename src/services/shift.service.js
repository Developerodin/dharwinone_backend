import httpStatus from 'http-status';
import Shift from '../models/shift.model.js';
import ApiError from '../utils/ApiError.js';
import pick from '../utils/pick.js';

const createSingleShift = async (shiftBody) => {
  const { name, description, timezone, startTime, endTime, isActive } = shiftBody;
  const [startHours, startMinutes] = startTime.split(':').map(Number);
  const [endHours, endMinutes] = endTime.split(':').map(Number);
  const startTotalMinutes = startHours * 60 + startMinutes;
  const endTotalMinutes = endHours * 60 + endMinutes;
  if (endTotalMinutes === startTotalMinutes) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'End time cannot be the same as start time');
  }
  const shift = await Shift.create({
    name,
    description,
    timezone,
    startTime,
    endTime,
    isActive: isActive !== undefined ? isActive : true,
  });
  return shift;
};

const createShift = async (shiftBody, user) => {
  if (Array.isArray(shiftBody)) {
    if (shiftBody.length === 0) throw new ApiError(httpStatus.BAD_REQUEST, 'At least one shift is required');
    if (shiftBody.length > 100) throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot create more than 100 shifts at once');
    const shifts = [];
    const errors = [];
    for (let i = 0; i < shiftBody.length; i++) {
      try {
        shifts.push(await createSingleShift(shiftBody[i]));
      } catch (err) {
        errors.push({ index: i, shift: shiftBody[i], error: err.message });
      }
    }
    if (shifts.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, `Failed to create shifts: ${errors.map((e) => `Shift ${e.index + 1}: ${e.error}`).join('; ')}`);
    }
    return errors.length > 0 ? { shifts, errors, partialSuccess: true } : shifts;
  }
  return await createSingleShift(shiftBody);
};

const queryShifts = async (filter, options) => {
  const query = { ...filter };
  if (query.name && typeof query.name === 'string' && query.name.trim()) {
    query.name = { $regex: query.name.trim(), $options: 'i' };
  }
  return await Shift.paginate(query, options);
};

const getShiftById = async (id) => {
  const shift = await Shift.findById(id);
  if (!shift) throw new ApiError(httpStatus.NOT_FOUND, 'Shift not found');
  return shift;
};

const updateShiftById = async (shiftId, updateBody, user) => {
  const shift = await getShiftById(shiftId);
  const startTime = updateBody.startTime ?? shift.startTime;
  const endTime = updateBody.endTime ?? shift.endTime;
  if (startTime && endTime) {
    const [sh, sm] = startTime.split(':').map(Number);
    const [eh, em] = endTime.split(':').map(Number);
    if (eh * 60 + em === sh * 60 + sm) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'End time cannot be the same as start time');
    }
  }
  Object.assign(shift, updateBody);
  await shift.save();
  return shift;
};

const deleteShiftById = async (shiftId, user) => {
  const shift = await getShiftById(shiftId);
  await Shift.findByIdAndDelete(shiftId);
  return shift;
};

export {
  createShift,
  queryShifts,
  getShiftById,
  updateShiftById,
  deleteShiftById,
};
