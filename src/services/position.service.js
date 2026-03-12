import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Position from '../models/position.model.js';

/**
 * Create a position
 * @param {Object} positionBody
 * @returns {Promise<Position>}
 */
const createPosition = async (positionBody) => {
  if (await Position.isNameTaken(positionBody.name)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Position name already taken');
  }
  return Position.create(positionBody);
};

/**
 * Query for positions
 * @param {Object} filter - Mongo filter (name, search)
 * @param {Object} options - Query options
 * @returns {Promise<QueryResult>}
 */
const queryPositions = async (filter, options) => {
  const { search, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };
  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoFilter.$or = [{ name: { $regex: searchRegex } }];
  }
  const positions = await Position.paginate(mongoFilter, options);
  return positions;
};

/**
 * Get all positions (no pagination) - for dropdowns
 * @returns {Promise<Position[]>}
 */
const getAllPositions = async () => {
  return Position.find().sort({ name: 1 }).lean();
};

/**
 * Get position by id
 * @param {ObjectId} id
 * @returns {Promise<Position|null>}
 */
const getPositionById = async (id) => {
  return Position.findById(id);
};

/**
 * Update position by id
 * @param {ObjectId} positionId
 * @param {Object} updateBody
 * @returns {Promise<Position>}
 */
const updatePositionById = async (positionId, updateBody) => {
  const position = await getPositionById(positionId);
  if (!position) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Position not found');
  }
  if (updateBody.name && (await Position.isNameTaken(updateBody.name, positionId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Position name already taken');
  }
  Object.assign(position, updateBody);
  await position.save();
  return position;
};

/**
 * Delete position by id
 * @param {ObjectId} positionId
 * @returns {Promise<Position>}
 */
const deletePositionById = async (positionId) => {
  const position = await getPositionById(positionId);
  if (!position) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Position not found');
  }
  await position.deleteOne();
  return position;
};

export {
  createPosition,
  queryPositions,
  getAllPositions,
  getPositionById,
  updatePositionById,
  deletePositionById,
};
