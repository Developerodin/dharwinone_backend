import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const inlineQuizSchema = new mongoose.Schema(
  {
    questions: [
      {
        questionText: {
          type: String,
          trim: true,
        },
        allowMultipleAnswers: {
          type: Boolean,
          default: false,
        },
        options: [
          {
            text: {
              type: String,
              trim: true,
            },
            isCorrect: {
              type: Boolean,
              default: false,
            },
          },
        ],
      },
    ],
  },
  { _id: false }
);

const trainingModuleSchema = mongoose.Schema(
  {
    // Course Info fields
    categories: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Category',
      },
    ],
    moduleName: {
      type: String,
      required: true,
      trim: true,
    },
    coverImage: {
      key: { type: String, trim: true },
      url: { type: String, trim: true },
      originalName: { type: String, trim: true },
      size: { type: Number },
      mimeType: { type: String, trim: true },
      uploadedAt: { type: Date },
    },
    shortDescription: {
      type: String,
      required: true,
      trim: true,
    },
    students: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Student',
      },
    ],
    mentorsAssigned: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Mentor',
      },
    ],
    // Playlist items
    playlist: [
      {
        contentType: {
          type: String,
          enum: ['upload-video', 'youtube-link', 'pdf-document', 'blog', 'quiz', 'essay'],
          required: true,
        },
        title: {
          type: String,
          required: true,
          trim: true,
        },
        duration: {
          type: Number, // Duration in minutes
          default: 0,
        },
        // Content-specific fields
        // For upload-video
        videoFile: {
          key: { type: String, trim: true },
          url: { type: String, trim: true },
          originalName: { type: String, trim: true },
          size: { type: Number },
          mimeType: { type: String, trim: true },
          uploadedAt: { type: Date },
        },
        // For youtube-link
        youtubeUrl: {
          type: String,
          trim: true,
        },
        // For pdf-document
        pdfDocument: {
          key: { type: String, trim: true },
          url: { type: String, trim: true },
          originalName: { type: String, trim: true },
          size: { type: Number },
          mimeType: { type: String, trim: true },
          uploadedAt: { type: Date },
        },
        // For blog
        blogContent: {
          type: String, // Rich text/HTML content
          trim: true,
        },
        // For quiz - stored inline in training module (single schema approach)
        quiz: {
          type: inlineQuizSchema,
          default: undefined,
        },
        // For test
        testLinkOrReference: {
          type: String,
          trim: true,
        },
        // For essay
        essay: {
          questions: [
            {
              questionText: {
                type: String,
                trim: true,
              },
              expectedAnswer: {
                type: String,
                trim: true,
              },
            },
          ],
        },
        // Order/position in playlist
        order: {
          type: Number,
          default: 0,
        },
        // Nested module/section (from document with multiple modules)
        sectionTitle: { type: String, trim: true },
        sectionIndex: { type: Number },
        difficulty: {
          type: String,
          enum: ['easy', 'medium', 'hard'],
          default: 'medium',
        },
      },
    ],
    // Status
    status: {
      type: String,
      enum: ['draft', 'published', 'archived'],
      default: 'draft',
    },
    estimatedDuration: {
      type: Number,
      default: 0,
    },
  },
  {
    timestamps: true,
  }
);

trainingModuleSchema.plugin(toJSON);
trainingModuleSchema.plugin(paginate);

// Include createdAt and updatedAt in API response
const originalToJSON = trainingModuleSchema.options.toJSON?.transform;
trainingModuleSchema.options.toJSON = trainingModuleSchema.options.toJSON || {};
trainingModuleSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * @typedef TrainingModule
 */
const TrainingModule = mongoose.model('TrainingModule', trainingModuleSchema);

export default TrainingModule;
