import catchAsync from '../utils/catchAsync.js';
import * as evaluationService from '../services/evaluation.service.js';
import * as evaluationEssayGradeService from '../services/evaluationEssayGrade.service.js';
import { buildEvaluationExportBuffer } from '../utils/evaluationExcel.service.js';

const getEvaluation = catchAsync(async (req, res) => {
  const result = await evaluationService.default.getEvaluationData(req.query);
  res.send(result);
});

/**
 * GET /v1/training/evaluation/export — full filtered evaluation rows as .xlsx (omit page/limit).
 */
const exportEvaluationExcel = catchAsync(async (req, res) => {
  const { page: _page, limit: _limit, ...query } = req.query;
  const result = await evaluationService.default.getEvaluationData(query);
  const buf = buildEvaluationExportBuffer(result.evaluations || []);
  const date = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
  res.setHeader('Content-Disposition', `attachment; filename="training-evaluation-export-${date}.xlsx"`);
  res.send(buf);
});

/**
 * GET Q&A attempts for a student on a course (trainer).
 */
const listStudentEssayAttempts = catchAsync(async (req, res) => {
  const { studentId, moduleId } = req.params;
  const result = await evaluationEssayGradeService.listStudentEssayAttempts(studentId, moduleId);
  res.send(result);
});

/**
 * PATCH trainer marks on a Q&A attempt.
 */
const gradeEssayAttempt = catchAsync(async (req, res) => {
  const reviewerId = req.user.id || req.user._id;
  const result = await evaluationEssayGradeService.gradeEssayAttemptByTrainer(
    req.params.attemptId,
    reviewerId,
    req.body
  );
  res.send(result);
});

export default {
  getEvaluation,
  exportEvaluationExcel,
  listStudentEssayAttempts,
  gradeEssayAttempt,
};
