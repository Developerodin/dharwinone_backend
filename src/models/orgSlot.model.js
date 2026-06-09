import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const ORG_SLOT_STATUSES = ['vacant', 'filled', 'frozen'];

const orgSlotSchema = mongoose.Schema(
  {
    orgUnitId: { type: mongoose.Schema.Types.ObjectId, ref: 'OrgUnit', required: true, index: true },
    positionTitleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Position', default: null },
    titleLabel: { type: String, trim: true, default: '' },
    status: { type: String, enum: ORG_SLOT_STATUSES, default: 'vacant', index: true },
    employeeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

orgSlotSchema.plugin(toJSON);
orgSlotSchema.plugin(paginate);

const OrgSlot = mongoose.model('OrgSlot', orgSlotSchema);
export { ORG_SLOT_STATUSES };
export default OrgSlot;
