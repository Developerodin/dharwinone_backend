import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const teamGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

teamGroupSchema.index({ name: 'text' });
teamGroupSchema.plugin(toJSON);

const TeamGroup = mongoose.model('TeamGroup', teamGroupSchema);
export default TeamGroup;
