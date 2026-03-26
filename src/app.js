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
import { authLimiter } from './middlewares/rateLimiter.js';
import routes from './routes/v1/index.js';
import { errorConverter, errorHandler } from './middlewares/error.js';
import ApiError from './utils/ApiError.js';
import * as bolnaController from './controllers/bolna.controller.js';

const app = express();

// Real client IP for req.ip (and activity logs, rate limits) when behind nginx/ALB/Cloudflare.
// Set TRUST_PROXY_HOPS=1 for a single trusted hop; 0 in local dev when hitting Node directly.
if (config.trustProxyHops > 0) {
  app.set('trust proxy', config.trustProxyHops);
}

if (config.env !== 'test') {
  app.use(morgan.successHandler);
  app.use(morgan.errorHandler);
}

// set security HTTP headers
app.use(helmet());

// parse json request body
app.use(express.json());

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
      // Allow all origins in development
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (Array.isArray(config.corsOrigin) && config.corsOrigin.includes(origin)) {
      return callback(null, true);
    }
    
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  exposedHeaders: ['Authorization'],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// jwt authentication
app.use(passport.initialize());
passport.use('jwt', jwtStrategy);

// limit repeated failed requests to auth endpoints
if (config.env === 'production') {
  app.use('/v1/auth', authLimiter);
}

// health / root (for Render health checks and visiting the URL)
app.post('/', bolnaController.receiveWebhook);
app.get('/', (req, res) => {
  res.status(httpStatus.OK).json({ status: 'ok', message: 'UAT Dharwin Backend API', docs: '/v1/docs' });
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

