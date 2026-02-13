import Joi from 'joi';
import { objectId } from './custom.validation.js';

const generateCertificate = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
};

const getCertificate = {
  params: Joi.object().keys({
    studentId: Joi.string().required().custom(objectId),
    moduleId: Joi.string().required().custom(objectId),
  }),
};

const verifyCertificate = {
  params: Joi.object().keys({
    verificationCode: Joi.string().required(),
  }),
};

export { generateCertificate, getCertificate, verifyCertificate };
