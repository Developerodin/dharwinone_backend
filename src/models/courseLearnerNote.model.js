import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const courseLearnerNoteSchema = new mongoose.Schema(
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
      trim: true,
    },
    body: {
      type: String,
      default: '',
      maxlength: 20000,
    },
  },
  { timestamps: true }
);

courseLearnerNoteSchema.index({ student: 1, module: 1, playlistItemId: 1 }, { unique: true });
courseLearnerNoteSchema.plugin(toJSON);

const CourseLearnerNote = mongoose.model('CourseLearnerNote', courseLearnerNoteSchema);

export default CourseLearnerNote;
