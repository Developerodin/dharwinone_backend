import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const ORG_UNIT_TYPES = ['ceo', 'manager', 'supervisor', 'department'];

const orgUnitSchema = mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    type: { type: String, required: true, enum: ORG_UNIT_TYPES },
    parentId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgUnit', default: null, index: true },
    headEmployeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    directToCeo: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

orgUnitSchema.plugin(toJSON);
orgUnitSchema.plugin(paginate);

const OrgUnit = mongoose.model('OrgUnit', orgUnitSchema);
export { ORG_UNIT_TYPES };
export default OrgUnit;
