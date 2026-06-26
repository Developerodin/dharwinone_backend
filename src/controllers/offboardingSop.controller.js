import catchAsync from '../utils/catchAsync.js';
import { getOffboardingConfig, saveOffboardingConfig } from '../services/offboardingConfig.service.js';
import {
  evaluateOffboardingForEmployee,
  listOpenOffboardingOverview,
} from '../services/offboardingChecklist.service.js';
import { runOffboardingStep } from '../services/offboardingActions.service.js';

const getConfig = catchAsync(async (req, res) => {
  res.send(await getOffboardingConfig());
});

const putConfig = catchAsync(async (req, res) => {
  res.send(await saveOffboardingConfig({ steps: req.body.steps }));
});

const getOverview = catchAsync(async (req, res) => {
  const limit = req.query.limit != null ? Number(req.query.limit) : undefined;
  res.send(await listOpenOffboardingOverview({ limit }));
});

const getStatus = catchAsync(async (req, res) => {
  res.send(await evaluateOffboardingForEmployee(req.params.employeeId));
});

const runStep = catchAsync(async (req, res) => {
  res.send(await runOffboardingStep(req.params.employeeId, req.params.stepKey, req.body));
});

export default { getConfig, putConfig, getOverview, getStatus, runStep };
