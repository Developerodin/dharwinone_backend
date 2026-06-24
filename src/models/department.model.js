import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const departmentSchema = mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, unique: true },
    code: { type: String, trim: true, default: '' },
    // Org-chart node colour. Empty = chart auto-assigns a deterministic distinct colour.
    color: { type: String, trim: true, default: '' },
    isActive: { type: Boolean, default: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

departmentSchema.plugin(toJSON);
departmentSchema.plugin(paginate);

departmentSchema.statics.isNameTaken = async function (name, excludeId) {
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const doc = await this.findOne({ name: { $regex: new RegExp(`^${escaped}$`, 'i') }, _id: { $ne: excludeId } });
  return !!doc;
};

const Department = mongoose.model('Department', departmentSchema);
export default Department;
