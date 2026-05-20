import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const teamSchema = new mongoose.Schema(
  {
    name:        { type: String, required: true, trim: true, unique: true },
    teamLead:    { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', index: true },
    department:  { type: String, trim: true, index: true },
    description: { type: String, trim: true },
    relatedPositions: [
      { type: mongoose.Schema.Types.ObjectId, ref: 'Position' },
    ],
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
teamSchema.index({ relatedPositions: 1 }); // multikey — reverse lookup Team-by-Position
teamSchema.plugin(toJSON);

// Mongoose model name stays 'TeamGroup' so existing `ref: 'TeamGroup'` populate
// calls in project.model.js and team.model.js (TeamMember.teamId) keep working.
// Only the exported variable is renamed to 'Team' to match the spec's vocabulary.
// Physical collection 'teamgroups' is mongoose's default pluralization of 'TeamGroup'.
const Team = mongoose.model('TeamGroup', teamSchema);
export default Team;
