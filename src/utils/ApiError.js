class ApiError extends Error {
  constructor(statusCode, message, isOperational = true, stack = '', extras = {}) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.stack = stack || Error.captureStackTrace(this, this.constructor);
    /** Client hint e.g. outlook_reauth_required */
    if (extras && extras.subCode) this.subCode = extras.subCode;
    if (extras && extras.details) this.details = extras.details;
  }
}

export default ApiError;
