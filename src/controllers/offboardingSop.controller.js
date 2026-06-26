import catchAsync from '../utils/catchAsync.js';
import { getOffboardingConfig, saveOffboardingConfig } from '../services/offboardingConfig.service.js';
import { evaluateOffboardingForEmployee } from '../services/offboardingChecklist.service.js';
import { runOffboardingStep } from '../services/offboardingActions.service.js';

const getConfig = catchAsync(async (req, res) => {
  res.send(await getOffboardingConfig());
});

const putConfig = catchAsync(async (req, res) => {
  res.send(await saveOffboardingConfig({ steps: req.body.steps }));
});

const getStatus = catchAsync(async (req, res) => {
  res.send(await evaluateOffboardingForEmployee(req.params.employeeId));
});

const runStep = catchAsync(async (req, res) => {
  res.send(await runOffboardingStep(req.params.employeeId, req.params.stepKey, req.body));
});

export default { getConfig, putConfig, getStatus, runStep };
