import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const recruiterNoteSchema = new mongoose.Schema(
  {
    recruiter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    note: {
      type: String,
      required: true,
      trim: true,
      maxlength: 5000,
    },
    visibility: {
      type: String,
      enum: ['public', 'private'],
      default: 'public',
      index: true,
    },
    postedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    postedByName: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

recruiterNoteSchema.index({ recruiter: 1, createdAt: -1 });
recruiterNoteSchema.index({ recruiter: 1, visibility: 1, createdAt: -1 });

recruiterNoteSchema.plugin(toJSON);
recruiterNoteSchema.plugin(paginate);

const RecruiterNote = mongoose.model('RecruiterNote', recruiterNoteSchema);

export default RecruiterNote;
