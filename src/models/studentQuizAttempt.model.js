import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const studentQuizAttemptSchema = mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
      required: true,
      index: true,
    },
    module: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'TrainingModule',
      required: true,
      index: true,
    },
    playlistItemId: {
      type: String, // Reference to the quiz item in module.playlist (by order/index)
      required: true,
    },
    // Quiz attempt details
    attemptNumber: {
      type: Number,
      default: 1, // 1st attempt, 2nd attempt, etc.
    },
    answers: [
      {
        questionIndex: {
          type: Number, // Index of question in quiz.questions array
          required: true,
        },
        selectedOptions: [
          {
            type: Number, // Indices of selected options
          },
        ],
        isCorrect: {
          type: Boolean,
        },
        pointsEarned: {
          type: Number,
          default: 0,
        },
      },
    ],
    // Scoring
    score: {
      totalQuestions: {
        type: Number,
        required: true,
      },
      correctAnswers: {
        type: Number,
        default: 0,
      },
      percentage: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      totalPoints: {
        type: Number,
        default: 0,
      },
      maxPoints: {
        type: Number,
        required: true,
      },
    },
    // Timing
    startedAt: {
      type: Date,
      default: Date.now,
    },
    submittedAt: {
      type: Date,
    },
    timeSpent: {
      type: Number, // in seconds
      default: 0,
    },
    // Status
    status: {
      type: String,
      enum: ['in-progress', 'submitted', 'graded'],
      default: 'in-progress',
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for quick lookups
studentQuizAttemptSchema.index({ student: 1, module: 1, playlistItemId: 1 });
studentQuizAttemptSchema.index({ student: 1, module: 1 });

studentQuizAttemptSchema.plugin(toJSON);
studentQuizAttemptSchema.plugin(paginate);

// Include createdAt and updatedAt in API response
const originalToJSON = studentQuizAttemptSchema.options.toJSON?.transform;
studentQuizAttemptSchema.options.toJSON = studentQuizAttemptSchema.options.toJSON || {};
studentQuizAttemptSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * @typedef StudentQuizAttempt
 */
const StudentQuizAttempt = mongoose.model('StudentQuizAttempt', studentQuizAttemptSchema);

export default StudentQuizAttempt;
