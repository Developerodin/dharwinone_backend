import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import StudentEssayAttempt from '../models/studentEssayAttempt.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import { markItemComplete } from './studentCourse.service.js';
import { gradeEssayAttempt } from './essayGrade.service.js';
import logger from '../config/logger.js';
import {
  questionMaxMarks,
  totalMaxMarks,
  sumObtainedMarks,
  percentageFromMarks,
  isEveryRequiredQuestionScored,
  passedFromConfig,
} from '../utils/essayMarks.util.js';

/**
 * Load assigned student + essay playlist item or throw.
 * @param {string} studentId
 * @param {string} moduleId
 * @param {string} playlistItemId
 */
const loadAssignedEssayItem = async (studentId, moduleId, playlistItemId) => {
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const isAssigned = module.students.some((id) => id.toString() === studentId.toString());
  if (!isAssigned) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Student is not assigned to this module');
  }

  const itemIndex = parseInt(playlistItemId, 10);
  if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= module.playlist.length) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Essay item not found in playlist');
  }

  const playlistItem = module.playlist[itemIndex];
  if (playlistItem.contentType !== 'essay') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Playlist item is not an essay');
  }

  if (!playlistItem.essay || !playlistItem.essay.questions || playlistItem.essay.questions.length === 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Essay has no questions');
  }

  return { module, student, playlistItem };
};

/**
 * Submit essay attempt. AI-grades questions with expectedAnswer; otherwise awaiting trainer review.
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId
 * @param {Object} body - { answers: [{ questionIndex, typedAnswer }], timeSpent }
 * @returns {Promise<Object>} results payload (same shape as GET results)
 */
const submitEssayAttempt = async (studentId, moduleId, playlistItemId, body) => {
  const { answers = [], timeSpent = 0 } = body;
  const { playlistItem } = await loadAssignedEssayItem(studentId, moduleId, playlistItemId);
  const questions = playlistItem.essay.questions;

  const unanswered = questions.some((q, i) => {
    if (q?.optional === true) return false;
    const ans = answers.find((a) => Number(a.questionIndex) === i);
    return !String(ans?.typedAnswer ?? '').trim();
  });
  if (unanswered) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Please answer all required questions before submitting the Q&A.'
    );
  }

  const answersByIndex = questions.map((q, i) => {
    const ans = answers.find((a) => Number(a.questionIndex) === i);
    return { questionIndex: i, typedAnswer: String(ans?.typedAnswer ?? '') };
  });

  let gradedResult = null;
  const hasExpectedAnswers = questions.some((q) => q.expectedAnswer?.trim());
  if (hasExpectedAnswers) {
    try {
      gradedResult = await gradeEssayAttempt(questions, answersByIndex);
    } catch (err) {
      logger.warn('[Essay submit] AI grading failed; keeping submission', { error: err?.message });
    }
  }

  const answersForCreate = gradedResult
    ? gradedResult.gradedAnswers.map((g) => ({
        questionIndex: g.questionIndex,
        typedAnswer: g.typedAnswer || '',
        score: g.score,
        feedback: g.feedback,
        rubric: g.rubric,
        suggestions: g.suggestions,
      }))
    : answersByIndex.map((a) => ({
        questionIndex: a.questionIndex,
        typedAnswer: a.typedAnswer || '',
      }));

  const fullyGraded = isEveryRequiredQuestionScored(questions, answersForCreate);
  const maxMarksTotal = totalMaxMarks(questions);
  const obtainedMarks = fullyGraded ? sumObtainedMarks(answersForCreate) : undefined;
  const percentage = fullyGraded ? percentageFromMarks(obtainedMarks ?? 0, maxMarksTotal) : undefined;

  const previousAttempts = await StudentEssayAttempt.find({
    student: studentId,
    module: moduleId,
    playlistItemId,
  }).sort({ attemptNumber: -1 });

  const attemptNumber = previousAttempts.length > 0 ? previousAttempts[0].attemptNumber + 1 : 1;

  const attempt = await StudentEssayAttempt.create({
    student: studentId,
    module: moduleId,
    playlistItemId,
    attemptNumber,
    answers: answersForCreate,
    score: percentage != null
      ? {
          totalQuestions: questions.length,
          correctAnswers: answersForCreate.filter((a) => typeof a.score === 'number').length,
          percentage,
          obtainedMarks,
          maxMarks: maxMarksTotal,
        }
      : undefined,
    timeSpent,
    submittedAt: new Date(),
    status: fullyGraded ? 'graded' : 'submitted',
  });

  await markItemComplete(studentId, moduleId, playlistItemId, 'essay');

  return buildEssayResultsResponse(playlistItem, playlistItemId, attempt);
};

