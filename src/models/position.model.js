import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const positionSchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      unique: true,
    },
  },
  {
    timestamps: true,
  }
);

positionSchema.plugin(toJSON);
positionSchema.plugin(paginate);

// Include createdAt (and updatedAt) in API response
const originalToJSON = positionSchema.options.toJSON?.transform;
positionSchema.options.toJSON = positionSchema.options.toJSON || {};
positionSchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

positionSchema.statics.isNameTaken = async function (name, excludePositionId) {
  const escaped = String(name).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const position = await this.findOne({ name: { $regex: new RegExp(`^${escaped}$`, 'i') }, _id: { $ne: excludePositionId } });
  return !!position;
};

/**
 * @typedef Position
 */
const Position = mongoose.model('Position', positionSchema);

export default Position;
