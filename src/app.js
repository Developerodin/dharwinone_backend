import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import xss from 'xss-clean';
import mongoSanitize from 'express-mongo-sanitize';
import compression from 'compression';
import cors from 'cors';
import passport from 'passport';
import httpStatus from 'http-status';
import config from './config/config.js';
import * as morgan from './config/morgan.js';
import { jwtStrategy } from './config/passport.js';
import routes from './routes/v1/index.js';
import { errorConverter, errorHandler } from './middlewares/error.js';
import { verifyBolnaWebhook } from './middlewares/verifyWebhook.js';
import ApiError from './utils/ApiError.js';
import * as bolnaController from './controllers/bolna.controller.js';

const app = express();

// Real client IP for req.ip (activity logs, rate limits) when behind nginx/ALB/Cloudflare.
// Prefer TRUST_PROXY_HOPS=n (exact hop count). Or TRUST_PROXY=true for app.set('trust proxy', true).
// 0 / unset: direct Node — req.ip is the TCP peer (often 127.0.0.1 via local reverse proxy).
if (config.trustProxyHops > 0) {
  app.set('trust proxy', config.trustProxyHops);
} else if (config.trustProxy) {
  app.set('trust proxy', true);
}

// Security headers first (before request logging / parsers)
app.use(helmet());

if (config.env !== 'test') {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// JSON body: tight default to reduce DoS surface; larger limit only for heavy PM assistant routes.
// Preserve raw bytes for webhook signature verification (LiveKit).
const jsonBodyVerify = (req, res, buf) => {
  req.rawBody = buf;
};
const defaultJsonLimit = process.env.JSON_BODY_LIMIT || '512kb';
const heavyJsonLimit = process.env.JSON_BODY_LIMIT_HEAVY || '2mb';
const heavyJsonPaths = /^\/v1\/pm-assistant(\/|$)/;
const jsonParserDefault = express.json({ limit: defaultJsonLimit, verify: jsonBodyVerify });
const jsonParserHeavy = express.json({ limit: heavyJsonLimit, verify: jsonBodyVerify });
app.use((req, res, next) => {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (heavyJsonPaths.test(path)) {
    return jsonParserHeavy(req, res, next);
  }
  return jsonParserDefault(req, res, next);
});

// parse cookies (needed for auth from cookie)
app.use(cookieParser());

// parse urlencoded request body
app.use(express.urlencoded({ extended: true }));

// sanitize request data (skip routes that carry intentional HTML — xss-clean entity-encodes < > and breaks Tiptap + providers)
const xssMiddleware = xss();
function shouldSkipGlobalXss(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  if (/^\/v1\/email\/(templates|signature|admin\/templates|admin\/signature)(\/|$)/.test(path)) return true;
  if (/^\/v1\/email\/messages\/send(\/|$)/.test(path)) return true;
  if (/^\/v1\/email\/messages\/[^/]+\/(reply|forward)(\/|$)/.test(path)) return true;
  if (/^\/v1\/outlook\/messages\/send(\/|$)/.test(path)) return true;
  if (/^\/v1\/outlook\/messages\/[^/]+\/reply(\/|$)/.test(path)) return true;
  /** Jobs + job templates: Tiptap HTML in `jobDescription` (otherwise xss encodes `<` and templates load as literal tags text). */
  if (/^\/v1\/jobs(\/|$)/.test(path)) return true;
  return false;
}
app.use((req, res, next) => {
  if (shouldSkipGlobalXss(req)) return next();
  return xssMiddleware(req, res, next);
});
app.use(mongoSanitize());

// gzip compression — skip for SSE streams so events flush immediately
app.use(compression({
  filter: (req, res) => {
    if (res.getHeader('Content-Type') === 'text/event-stream') return false;
    return compression.filter(req, res);
  },
}));

// enable cors
const corsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (config.corsOrigin === true) {
      // CORS_ORIGIN unset: allow any browser origin (typical local dev only; production must set CORS_ORIGIN).
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (Array.isArray(config.corsOrigin) && config.corsOrigin.includes(origin)) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Requested-With',
    'X-Activity-Client-Geo',
    'x-client-ip',
    'X-Client-Ip',
    /** PM assistant task apply + other idempotent writes from the browser */
    'Idempotency-Key',
    'idempotency-key',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// jwt authentication
app.use(passport.initialize());
passport.use('jwt', jwtStrategy);

// health / root (for Render health checks and visiting the URL)
app.post('/', verifyBolnaWebhook, bolnaController.receiveWebhook);
app.get('/', (req, res) => {
  const payload = { status: 'ok', message: 'UAT Dharwin Backend API', openapi: '/v1/openapi.json' };
  if (config.env === 'development') {
    payload.docs = '/v1/docs';
  }
  res.status(httpStatus.OK).json(payload);
});
app.get('/health', (req, res) => {
  res.status(httpStatus.OK).json({ status: 'ok' });
});

// v1 api routes
app.use('/v1', routes);

// send back a 404 error for any unknown api request
app.use((req, res, next) => {
  next(new ApiError(httpStatus.NOT_FOUND, 'Not found'));
});

// convert error to ApiError, if needed
app.use(errorConverter);

// handle error
app.use(errorHandler);

export default app;

