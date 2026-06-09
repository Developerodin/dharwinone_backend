import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const SCENARIO_STATUSES = ['draft', 'approved', 'applied', 'archived'];

const orgScenarioSchema = mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    status: { type: String, enum: SCENARIO_STATUSES, default: 'draft', index: true },
    clonedAt: { type: Date, default: null },
    liveVersionAtClone: { type: Date, default: null },
    appliedAt: { type: Date, default: null },
    scenarioApplyId: { type: String, default: null, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

orgScenarioSchema.plugin(toJSON);
orgScenarioSchema.plugin(paginate);

const OrgScenario = mongoose.model('OrgScenario', orgScenarioSchema);
export { SCENARIO_STATUSES };
export default OrgScenario;
