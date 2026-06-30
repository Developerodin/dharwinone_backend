import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

/**
 * Immutable history of an internal employee movement (transfer / promotion).
 * A current-state Employee record can't tell the story of a multi-year career
 * (SWE -> Sr SWE -> Team Lead -> EM -> Director); each move writes one row here.
 *
 * Created by the internal-transfer flow for self-applied EXISTING employees post-interview.
 * Never created for external hires (those go through Offer + Placement).
 */
const employeeTransferSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },

    oldDesignation: { type: String, trim: true, default: null },
    newDesignation: { type: String, trim: true, default: null },
    oldDepartmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    newDepartmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', default: null },
    // Denormalized name snapshots so history is readable even if a Department is renamed/deleted.
    oldDepartment: { type: String, trim: true, default: null },
    newDepartment: { type: String, trim: true, default: null },

    // Provenance — the internal job/application/interview that drove the move.
    sourceJobId: { type: mongoose.Schema.Types.ObjectId, ref: 'Job', default: null, index: true },
    sourceApplicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'JobApplication', default: null },
    sourceInterviewId: { type: mongoose.Schema.Types.ObjectId, ref: 'Meeting', default: null },

    // Enum seam: lateral / promotion / demotion etc. later. v1 only writes 'internal_transfer'.
    transferType: { type: String, enum: ['internal_transfer'], default: 'internal_transfer' },
    effectiveDate: { type: Date, default: Date.now },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    // Tenant boundary, denormalized from the employee/job at creation (mirrors JobApplication.tenantId).
    tenantId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
  },
  { timestamps: true }
);

employeeTransferSchema.index({ tenantId: 1, employee: 1, createdAt: -1 });

employeeTransferSchema.plugin(toJSON);
employeeTransferSchema.plugin(paginate);

const EmployeeTransfer = mongoose.model('EmployeeTransfer', employeeTransferSchema);

export default EmployeeTransfer;
