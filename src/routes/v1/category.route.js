import express from 'express';
import auth from '../../middlewares/auth.js';
import validate from '../../middlewares/validate.js';
import requirePermissions from '../../middlewares/requirePermissions.js';
import * as categoryValidation from '../../validations/category.validation.js';
import * as categoryController from '../../controllers/category.controller.js';

const router = express.Router();

router
  .route('/')
  .post(
    auth(),
    requirePermissions('categories.manage'),
    validate(categoryValidation.createCategory),
    categoryController.createCategory
  )
  .get(
    auth(),
    requirePermissions('categories.read'),
    validate(categoryValidation.getCategories),
    categoryController.getCategories
  );

router
  .route('/:categoryId')
  .get(
    auth(),
    requirePermissions('categories.read'),
    validate(categoryValidation.getCategory),
    categoryController.getCategory
  )
  .patch(
    auth(),
    requirePermissions('categories.manage'),
    validate(categoryValidation.updateCategory),
    categoryController.updateCategory
  )
  .delete(
    auth(),
    requirePermissions('categories.manage'),
    validate(categoryValidation.deleteCategory),
    categoryController.deleteCategory
  );

export default router;
