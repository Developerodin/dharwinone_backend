import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const studentNoteSchema = new mongoose.Schema(
  {
    student: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Student',
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

studentNoteSchema.index({ student: 1, createdAt: -1 });
studentNoteSchema.index({ student: 1, visibility: 1, createdAt: -1 });

studentNoteSchema.plugin(toJSON);
studentNoteSchema.plugin(paginate);

const StudentNote = mongoose.model('StudentNote', studentNoteSchema);

export default StudentNote;
