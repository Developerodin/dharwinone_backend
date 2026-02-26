import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import StudentQuizAttempt from '../models/studentQuizAttempt.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import StudentCourseProgress from '../models/studentCourseProgress.model.js';
import Student from '../models/student.model.js';
import { autoGenerateCertificateIfEligible } from './certificate.service.js';
import { explainQuizCorrectAnswer } from './essayGrade.service.js';

/**
 * Deduplicate question options by text (keep first occurrence; if any duplicate is correct, mark kept as correct).
 * @param {Array<{ text: string, isCorrect?: boolean }>} options
 * @returns {Array<{ text: string, isCorrect: boolean }>}
 */
const deduplicateQuestionOptions = (options) => {
  const result = [];
  for (const opt of options || []) {
    const existing = result.find((o) => o.text === (opt.text || '').trim());
    if (existing) {
      if (opt.isCorrect) existing.isCorrect = true;
    } else {
      result.push({ text: (opt.text || '').trim(), isCorrect: Boolean(opt.isCorrect) });
    }
  }
  return result;
};

/**
 * Get quiz for student (sanitized - no correct answers shown)
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId - Index of quiz item in playlist
 * @returns {Promise<Object>}
 */
const getQuiz = async (studentId, moduleId, playlistItemId) => {
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  
  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  
  // Verify student is assigned
  const isAssigned = module.students.some(
    (id) => id.toString() === studentId.toString()
  );
  if (!isAssigned) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Student is not assigned to this module');
  }
  
  // Find quiz item in playlist
  const itemIndex = parseInt(playlistItemId, 10);
  if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= module.playlist.length) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Quiz item not found in playlist');
  }
  
  const playlistItem = module.playlist[itemIndex];
  if (playlistItem.contentType !== 'quiz') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Playlist item is not a quiz');
  }
  
  if (!playlistItem.quiz || !playlistItem.quiz.questions) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Quiz has no questions');
  }
  
  // Sanitize quiz: remove correct answer indicators and deduplicate options by text
  const sanitizedQuiz = {
    playlistItemId: playlistItemId,
    title: playlistItem.title,
    duration: playlistItem.duration,
    questions: playlistItem.quiz.questions.map((q) => {
      const deduped = deduplicateQuestionOptions(q.options);
      return {
        questionText: q.questionText,
        allowMultipleAnswers: q.allowMultipleAnswers,
        options: deduped.map((opt) => ({ text: opt.text })),
      };
    }),
  };

  return sanitizedQuiz;
};

/**
 * Calculate quiz score
 * @param {Array} questions - Quiz questions with correct answers
 * @param {Array} studentAnswers - Student's answers
 * @returns {Object} Score object
 */
const calculateScore = (questions, studentAnswers) => {
  let totalPoints = 0;
  const maxPoints = questions.length;

  const gradedAnswers = studentAnswers.map((answer) => {
    const question = questions[answer.questionIndex];
    if (!question) {
      return {
        questionIndex: answer.questionIndex,
        selectedOptions: answer.selectedOptions,
        isCorrect: false,
        pointsEarned: 0,
      };
    }

    // Get correct option indices (ensure numbers for comparison)
    const correctOptions = question.options
      .map((opt, idx) => (opt.isCorrect ? idx : null))
      .filter((idx) => idx !== null)
      .map((idx) => Number(idx))
      .sort((a, b) => a - b);

    // Sort student's selected options for comparison (coerce to numbers - can come as strings from JSON)
    const selectedSorted = [...(answer.selectedOptions || [])]
      .map((o) => Number(o))
      .filter((n) => !Number.isNaN(n))
      .sort((a, b) => a - b);
    const correctSet = new Set(correctOptions);

    let isCorrect = false;
    let pointsEarned = 0;

    if (question.allowMultipleAnswers) {
      // Multiple choice: partial credit – reward correct selections, penalize wrong ones
      const correctlySelected = selectedSorted.filter((idx) => correctSet.has(idx)).length;
      const wrongSelected = selectedSorted.filter((idx) => !correctSet.has(idx)).length;
      const totalCorrect = correctOptions.length;
      if (totalCorrect > 0) {
        pointsEarned = correctlySelected / totalCorrect - wrongSelected * 0.25;
        pointsEarned = Math.min(1, Math.max(0, Math.round(pointsEarned * 100) / 100));
      }
      isCorrect = pointsEarned >= 1;
    } else {
      // Single choice: exact match only
      isCorrect =
        selectedSorted.length === 1 &&
        correctOptions.length === 1 &&
        selectedSorted[0] === correctOptions[0];
      pointsEarned = isCorrect ? 1 : 0;
    }

    totalPoints += pointsEarned;

    return {
      questionIndex: answer.questionIndex,
      selectedOptions: selectedSorted,
      isCorrect,
      pointsEarned,
    };
  });

  const percentage = maxPoints > 0 ? Math.round((totalPoints / maxPoints) * 100) : 0;
  const correctCount = gradedAnswers.filter((a) => a.isCorrect).length;

  return {
    totalQuestions: maxPoints,
    correctAnswers: correctCount,
    percentage,
    totalPoints: Math.round(totalPoints * 100) / 100,
    maxPoints,
    gradedAnswers,
  };
};

