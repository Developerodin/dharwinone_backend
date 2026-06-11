import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as orgScenarioService from '../services/orgScenario.service.js';
import { persistActivityLogFailSoft } from '../services/activityLog.service.js';

const actorId = (req) => String(req.user?.id || req.user?._id);

export const listScenarios = catchAsync(async (req, res) => {
  res.send(await orgScenarioService.listScenarios(req.query));
});

export const createScenario = catchAsync(async (req, res) => {
  const scenario = await orgScenarioService.createScenario(req.body, req.user?._id);
  res.status(httpStatus.CREATED).send(scenario);
});

export const cloneScenario = catchAsync(async (req, res) => {
  res.send(await orgScenarioService.cloneFromLive(req.params.scenarioId, req.user?._id));
});

export const getScenarioTree = catchAsync(async (req, res) => {
  res.send(await orgScenarioService.getScenarioTree(req.params.scenarioId));
});

export const diffScenario = catchAsync(async (req, res) => {
  res.send(await orgScenarioService.diffScenario(req.params.scenarioId));
});

export const reparentScenarioUnit = catchAsync(async (req, res) => {
  res.send(
    await orgScenarioService.reparentScenarioUnit(
      req.params.scenarioId,
      req.params.scenarioUnitId,
      req.body.parentScenarioUnitId ?? null
    )
  );
});

export const deleteScenario = catchAsync(async (req, res) => {
  res.send(await orgScenarioService.deleteScenario(req.params.scenarioId));
});

export const approveScenario = catchAsync(async (req, res) => {
  res.send(await orgScenarioService.approveScenario(req.params.scenarioId, req.user?._id));
});

export const applyScenario = catchAsync(async (req, res) => {
  const envelope = await orgScenarioService.applyScenario(req.params.scenarioId, req.user?._id);
  await persistActivityLogFailSoft(actorId(req), envelope, req);
  res.send({ ...envelope.result.toJSON?.() ?? envelope.result, scenarioApplyId: envelope.audit.metadata.scenarioApplyId });
});
