import mongoose from 'mongoose';
import httpStatus from 'http-status';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import { describeNetworkError } from '../utils/describeNetworkError.js';


const errorConverter = (err, req, res, next) => {
  let error = err;
  if (!(error instanceof ApiError)) {
    const statusCode =
      error.statusCode ??
      (error instanceof mongoose.Error ? httpStatus.BAD_REQUEST : httpStatus.INTERNAL_SERVER_ERROR);
    const message = error.message || httpStatus[statusCode];
    error = new ApiError(statusCode, message, false, err.stack);
  }
  next(error);
};

// eslint-disable-next-line no-unused-vars
const errorHandler = (err, req, res, next) => {
  let { statusCode, message } = err;
  if (config.env === 'production' && !err.isOperational) {
    statusCode = httpStatus.INTERNAL_SERVER_ERROR;
    message = httpStatus[httpStatus.INTERNAL_SERVER_ERROR];
  }

  // Morgan logs :message from res.locals — avoid leaking raw internal errors in production access logs.
  res.locals.errorMessage =
    config.env === 'production' && !err.isOperational ? `HTTP ${statusCode}` : err.message;

  const correlationId = req.id || req.headers?.['x-request-id'];
  const response = {
    code: statusCode,
    message,
    ...(correlationId && { correlationId }),
    ...(err.subCode && { error: err.subCode }),
    ...(err.errorCode && { errorCode: err.errorCode }),
    ...(Array.isArray(err.errors) && err.errors.length > 0 && { errors: err.errors }),
    ...((config.env === 'development' || err.isOperational) && err.details && { details: err.details }),
    ...(config.env === 'development' && { stack: err.stack }),
  };

  if (config.env === 'development') {
    const rich = describeNetworkError(err);
    logger.error(rich || err?.message || String(err));
    if (err?.stack) logger.error(err.stack);
    const agg = err?.errors;
    if (Array.isArray(agg)) {
      agg.forEach((sub, i) => {
        const line = describeNetworkError(sub);
        if (line) logger.error(`AggregateError.cause[${i}] ${line}`);
        if (sub?.stack) logger.error(sub.stack);
      });
    }
  }

  res.status(statusCode).send(response);
};

export {
  errorConverter,
  errorHandler,
};

