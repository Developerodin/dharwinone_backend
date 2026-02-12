import { jest } from '@jest/globals';
import httpStatus from 'http-status';
import httpMocks from 'node-mocks-http';
import Joi from 'joi';
import validate from '../../../src/middlewares/validate.js';
import ApiError from '../../../src/utils/ApiError.js';

describe('Validate middleware', () => {
  const bodySchema = {
    body: Joi.object().keys({
      email: Joi.string().email().required(),
      password: Joi.string().min(8).required(),
    }),
  };

  test('should call next() when validation passes', () => {
    const validateMiddleware = validate(bodySchema);
    const req = httpMocks.createRequest({
      body: { email: 'test@example.com', password: 'password1' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    validateMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ email: 'test@example.com', password: 'password1' });
  });

  test('should call next() with ApiError when body is invalid', () => {
    const validateMiddleware = validate(bodySchema);
    const req = httpMocks.createRequest({
      body: { email: 'invalid-email', password: 'short' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    validateMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ApiError));
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({
        statusCode: httpStatus.BAD_REQUEST,
        message: expect.any(String),
      })
    );
  });

  test('should call next() with ApiError when required field is missing', () => {
    const validateMiddleware = validate(bodySchema);
    const req = httpMocks.createRequest({
      body: { email: 'test@example.com' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    validateMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ApiError));
    expect(next.mock.calls[0][0].statusCode).toBe(httpStatus.BAD_REQUEST);
  });

  test('should validate query params when query schema is provided', () => {
    const schema = {
      query: Joi.object().keys({
        page: Joi.number().integer().min(1),
      }),
    };
    const validateMiddleware = validate(schema);
    const req = httpMocks.createRequest({
      query: { page: '2' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    validateMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.query.page).toBe(2);
  });

  test('should validate params when params schema is provided', () => {
    const schema = {
      params: Joi.object().keys({
        userId: Joi.string().required(),
      }),
    };
    const validateMiddleware = validate(schema);
    const req = httpMocks.createRequest({
      params: { userId: '507f1f77bcf86cd799439011' },
    });
    const res = httpMocks.createResponse();
    const next = jest.fn();

    validateMiddleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
  });
});
