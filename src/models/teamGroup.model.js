import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const teamSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true, unique: true },
    teamLead:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', index: true },
    department:  { type: String, trim: true, index: true },
    description: { type: String, trim: true },
    source: {
      type: String,
      enum: ['manual', 'excel-import', 'ai-generated'],
      default: 'manual',
      index: true,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true, collation: { locale: 'en', strength: 2 } }
);

teamSchema.index({ name: 'text' });
teamSchema.plugin(toJSON);

// Model renamed to 'Team' but physical collection stays 'teamgroups' — avoids prod rename.
const Team = mongoose.model('Team', teamSchema, 'teamgroups');
export default Team;
