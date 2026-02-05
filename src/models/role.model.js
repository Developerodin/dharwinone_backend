import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const roleSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
    permissions: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
  },
  {
    timestamps: true,
  }
);

roleSchema.plugin(toJSON);
roleSchema.plugin(paginate);

// Include createdAt (and updatedAt) in API response for roles
const originalToJSON = roleSchema.options.toJSON?.transform;
roleSchema.options.toJSON = roleSchema.options.toJSON || {};
roleSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * Check if name is taken
 * @param {string} name - The role's name
 * @param {ObjectId} [excludeRoleId] - The id of the role to be excluded
 * @returns {Promise<boolean>}
 */
roleSchema.statics.isNameTaken = async function (name, excludeRoleId) {
  const role = await this.findOne({ name, _id: { $ne: excludeRoleId } });
  return !!role;
};

/**
 * @typedef Role
 */
const Role = mongoose.model('Role', roleSchema);

export default Role;
