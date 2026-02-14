import express from 'express';
import validate from '../../middlewares/validate.js';
import blogValidation from '../../validations/blog.validation.js';
import * as blogController from '../../controllers/blog.controller.js';
import auth from '../../middlewares/auth.js';

const router = express.Router();

router.use(auth());

router.post('/generate', validate(blogValidation.generate), blogController.generate);
router.post('/generate-stream', validate(blogValidation.generate), blogController.generateStream);
router.post('/generate-from-theme', validate(blogValidation.generateFromTheme), blogController.generateFromTheme);
router.post('/suggestions', validate(blogValidation.suggestions), blogController.getSuggestions);

export default router;
