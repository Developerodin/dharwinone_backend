import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import { ORG_UNIT_TYPES } from './orgUnit.model.js';

const orgScenarioUnitSchema = mongoose.Schema(
  {
    scenarioId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgScenario', required: true, index: true },
    liveOrgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgUnit', default: null, index: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, enum: ORG_UNIT_TYPES },
    parentScenarioUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgScenarioUnit', default: null, index: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    headEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    directToCeo: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

orgScenarioUnitSchema.plugin(toJSON);

const OrgScenarioUnit = mongoose.model('OrgScenarioUnit', orgScenarioUnitSchema);
export default OrgScenarioUnit;
