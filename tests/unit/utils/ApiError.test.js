import httpStatus from 'http-status';
import ApiError from '../../../src/utils/ApiError.js';

describe('ApiError', () => {
  test('should create an ApiError with statusCode and message', () => {
    const message = 'Test error';
    const statusCode = httpStatus.BAD_REQUEST;
    const error = new ApiError(statusCode, message);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(statusCode);
    expect(error.message).toBe(message);
    expect(error.isOperational).toBe(true);
    expect(error.stack === undefined || typeof error.stack === 'string').toBe(true);
  });

  test('should set isOperational to false when passed', () => {
    const error = new ApiError(httpStatus.INTERNAL_SERVER_ERROR, 'Server error', false);
    expect(error.isOperational).toBe(false);
  });

  test('should default isOperational to true', () => {
    const error = new ApiError(httpStatus.NOT_FOUND, 'Not found');
    expect(error.isOperational).toBe(true);
  });

  test('should preserve message for different status codes', () => {
    const message = 'Unauthorized access';
    const error = new ApiError(httpStatus.UNAUTHORIZED, message);
    expect(error.message).toBe(message);
    expect(error.statusCode).toBe(401);
  });
});
