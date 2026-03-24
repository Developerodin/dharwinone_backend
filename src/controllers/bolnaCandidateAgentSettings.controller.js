import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as bolnaCandidateAgentSettingsService from '../services/bolnaCandidateAgentSettings.service.js';

const getBolnaCandidateAgentSettings = catchAsync(async (req, res) => {
  const data = await bolnaCandidateAgentSettingsService.getBolnaCandidateAgentSettings();
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const patchBolnaCandidateAgentSettings = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  const data = await bolnaCandidateAgentSettingsService.updateBolnaCandidateAgentSettings(req.body, userId);
  res.status(httpStatus.OK).send({ success: true, ...data });
});

export { getBolnaCandidateAgentSettings, patchBolnaCandidateAgentSettings };
