import catchAsync from '../utils/catchAsync.js';
import * as evaluationService from '../services/evaluation.service.js';

const getEvaluation = catchAsync(async (req, res) => {
  const result = await evaluationService.default.getEvaluationData();
  res.send(result);
});

export default {
  getEvaluation,
};
