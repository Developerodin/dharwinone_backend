import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const studentCourseProgressSchema = mongoose.Schema(
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
    // Enrollment
    enrolledAt: {
      type: Date,
      default: Date.now,
    },
    startedAt: {
      type: Date, // When student first accessed the course
    },
    completedAt: {
      type: Date, // When student reached 100%
    },
    // Progress tracking
    progress: {
      percentage: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      completedItems: [
        {
          playlistItemId: {
            type: String, // Reference to playlist item (by order/index or unique ID)
            required: true,
          },
          completedAt: {
            type: Date,
            default: Date.now,
          },
          contentType: {
            type: String,
            enum: ['upload-video', 'youtube-link', 'pdf-document', 'blog', 'quiz', 'test'],
          },
        },
      ],
      lastAccessedAt: {
        type: Date,
        default: Date.now,
      },
      lastAccessedItem: {
        playlistItemId: String, // Last playlist item student viewed
      },
    },
    // Quiz scores (aggregated from StudentQuizAttempt)
    quizScores: {
      totalQuizzes: {
        type: Number,
        default: 0,
      },
      completedQuizzes: {
        type: Number,
        default: 0,
      },
      averageScore: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      totalScore: {
        type: Number,
        default: 0,
      },
    },
    // Certificate
    certificate: {
      issued: {
        type: Boolean,
        default: false,
      },
      issuedAt: {
        type: Date,
      },
      certificateId: {
        type: String, // Unique certificate ID/URL
        trim: true,
      },
      certificateUrl: {
        type: String, // URL to download/view certificate
        trim: true,
      },
    },
    // Status
    status: {
      type: String,
      enum: ['enrolled', 'in-progress', 'completed', 'dropped'],
      default: 'enrolled',
    },
  },
  {
    timestamps: true,
  }
);

// Compound unique index: one progress record per student per module
studentCourseProgressSchema.index({ student: 1, module: 1 }, { unique: true });

studentCourseProgressSchema.plugin(toJSON);
studentCourseProgressSchema.plugin(paginate);

// Include createdAt and updatedAt in API response
const originalToJSON = studentCourseProgressSchema.options.toJSON?.transform;
studentCourseProgressSchema.options.toJSON = studentCourseProgressSchema.options.toJSON || {};
studentCourseProgressSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * @typedef StudentCourseProgress
 */
const StudentCourseProgress = mongoose.model('StudentCourseProgress', studentCourseProgressSchema);

export default StudentCourseProgress;
