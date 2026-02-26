import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import StudentEssayAttempt from '../models/studentEssayAttempt.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import { markItemComplete } from './studentCourse.service.js';
import { gradeEssayAttempt } from './essayGrade.service.js';

/**
 * Submit essay attempt. If questions have expectedAnswer, AI grades and returns score (like quiz).
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId - Index or ID of essay item in playlist
 * @param {Object} body - { answers: [{ questionIndex, typedAnswer }], timeSpent }
 * @returns {Promise<StudentEssayAttempt>}
 */
const submitEssayAttempt = async (studentId, moduleId, playlistItemId, body) => {
  const { answers = [], timeSpent = 0 } = body;

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

  const questions = playlistItem.essay.questions;
  const hasExpectedAnswers = questions.some((q) => q.expectedAnswer?.trim());

  let gradedResult = null;
  if (hasExpectedAnswers) {
    gradedResult = await gradeEssayAttempt(questions, answers);
  }

  const previousAttempts = await StudentEssayAttempt.find({
    student: studentId,
    module: moduleId,
    playlistItemId,
  }).sort({ attemptNumber: -1 });

  const attemptNumber = previousAttempts.length > 0 ? previousAttempts[0].attemptNumber + 1 : 1;

  const answersForCreate = gradedResult
    ? gradedResult.gradedAnswers.map((g) => ({
        questionIndex: g.questionIndex,
        typedAnswer: g.typedAnswer || '',
        score: g.score,
        feedback: g.feedback,
        rubric: g.rubric,
        suggestions: g.suggestions,
      }))
    : answers.map((a) => ({
        questionIndex: a.questionIndex,
        typedAnswer: a.typedAnswer || '',
      }));

  const attempt = await StudentEssayAttempt.create({
    student: studentId,
    module: moduleId,
    playlistItemId,
    attemptNumber,
    answers: answersForCreate,
    score: gradedResult?.percentage != null
      ? {
          totalQuestions: gradedResult.totalQuestions,
          correctAnswers: gradedResult.correctAnswers,
          percentage: gradedResult.percentage,
        }
      : undefined,
    timeSpent,
    submittedAt: new Date(),
    status: gradedResult ? 'graded' : 'submitted',
  });

  await markItemComplete(studentId, moduleId, playlistItemId, 'essay');

  return attempt;
};

export { submitEssayAttempt };
