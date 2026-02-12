import httpStatus from 'http-status';
import pick from '../utils/pick.js';
import ApiError from '../utils/ApiError.js';
import catchAsync from '../utils/catchAsync.js';
import * as categoryService from '../services/category.service.js';
import * as activityLogService from '../services/activityLog.service.js';
import { ActivityActions, EntityTypes } from '../config/activityLog.js';

const createCategory = catchAsync(async (req, res) => {
  const category = await categoryService.createCategory(req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.CATEGORY_CREATE,
    EntityTypes.CATEGORY,
    category.id,
    { name: category.name },
    req
  );
  res.status(httpStatus.CREATED).send(category);
});

const getCategories = catchAsync(async (req, res) => {
  const filter = pick(req.query, ['name', 'search']);
  const options = pick(req.query, ['sortBy', 'limit', 'page']);
  const result = await categoryService.queryCategories(filter, options);
  res.send(result);
});

const getCategory = catchAsync(async (req, res) => {
  const category = await categoryService.getCategoryById(req.params.categoryId);
  if (!category) {
    throw new ApiError(httpStatus.NOT_FOUND, 'Category not found');
  }
  res.send(category);
});

const updateCategory = catchAsync(async (req, res) => {
  const category = await categoryService.updateCategoryById(req.params.categoryId, req.body);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.CATEGORY_UPDATE,
    EntityTypes.CATEGORY,
    category.id,
    { name: category.name },
    req
  );
  res.send(category);
});

const deleteCategory = catchAsync(async (req, res) => {
  await categoryService.deleteCategoryById(req.params.categoryId);
  await activityLogService.createActivityLog(
    req.user.id,
    ActivityActions.CATEGORY_DELETE,
    EntityTypes.CATEGORY,
    req.params.categoryId,
    {},
    req
  );
  res.status(httpStatus.NO_CONTENT).send();
});

export { createCategory, getCategories, getCategory, updateCategory, deleteCategory };
