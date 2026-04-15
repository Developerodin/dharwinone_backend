import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const TEAM_GROUPS = ['team_ui', 'team_react', 'team_testing'];

const teamMemberSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true },
    memberSinceLabel: { type: String, trim: true }, // e.g. "16 Months"
    projectsCount: { type: Number, default: 0 },
    position: { type: String, trim: true }, // e.g. "Member", "Associate"
    coverImageUrl: { type: String, trim: true },
    avatarImageUrl: { type: String, trim: true },
    teamGroup: {
      type: String,
      enum: TEAM_GROUPS,
      default: 'team_ui',
      index: true,
    },
    teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'TeamGroup', index: true },
    onlineStatus: {
      type: String,
      enum: ['online', 'offline'],
      default: 'online',
    },
    lastSeenLabel: { type: String, trim: true }, // e.g. "8 min", "24 mins"
    isStarred: { type: Boolean, default: false },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
  },
  { timestamps: true }
);

teamMemberSchema.index({ name: 'text', email: 'text', position: 'text' });
teamMemberSchema.index({ createdAt: -1 });

teamMemberSchema.plugin(toJSON);

// toJSON plugin strips timestamps; roster UI uses createdAt when memberSinceLabel is empty.
const originalTeamMemberToJSON = teamMemberSchema.options.toJSON?.transform;
teamMemberSchema.options.toJSON = teamMemberSchema.options.toJSON || {};
teamMemberSchema.options.toJSON.transform = function teamMemberToJSONTransform(doc, ret, options) {
  if (originalTeamMemberToJSON) originalTeamMemberToJSON(doc, ret, options);
  if (doc.createdAt) ret.createdAt = doc.createdAt.toISOString();
  if (doc.updatedAt) ret.updatedAt = doc.updatedAt.toISOString();
  return ret;
};

const TeamMember = mongoose.model('TeamMember', teamMemberSchema);

export default TeamMember;
export { TEAM_GROUPS };

