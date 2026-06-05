import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as positionService from '../services/position.service.js';

const createPosition = catchAsync(async (req, res) => {
  const position = await positionService.createPosition(req.body);
  res.status(httpStatus.CREATED).send(position);
});

const getPositions = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await positionService.queryPositions(filter, options);
  res.send(result);
});

/** List all positions (no pagination) - for dropdowns */
const getAllPositions = catchAsync(async (req, res) => {
  const positions = await positionService.getAllPositions();
  res.send(positions);
});

const getPosition = catchAsync(async (req, res) => {
  const position = await positionService.getPositionById(req.params.positionId);
  if (!position) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Position not found');
  }
  res.send(position);
});

const updatePosition = catchAsync(async (req, res) => {
  const position = await positionService.updatePositionById(req.params.positionId, req.body);
  res.send(position);
});

const deletePosition = catchAsync(async (req, res) => {
  await positionService.deletePositionById(req.params.positionId);
  res.status(httpStatus.NO_CONTENT).send();
});

const getPositionRoster = catchAsync(async (req, res) => {
  const roster = await positionService.getPositionRoster();
  res.send(roster);
});

const getPositionEmployees = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await positionService.queryEmployeesForPosition(req.params.positionId, filter, options);
  res.send(result);
});

const setPositionModules = catchAsync(async (req, res) => {
  const result = await positionService.setPositionModules(req.params.positionId, req.body.moduleIds);
  res.send(result);
});

export {
  createPosition,
  getPositions,
  getAllPositions,
  getPosition,
  getPositionRoster,
  getPositionEmployees,
  setPositionModules,
  updatePosition,
  deletePosition,
};