/**
 * Submit quiz attempt
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId
 * @param {Object} attemptData - { answers: [...], timeSpent: number }
 * @returns {Promise<StudentQuizAttempt>}
 */
const submitQuizAttempt = async (studentId, moduleId, playlistItemId, attemptData) => {
  const { answers, timeSpent = 0 } = attemptData;
  
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  
  const student = await Student.findById(studentId);
  if (!student) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Student not found');
  }
  
  // Verify student is assigned
  const isAssigned = module.students.some(
    (id) => id.toString() === studentId.toString()
  );
  if (!isAssigned) {
    throw new ApiError(httpStatus.FORBIDDEN, 'Student is not assigned to this module');
  }
  
  // Find quiz item
  const itemIndex = parseInt(playlistItemId, 10);
  if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= module.playlist.length) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Quiz item not found');
  }
  
  const playlistItem = module.playlist[itemIndex];
  if (playlistItem.contentType !== 'quiz') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Playlist item is not a quiz');
  }
  
  if (!playlistItem.quiz || !playlistItem.quiz.questions) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Quiz has no questions');
  }

  const questionsDeduped = playlistItem.quiz.questions.map((q) => ({
    questionText: q.questionText,
    allowMultipleAnswers: q.allowMultipleAnswers,
    options: deduplicateQuestionOptions(q.options),
  }));

  // Get previous attempts to determine attempt number
  const previousAttempts = await StudentQuizAttempt.find({
    student: studentId,
    module: moduleId,
    playlistItemId,
  }).sort({ attemptNumber: -1 });

  const attemptNumber = previousAttempts.length > 0
    ? previousAttempts[0].attemptNumber + 1
    : 1;

  // Calculate score using deduplicated questions (same structure as getQuiz)
  const scoreResult = calculateScore(questionsDeduped, answers);
  const questions = questionsDeduped;

  // Add AI explanations for wrong answers
  const gradedWithExplanations = await Promise.all(
    scoreResult.gradedAnswers.map(async (graded) => {
      if (graded.isCorrect) return { ...graded, explanation: undefined };
      const question = questions[graded.questionIndex];
      if (!question?.options?.length) return { ...graded, explanation: undefined };
      const explanation = await explainQuizCorrectAnswer(
        question.questionText,
        question.options.map((o) => ({ text: o.text, isCorrect: !!o.isCorrect })),
        graded.selectedOptions
      );
      return { ...graded, explanation: explanation || undefined };
    })
  );

  // Create quiz attempt
  const quizAttempt = await StudentQuizAttempt.create({
    student: studentId,
    module: moduleId,
    playlistItemId,
    attemptNumber,
    answers: gradedWithExplanations,
    score: {
      totalQuestions: scoreResult.totalQuestions,
      correctAnswers: scoreResult.correctAnswers,
      percentage: scoreResult.percentage,
      totalPoints: scoreResult.totalPoints,
      maxPoints: scoreResult.maxPoints,
    },
    timeSpent,
    submittedAt: new Date(),
    status: 'graded',
  });
  
  // Update student course progress – mark quiz item complete only when score >= 90%
  const progress = await StudentCourseProgress.findOne({ student: studentId, module: moduleId });
  if (progress) {
    const isQuizCompleted = progress.progress.completedItems.some(
      (item) => item.playlistItemId === playlistItemId
    );
    const passed = scoreResult.percentage >= 90;

    if (!isQuizCompleted && passed) {
      progress.progress.completedItems.push({
        playlistItemId,
        completedAt: new Date(),
        contentType: 'quiz',
      });
    }
    
    // Update quiz scores
    const allQuizAttempts = await StudentQuizAttempt.find({
      student: studentId,
      module: moduleId,
      status: 'graded',
    });
    
    // Count unique quiz items attempted
    const uniqueQuizItems = new Set(
      allQuizAttempts.map((a) => a.playlistItemId)
    );
    
    // Calculate average score from all attempts
    const totalScore = allQuizAttempts.reduce((sum, a) => sum + a.score.percentage, 0);
    const avgScore = allQuizAttempts.length > 0 
      ? Math.round(totalScore / allQuizAttempts.length)
      : 0;
    
    // Count total quizzes in module
    const totalQuizzesInModule = module.playlist.filter(
      (item) => item.contentType === 'quiz'
    ).length;
    
    progress.quizScores = {
      totalQuizzes: totalQuizzesInModule,
      completedQuizzes: uniqueQuizItems.size,
      averageScore: avgScore,
      totalScore: allQuizAttempts.reduce((sum, a) => sum + a.score.totalPoints, 0),
    };
    
    // Recalculate overall progress
    const totalItems = module.playlist.length;
    const completedCount = progress.progress.completedItems.length;
    progress.progress.percentage = Math.round((completedCount / totalItems) * 100);
    
    // Update status
    if (progress.progress.percentage === 100 && !progress.completedAt) {
      progress.status = 'completed';
      progress.completedAt = new Date();
    } else if (progress.progress.percentage > 0 && progress.status === 'enrolled') {
      progress.status = 'in-progress';
    }
    
    await progress.save();
    
    // Auto-generate certificate if course is 100% complete
    await autoGenerateCertificateIfEligible(studentId, moduleId);
  }
  
  return quizAttempt;
};

