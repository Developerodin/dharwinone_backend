import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import Student from '../models/student.model.js';
import { getQuizResults } from './studentQuiz.service.js';

/**
 * List quiz attempts for a student on a course, grouped by playlist item (trainer view).
 * @param {string} studentId
 * @param {string} moduleId
 */
export async function listStudentQuizAttempts(studentId, moduleId) {
  const module = await TrainingModule.findById(moduleId).select('playlist students moduleName').lean();
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }

  const studentExists = await Student.exists({ _id: studentId });
  if (!studentExists) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }

  const quizItems = (module.playlist || [])
    .map((item, index) => ({ item, playlistItemId: String(index) }))
    .filter(({ item }) => item.contentType === 'quiz' && item.quiz?.questions?.length);

  const attempts = await StudentQuizAttempt.find({ student: studentId, module: moduleId, status: 'graded' })
    .sort({ playlistItemId: 1, attemptNumber: -1 })
    .lean();

  const byItem = new Map();
  for (const a of attempts) {
    const key = String(a.playlistItemId);
    if (!byItem.has(key)) byItem.set(key, []);
    byItem.get(key).push(a);
  }

  const items = quizItems.map(({ item, playlistItemId }) => {
    const itemAttempts = byItem.get(playlistItemId) || [];
    const latest = itemAttempts[0];
    return {
      playlistItemId,
      title: item.title,
      questionCount: item.quiz.questions.length,
      pending: latest ? !latest.feedback?.trim() : false,
      attempts: itemAttempts.map((attempt) => ({
        attemptId: String(attempt._id),
        quiz: {
          playlistItemId,
          title: item.title,
        },
        attempt: {
          attemptId: String(attempt._id),
          attemptNumber: attempt.attemptNumber,
          score: attempt.score,
          submittedAt: attempt.submittedAt,
          timeSpent: attempt.timeSpent,
          feedback: attempt.feedback || undefined,
        },
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
 * Trainer adds or edits overall feedback on a graded quiz attempt.
 * @param {string} attemptId
 * @param {string} reviewerUserId
 * @param {{ feedback?: string }} body
 */
export async function gradeQuizAttemptByTrainer(attemptId, reviewerUserId, body) {
  if (!mongoose.isValidObjectId(attemptId)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid attempt id');
  }

  const attempt = await StudentQuizAttempt.findById(attemptId);
  if (!attempt) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Quiz attempt not found');
  }
  if (attempt.status !== 'graded') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Only graded quiz attempts can receive feedback');
  }

  if (body.feedback != null) {
    attempt.feedback = String(body.feedback).slice(0, 2000);
  }
  attempt.reviewedBy = reviewerUserId;
  await attempt.save();

  const studentId = String(attempt.student);
  const moduleId = String(attempt.module);
  const playlistItemId = String(attempt.playlistItemId);
  const results = await getQuizResults(studentId, moduleId, playlistItemId);
  return {
    attemptId: String(attempt._id),
    ...results,
    attempt: {
      ...results.attempt,
      attemptId: String(attempt._id),
      feedback: attempt.feedback || undefined,
    },
  };
}
