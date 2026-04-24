import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const candidateGroupSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, index: true },
    description: { type: String, trim: true },
    candidates: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Employee' }],
      default: [],
      index: true,
    },
    holidays: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Holiday' }],
      default: [],
      index: true,
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { timestamps: true }
);

candidateGroupSchema.index({ name: 1, isActive: 1 });
candidateGroupSchema.index({ createdBy: 1, isActive: 1 });
candidateGroupSchema.plugin(toJSON);
candidateGroupSchema.plugin(paginate);

const CandidateGroup = mongoose.model('CandidateGroup', candidateGroupSchema);
export default CandidateGroup;
