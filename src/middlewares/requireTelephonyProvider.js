import httpStatus from 'http-status';
import config from '../config/config.js';
import ApiError from '../utils/ApiError.js';

/**
 * Gate a route to the active TELEPHONY_PROVIDER (plivo | twilio).
 */
export default function requireTelephonyProvider(expectedProvider) {
  return (req, res, next) => {
    const active = config.telephony?.provider === 'twilio' ? 'twilio' : 'plivo';
    if (active !== expectedProvider) {
      return next(
        new ApiError(
          httpStatus.BAD_REQUEST,
          `This endpoint is only available when TELEPHONY_PROVIDER=${expectedProvider}.`
        )
      );
    }
    return next();
  };
}
