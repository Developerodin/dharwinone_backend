import mongoose from 'mongoose';
import toJSON from './plugins/toJSON.plugin.js';
import paginate from './plugins/paginate.plugin.js';

const categorySchema = mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
  },
  {
    timestamps: true,
  }
);

categorySchema.plugin(toJSON);
categorySchema.plugin(paginate);

// Include createdAt (and updatedAt) in API response
const originalToJSON = categorySchema.options.toJSON?.transform;
categorySchema.options.toJSON = categorySchema.options.toJSON || {};
categorySchema.options.toJSON.transform = function (doc, ret, options) {
  if (originalToJSON) originalToJSON(doc, ret, options);
  ret.createdAt = doc.createdAt;
  ret.updatedAt = doc.updatedAt;
  return ret;
};

/**
 * Check if name is taken
 * @param {string} name - The category name
 * @param {ObjectId} [excludeCategoryId] - The id of the category to be excluded
 * @returns {Promise<boolean>}
 */
categorySchema.statics.isNameTaken = async function (name, excludeCategoryId) {
  const escaped = String(name)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const category = await this.findOne({
    name: { $regex: new RegExp(`^${escaped}$`, 'i') },
    _id: { $ne: excludeCategoryId },
  });
  return !!category;
};

/**
 * @typedef Category
 */
const Category = mongoose.model('Category', categorySchema);

export default Category;
