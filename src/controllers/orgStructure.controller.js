import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as orgStructureService from '../services/orgStructure.service.js';

export const getTree = catchAsync(async (req, res) => res.send(await orgStructureService.buildTree()));
export const getOrgUnits = catchAsync(async (req, res) => res.send(await orgStructureService.listOrgUnits()));
export const createOrgUnit = catchAsync(async (req, res) => {
  res.status(httpStatus.CREATED).send(await orgStructureService.createOrgUnit(req.body, req.user?._id));
});
export const updateOrgUnit = catchAsync(async (req, res) => res.send(await orgStructureService.updateOrgUnit(req.params.orgUnitId, req.body)));
export const reparentOrgUnit = catchAsync(async (req, res) => res.send(await orgStructureService.reparentOrgUnit(req.params.orgUnitId, req.body.parentId)));
export const assignHead = catchAsync(async (req, res) => res.send(await orgStructureService.assignHead(req.params.orgUnitId, req.body.headEmployeeId)));
export const deactivateOrgUnit = catchAsync(async (req, res) => res.send(await orgStructureService.deactivateOrgUnit(req.params.orgUnitId)));
