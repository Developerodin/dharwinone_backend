import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const studentEssayAttemptSchema = mongoose.Schema(
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
      type: String,
      required: true,
    },
    attemptNumber: {
      type: Number,
      default: 1,
    },
    answers: [
      {
        questionIndex: {
          type: Number,
          required: true,
        },
        typedAnswer: {
          type: String,
          default: '',
        },
        score: { type: Number },
        feedback: { type: String },
        rubric: {
          type: mongoose.Schema.Types.Mixed,
          description: 'Breakdown: accuracy, completeness, clarity, criticalThinking (0-25 each)',
        },
        suggestions: { type: String, description: 'AI improvement tips' },
      },
    ],
    score: {
      totalQuestions: { type: Number },
      correctAnswers: { type: Number },
      percentage: { type: Number, min: 0, max: 100 },
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    submittedAt: {
      type: Date,
    },
    timeSpent: {
      type: Number,
      default: 0,
    },
    status: {
      type: String,
      enum: ['in-progress', 'submitted', 'reviewed', 'graded'],
      default: 'in-progress',
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    feedback: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

studentEssayAttemptSchema.index({ student: 1, module: 1, playlistItemId: 1 });
studentEssayAttemptSchema.plugin(toJSON);
studentEssayAttemptSchema.plugin(paginate);

const originalToJSON = studentEssayAttemptSchema.options.toJSON?.transform;
studentEssayAttemptSchema.options.toJSON = studentEssayAttemptSchema.options.toJSON || {};
studentEssayAttemptSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

const StudentEssayAttempt = mongoose.model('StudentEssayAttempt', studentEssayAttemptSchema);
export default StudentEssayAttempt;
