import { randomUUID } from 'crypto';

const HEADER = 'x-request-id';

/**
 * Assign a stable request/correlation id for logging and error responses.
 * Reuses inbound X-Request-Id when present.
 */
const requestId = (req, res, next) => {
  const inbound = req.headers[HEADER] || req.headers['X-Request-Id'];
  const id = typeof inbound === 'string' && inbound.trim() ? inbound.trim() : randomUUID();
  req.id = id;
  res.setHeader(HEADER, id);
  next();
};

export default requestId;
