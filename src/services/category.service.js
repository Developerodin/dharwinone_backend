import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Category from '../models/category.model.js';
import TrainingModule from '../models/trainingModule.model.js';

/**
 * Create a category
 * @param {Object} categoryBody
 * @returns {Promise<Category>}
 */
const createCategory = async (categoryBody) => {
  if (await Category.isNameTaken(categoryBody.name)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Category name already taken');
  }
  return Category.create(categoryBody);
};

/**
 * Query for categories (with module count per category)
 * @param {Object} filter - Mongo filter (name, search)
 * @param {Object} options - Query options
 * @param {string} [options.sortBy] - Sort option in the format: sortField:(desc|asc)
 * @param {number} [options.limit] - Maximum number of results per page (default = 10)
 * @param {number} [options.page] - Current page (default = 1)
 * @returns {Promise<QueryResult>}
 */
const queryCategories = async (filter, options) => {
  const { search, ...restFilter } = filter;
  const mongoFilter = { ...restFilter };
  if (search && search.trim()) {
    const trimmed = search.trim();
    const searchRegex = new RegExp(trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    mongoFilter.$or = [
      { name: { $regex: searchRegex } },
    ];
  }
  const categories = await Category.paginate(mongoFilter, options);
  if (!categories.results || categories.results.length === 0) {
    return categories;
  }
  try {
    const categoryIds = categories.results.map((c) => c._id ?? c.id).filter(Boolean);
    if (categoryIds.length === 0) return categories;
    const counts = await TrainingModule.aggregate([
      { $match: { categories: { $in: categoryIds } } },
      { $unwind: '$categories' },
      { $match: { categories: { $in: categoryIds } } },
      { $group: { _id: '$categories', count: { $sum: 1 } } },
    ]);
    const countByCategoryId = new Map(counts.map((r) => [String(r._id), r.count]));
    categories.results = categories.results.map((cat) => {
      const id = cat._id ?? cat.id;
      const moduleCount = id ? (countByCategoryId.get(String(id)) ?? 0) : 0;
      const plain = typeof cat.toJSON === 'function' ? cat.toJSON() : { id: cat.id ?? cat._id, name: cat.name, createdAt: cat.createdAt, updatedAt: cat.updatedAt };
      return { ...plain, moduleCount };
    });
  } catch (_err) {
    // If module count fails, return plain category objects without moduleCount (frontend shows 0)
    categories.results = categories.results.map((cat) => {
      const plain = typeof cat.toJSON === 'function' ? cat.toJSON() : { id: cat.id ?? cat._id, name: cat.name, createdAt: cat.createdAt, updatedAt: cat.updatedAt };
      return { ...plain, moduleCount: 0 };
    });
  }
  return categories;
};

/**
 * Get category by id
 * @param {ObjectId} id
 * @returns {Promise<Category>}
 */
const getCategoryById = async (id) => {
  return Category.findById(id);
};

/**
 * Update category by id
 * @param {ObjectId} categoryId
 * @param {Object} updateBody
 * @returns {Promise<Category>}
 */
const updateCategoryById = async (categoryId, updateBody) => {
  const category = await getCategoryById(categoryId);
  if (!category) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Category not found');
  }
  if (updateBody.name && (await Category.isNameTaken(updateBody.name, categoryId))) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Category name already taken');
  }
  Object.assign(category, updateBody);
  await category.save();
  return category;
};

/**
 * Delete category by id
 * @param {ObjectId} categoryId
 * @returns {Promise<Category>}
 */
const deleteCategoryById = async (categoryId) => {
  const category = await getCategoryById(categoryId);
  if (!category) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Category not found');
  }
  await category.deleteOne();
  return category;
};

export {
  createCategory,
  queryCategories,
  getCategoryById,
  updateCategoryById,
  deleteCategoryById,
};