/**
 * Build Q&A results payload. Hides expectedAnswer from employees until the attempt is graded.
 * @param {Object} playlistItem
 * @param {string} playlistItemId
 * @param {Object} latestAttempt
 * @param {{ includeExpectedAnswer?: boolean }} [opts]
 * @returns {Object}
 */
const buildEssayResultsResponse = (playlistItem, playlistItemId, latestAttempt, opts = {}) => {
  const questions = playlistItem.essay?.questions ?? [];
  const status = latestAttempt.status === 'reviewed' ? 'graded' : latestAttempt.status;
  const isGraded = status === 'graded';
  const showExpected = opts.includeExpectedAnswer === true || isGraded;

  const questionRows = questions.map((q, qIdx) => {
    const attemptAnswer = latestAttempt.answers.find(
      (a) => Number(a.questionIndex) === qIdx
    );
    return {
      questionText: q.questionText,
      expectedAnswer: showExpected && q.expectedAnswer?.trim() ? q.expectedAnswer : undefined,
      studentAnswer: attemptAnswer?.typedAnswer ?? '',
      score: attemptAnswer?.score,
      maxMarks: questionMaxMarks(q.maxMarks),
      optional: q.optional === true,
      feedback: attemptAnswer?.feedback,
      rubric: attemptAnswer?.rubric,
      suggestions: attemptAnswer?.suggestions,
    };
  });

  const maxMarks = totalMaxMarks(questions);
  const obtainedMarks = isGraded
    ? (latestAttempt.score?.obtainedMarks ?? sumObtainedMarks(latestAttempt.answers))
    : undefined;
  const percentage = isGraded
    ? (latestAttempt.score?.percentage ?? percentageFromMarks(obtainedMarks ?? 0, maxMarks))
    : undefined;
  const passPercentage = playlistItem.essay?.passPercentage;
  const passed = isGraded ? passedFromConfig(percentage ?? null, passPercentage) : null;

  return {
    essay: {
      playlistItemId,
      title: playlistItem.title,
      passPercentage: passPercentage ?? undefined,
      questions: questionRows,
    },
    attempt: {
      attemptId: latestAttempt._id ? String(latestAttempt._id) : undefined,
      attemptNumber: latestAttempt.attemptNumber,
      score: percentage != null
        ? {
            totalQuestions: questions.length,
            correctAnswers: latestAttempt.score?.correctAnswers,
            percentage,
            obtainedMarks,
            maxMarks,
          }
        : undefined,
      obtainedMarks,
      maxMarks,
      submittedAt: latestAttempt.submittedAt,
      timeSpent: latestAttempt.timeSpent,
      status,
      passed,
      passPercentage: passPercentage ?? undefined,
      feedback: latestAttempt.feedback || undefined,
    },
  };
};

/**
 * Get latest Q&A (essay) attempt with student responses for review.
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId
 * @returns {Promise<Object>}
 */
const getEssayResults = async (studentId, moduleId, playlistItemId) => {
  const { playlistItem } = await loadAssignedEssayItem(studentId, moduleId, playlistItemId);

  const latestAttempt = await StudentEssayAttempt.findOne({
    student: studentId,
    module: moduleId,
    playlistItemId,
  }).sort({ attemptNumber: -1 });

  if (!latestAttempt) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No Q&A attempt found');
  }

  return buildEssayResultsResponse(playlistItem, playlistItemId, latestAttempt);
};

export { submitEssayAttempt, getEssayResults, buildEssayResultsResponse, loadAssignedEssayItem };
