import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import StudentEssayAttempt from '../models/studentEssayAttempt.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import { buildEssayResultsResponse } from './studentEssay.service.js';
import {
  clampQuestionScore,
  questionMaxMarks,
  totalMaxMarks,
  sumObtainedMarks,
  percentageFromMarks,
  isEveryRequiredQuestionScored,
} from '../utils/essayMarks.util.js';

/**
 * List Q&A attempts for a student on a course, grouped by playlist item (trainer view).
 * @param {string} studentId
 * @param {string} moduleId
 */
export async function listStudentEssayAttempts(studentId, moduleId) {
  const module = await TrainingModule.findById(moduleId).select('playlist students moduleName').lean();
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  const studentExists = await Student.exists({ _id: studentId });
  if (!studentExists) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const essayItems = (module.playlist || [])
    .map((item, index) => ({ item, playlistItemId: String(index) }))
    .filter(({ item }) => item.contentType === 'essay' && item.essay?.questions?.length);

  const attempts = await StudentEssayAttempt.find({ student: studentId, module: moduleId })
    .sort({ playlistItemId: 1, attemptNumber: -1 })
    .lean();

  const byItem = new Map();
  for (const a of attempts) {
    const key = String(a.playlistItemId);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(a);
  }

  const items = essayItems.map(({ item, playlistItemId }) => {
    const itemAttempts = byItem.get(playlistItemId) || [];
    const latest = itemAttempts[0];
    const latestStatus = latest?.status === 'reviewed' ? 'graded' : latest?.status;
    return {
      playlistItemId,
      title: item.title,
      passPercentage: item.essay?.passPercentage,
      questionCount: item.essay.questions.length,
      pending: latest ? latestStatus !== 'graded' : false,
      attempts: itemAttempts.map((attempt) => ({
        attemptId: String(attempt._id),
        ...buildEssayResultsResponse(item, playlistItemId, attempt, { includeExpectedAnswer: true }),
      })),
    };
  });

  return {
    moduleId,
    moduleName: module.moduleName,
    studentId,
    items,
  };
}

/**
 * Trainer assigns or edits marks on a Q&A attempt.
 * @param {string} attemptId
 * @param {string} reviewerUserId
 * @param {{ answers: Array<{ questionIndex: number, score: number, feedback?: string }>, feedback?: string }} body
 */
export async function gradeEssayAttemptByTrainer(attemptId, reviewerUserId, body) {
  if (!mongoose.isValidObjectId(attemptId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid attempt id');
  }

  const attempt = await StudentEssayAttempt.findById(attemptId);
  if (!attempt) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Q&A attempt not found');
  }

  const module = await TrainingModule.findById(attempt.module).select('playlist').lean();
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  const itemIndex = parseInt(attempt.playlistItemId, 10);
  const playlistItem = module.playlist?.[itemIndex];
  if (!playlistItem || playlistItem.contentType !== 'essay') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Playlist item is not an essay');
  }

  const questions = playlistItem.essay?.questions ?? [];
  const incoming = Array.isArray(body.answers) ? body.answers : [];
  const merged = questions.map((q, i) => {
    const existing = attempt.answers.find((a) => Number(a.questionIndex) === i) || {
      questionIndex: i,
      typedAnswer: '',
    };
    const patch = incoming.find((a) => Number(a.questionIndex) === i);
    const maxMarks = questionMaxMarks(q.maxMarks);
    const score = patch && patch.score != null ? clampQuestionScore(patch.score, maxMarks) : existing.score;
    return {
      questionIndex: i,
      typedAnswer: existing.typedAnswer || '',
      score,
      feedback: patch?.feedback != null ? String(patch.feedback).slice(0, 1000) : existing.feedback,
      rubric: existing.rubric,
      suggestions: existing.suggestions,
    };
  });

  if (!isEveryRequiredQuestionScored(questions, merged)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Every required question must have a numeric score.');
  }

  const maxMarks = totalMaxMarks(questions);
  const obtainedMarks = sumObtainedMarks(merged);
  const percentage = percentageFromMarks(obtainedMarks, maxMarks) ?? 0;

  attempt.answers = merged;
  attempt.score = {
    totalQuestions: questions.length,
    correctAnswers: merged.filter((a) => typeof a.score === 'number').length,
    percentage,
    obtainedMarks,
    maxMarks,
  };
  attempt.status = 'graded';
  attempt.reviewedBy = reviewerUserId;
  if (body.feedback != null) attempt.feedback = String(body.feedback).slice(0, 2000);
  attempt.markModified('answers');
  attempt.markModified('score');
  await attempt.save();

  return buildEssayResultsResponse(playlistItem, attempt.playlistItemId, attempt, {
    includeExpectedAnswer: true,
  });
}
