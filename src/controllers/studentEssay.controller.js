import catchAsync from '../utils/catchAsync.js';
import * as studentEssayService from '../services/studentEssay.service.js';

const submitEssayAttempt = catchAsync(async (req, res) => {
  const { studentId, moduleId, playlistItemId } = req.params;
  const { answers, timeSpent } = req.body;

  const attempt = await studentEssayService.submitEssayAttempt(studentId, moduleId, playlistItemId, {
    answers,
    timeSpent,
  });

  res.send(attempt);
});

export { submitEssayAttempt };
