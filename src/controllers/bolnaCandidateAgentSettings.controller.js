import httpStatus from 'http-status';
import catchAsync from '../utils/catchAsync.js';
import * as bolnaCandidateAgentSettingsService from '../services/bolnaCandidateAgentSettings.service.js';
import { createActivityLog } from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const getBolnaCandidateAgentSettings = catchAsync(async (req, res) => {
  const data = await bolnaCandidateAgentSettingsService.getBolnaCandidateAgentSettings();
  res.status(httpStatus.OK).send({ success: true, ...data });
});

const patchBolnaCandidateAgentSettings = catchAsync(async (req, res) => {
  const userId = req.user?.id || req.user?._id;
  const data = await bolnaCandidateAgentSettingsService.updateBolnaCandidateAgentSettings(req.body, userId);
  if (userId) {
    await createActivityLog(
      String(userId),
      ActivityActions.SETTINGS_BOLNA_CANDIDATE_AGENT_UPDATE,
      EntityTypes.BOLNA_CANDIDATE_AGENT_SETTINGS,
      'default',
      {},
      req
    );
  }
  res.status(httpStatus.OK).send({ success: true, ...data });
});

export { getBolnaCandidateAgentSettings, patchBolnaCandidateAgentSettings };
