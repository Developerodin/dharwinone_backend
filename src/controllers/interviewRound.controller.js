import catchAsync from '../utils/catchAsync.js';
import * as interviewRoundService from '../services/interviewRound.service.js';

/** GET /v1/meetings/rounds?applicationId=... — one application's whole interview journey. */
const getRoundHistory = catchAsync(async (req, res) => {
  const history = await interviewRoundService.getRoundHistoryForApplication(
    req.query.applicationId,
    req.user
  );
  res.send(history);
});

export default { getRoundHistory };
