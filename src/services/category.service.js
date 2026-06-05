import httpStatus from 'http-status';
import mongoose from 'mongoose';
import ApiError from '../utils/ApiError.js';
import Category from '../models/category.model.js';
import Position from '../models/position.model.js';
import TrainingModule from '../models/trainingModule.model.js';
import * as studentService from './student.service.js';

const normalizePositionIds = (positions) => {
  if (!positions) return undefined;
  if (!Array.isArray(positions)) return [];
  return positions
    .map((id) => String(id).trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
};

const assertPositionsExist = async (positionIds) => {
  if (!positionIds?.length) return;
  const found = await Position.countDocuments({ _id: { $in: positionIds } });
  if (found !== positionIds.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'One or more positions are invalid');
  }
};

const categoryPopulate = [{ path: 'positions', select: 'name department' }];

/**
 * Create a category
 * @param {Object} categoryBody
 * @returns {Promise<Category>}
 */
const createCategory = async (categoryBody) => {
  if (await Category.isNameTaken(categoryBody.name)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Category name already taken');
  }
  const positionIds = normalizePositionIds(categoryBody.positions);
  if (positionIds !== undefined) {
    await assertPositionsExist(positionIds);
    categoryBody.positions = positionIds;
  }
  const category = await Category.create(categoryBody);
  return Category.findById(category.id).populate(categoryPopulate);
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
  const categories = await Category.paginate(mongoFilter, { ...options, populate: categoryPopulate });
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
      const plain = typeof cat.toJSON === 'function' ? cat.toJSON() : { id: cat.id ?? cat._id, name: cat.name, positions: cat.positions, createdAt: cat.createdAt, updatedAt: cat.updatedAt };
      return { ...plain, moduleCount };
    });
  } catch (_err) {
    // If module count fails, return plain category objects without moduleCount (frontend shows 0)
    categories.results = categories.results.map((cat) => {
      const plain = typeof cat.toJSON === 'function' ? cat.toJSON() : { id: cat.id ?? cat._id, name: cat.name, positions: cat.positions, createdAt: cat.createdAt, updatedAt: cat.updatedAt };
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
  return Category.findById(id).populate(categoryPopulate);
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
  if (Object.prototype.hasOwnProperty.call(updateBody, 'positions')) {
    const positionIds = normalizePositionIds(updateBody.positions) ?? [];
    await assertPositionsExist(positionIds);
    updateBody.positions = positionIds;
  }
  Object.assign(category, updateBody);
  await category.save();
  return Category.findById(category.id).populate(categoryPopulate);
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
  const linkedModules = await TrainingModule.countDocuments({ categories: categoryId });
  if (linkedModules > 0) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      `Cannot delete category: ${linkedModules} training module(s) still use it`
    );
  }
  await category.deleteOne();
  return category;
};

/**
 * Active students whose position is mapped to this category.
 * @param {ObjectId} categoryId
 * @param {Object} filter
 * @param {Object} options
 */
const queryEmployeesForCategory = async (categoryId, filter, options) => {
  const category = await Category.findById(categoryId).select('positions name');
  if (!category) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Category not found');
  }
  const positionIds = (category.positions ?? []).map((p) => String(p._id ?? p)).filter(Boolean);
  if (!positionIds.length) {
    return {
      results: [],
      page: options.page ?? 1,
      limit: options.limit ?? 10,
      totalPages: 0,
      totalResults: 0,
    };
  }
  return studentService.queryStudents(
    { ...filter, position: { $in: positionIds }, status: 'active' },
    options
  );
};

export {
  createCategory,
  queryCategories,
  getCategoryById,
  updateCategoryById,
  deleteCategoryById,
  queryEmployeesForCategory,
};
