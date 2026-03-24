import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';

const bolnaCandidateAgentSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'default', unique: true, immutable: true },
    extraSystemInstructions: { type: String, default: '', maxlength: 8000 },
    greetingOverride: { type: String, default: '', maxlength: 500 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

bolnaCandidateAgentSettingsSchema.plugin(toJSON);

const BolnaCandidateAgentSettings = mongoose.model(
  'BolnaCandidateAgentSettings',
  bolnaCandidateAgentSettingsSchema
);

export default BolnaCandidateAgentSettings;