/**
 * Get quiz attempt history
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId
 * @returns {Promise<Array>}
 */
const getQuizAttemptHistory = async (studentId, moduleId, playlistItemId) => {
  const attempts = await StudentQuizAttempt.find({
    student: studentId,
    module: moduleId,
    playlistItemId,
  })
    .sort({ attemptNumber: -1 })
    .populate('student', 'user')
    .populate('module', 'moduleName');
  
  return attempts;
};

/**
 * Get quiz results (with correct answers shown)
 * @param {ObjectId} studentId
 * @param {ObjectId} moduleId
 * @param {string} playlistItemId
 * @returns {Promise<Object>}
 */
const getQuizResults = async (studentId, moduleId, playlistItemId) => {
  const module = await TrainingModule.findById(moduleId);
  if (!module) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Training module not found');
  }
  
  const itemIndex = parseInt(playlistItemId, 10);
  if (isNaN(itemIndex) || itemIndex < 0 || itemIndex >= module.playlist.length) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Quiz item not found');
  }
  
  const playlistItem = module.playlist[itemIndex];
  if (playlistItem.contentType !== 'quiz') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Playlist item is not a quiz');
  }
  
  // Get latest attempt
  const latestAttempt = await StudentQuizAttempt.findOne({
    student: studentId,
    module: moduleId,
    playlistItemId,
  })
    .sort({ attemptNumber: -1 });
  
  if (!latestAttempt) {
    throw new ApiError(httpStatus.NOT_FOUND, 'No quiz attempt found');
  }
  
  // Return quiz with correct answers and student's attempt (same deduplication as getQuiz)
  return {
    quiz: {
      playlistItemId,
      title: playlistItem.title,
      questions: playlistItem.quiz.questions.map((q, qIdx) => {
        const attemptAnswer = latestAttempt.answers.find(
          (a) => Number(a.questionIndex) === qIdx
        );
        const selectedOpts = (attemptAnswer?.selectedOptions || []).map((o) => Number(o));
        const deduped = deduplicateQuestionOptions(q.options);
        const options = deduped.map((opt, optIdx) => ({
          text: opt.text,
          isCorrect: opt.isCorrect,
          isSelected: selectedOpts.includes(optIdx),
        }));
        return {
          questionText: q.questionText,
          allowMultipleAnswers: q.allowMultipleAnswers,
          options,
          studentAnswer: selectedOpts,
          isCorrect: Boolean(attemptAnswer?.isCorrect),
          explanation: attemptAnswer?.explanation || undefined,
        };
      }),
    },
    attempt: {
      attemptNumber: latestAttempt.attemptNumber,
      score: latestAttempt.score,
      submittedAt: latestAttempt.submittedAt,
      timeSpent: latestAttempt.timeSpent,
    },
  };
};

export {
  getQuiz,
  submitQuizAttempt,
  getQuizAttemptHistory,
  getQuizResults,
  calculateScore,
};
