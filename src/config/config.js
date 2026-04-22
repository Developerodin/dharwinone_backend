import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Joi from 'joi';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Load backend root .env (always relative to this file, not process.cwd())
const envPath = path.resolve(__dirname, '../../.env');
dotenv.config({ path: envPath, override: true });
// If LiveKit keys still missing, merge cwd .env without overriding (avoids parent-folder .env wiping GCP_* etc.)
if (!process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) {
  dotenv.config({ path: path.resolve(process.cwd(), '.env'), override: false });
}

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().default(3000),
    MONGODB_URL: Joi.string().required().description('MongoDB URL'),
    JWT_SECRET: Joi.string().min(32).required().description('JWT secret key (min 32 characters)'),
    JWT_ACCESS_EXPIRATION_MINUTES: Joi.number().default(30).description('minutes after which access tokens expire'),
    JWT_REFRESH_EXPIRATION_DAYS: Joi.number().default(30).description('days after which refresh tokens expire'),
    JWT_RESET_PASSWORD_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which reset password token expires'),
    JWT_VERIFY_EMAIL_EXPIRATION_MINUTES: Joi.number()
      .default(10)
      .description('minutes after which verify email token expires'),
    SMTP_HOST: Joi.string().description('server that will send the emails'),
    SMTP_PORT: Joi.number().description('port to connect to the email server'),
    SMTP_USERNAME: Joi.string().description('username for email server'),
    SMTP_PASSWORD: Joi.string().description('password for email server'),
    EMAIL_FROM: Joi.string().description('the from field in the emails sent by the app'),
    EMAIL_REPLY_TO: Joi.string().optional().description('the reply-to field in the emails sent by the app'),

    // AWS / S3 (mirrors candidate backend)
    AWS_ACCESS_KEY_ID: Joi.string().description('AWS access key ID'),
    AWS_SECRET_ACCESS_KEY: Joi.string().description('AWS secret access key'),
    AWS_REGION: Joi.string().default('us-east-1').description('AWS region'),
    AWS_S3_BUCKET_NAME: Joi.string().description('AWS S3 bucket name'),

    // CORS / Frontend — required in production (comma-separated origins)
    CORS_ORIGIN: Joi.when('NODE_ENV', {
      is: 'production',
      then: Joi.string().trim().min(5).required().description('Allowed CORS origins (comma-separated); required in production'),
      otherwise: Joi.string().allow('').optional().description('Allowed CORS origin (comma-separated for multiple origins)'),
    }),
    /** When set, Bolna webhooks must send matching `X-Bolna-Webhook-Secret`. Required behavior in production (see verifyWebhook middleware). */
    BOLNA_WEBHOOK_SECRET: Joi.string().optional().allow('').description('Shared secret for Bolna webhook requests'),
    /** Default true; set to false only for dev SMTP with self-signed certs */
    SMTP_TLS_REJECT_UNAUTHORIZED: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),
    FRONTEND_BASE_URL: Joi.string().optional().description('Frontend base URL for email links'),
    BACKEND_PUBLIC_URL: Joi.string().optional().description('Backend public URL for share links (e.g. https://api.example.com)'),

    // OpenAI (blog AI, Create Module with AI, cover image generation)
    OPENAI_API_KEY: Joi.string().optional().description('OpenAI API key for blog, module AI, and DALL-E cover images'),

    // GCP (YouTube + Gmail OAuth)
    GCP_YOUTUBE_API_KEY: Joi.string().optional().description('YouTube Data API v3 key'),
    GCP_GOOGLE_CLIENT_ID: Joi.string().optional().description('Google OAuth client ID (for Gmail)'),
    GCP_GOOGLE_CLIENT_SECRET: Joi.string().optional().description('Google OAuth client secret (for Gmail)'),
    GCP_GOOGLE_REDIRECT_URI: Joi.string().optional().description('Google OAuth redirect URI'),

    // LiveKit
    LIVEKIT_URL: Joi.string().optional().default('ws://localhost:7880').description('LiveKit server URL'),
    LIVEKIT_API_KEY: Joi.string().optional().description('LiveKit API key'),
    LIVEKIT_API_SECRET: Joi.string().optional().description('LiveKit API secret'),
    MINIO_ENDPOINT: Joi.string().optional().default('http://minio:9000').description('MinIO endpoint for local recordings (server-side)'),
    MINIO_PUBLIC_ENDPOINT: Joi.string().optional().default('http://localhost:9000').description('MinIO endpoint for presigned URLs (browser must reach this, e.g. localhost:9000)'),
    MINIO_ACCESS_KEY: Joi.string().optional().default('minioadmin').description('MinIO access key'),
    MINIO_SECRET_KEY: Joi.string().optional().default('minioadmin123').description('MinIO secret key'),
    MINIO_BUCKET: Joi.string().optional().default('recordings').description('MinIO bucket for recordings'),
    LIVEKIT_S3_BUCKET: Joi.string().optional().description('S3 bucket for recordings (production); must match where Egress uploads'),

    // Bolna Calling
    BOLNA_API_KEY: Joi.string().optional().description('Bolna API key'),
    BOLNA_AGENT_ID: Joi.string().optional().description('Bolna agent ID'),
    BOLNA_CANDIDATE_AGENT_ID: Joi.string().optional().description('Bolna agent ID for candidate verification calls'),
    BOLNA_FROM_PHONE_NUMBER: Joi.string().optional().description('Bolna caller ID in E.164 format'),
    CALLER_ID: Joi.string().optional().description('Fallback caller ID for AddOn compatibility'),
    BOLNA_API_BASE: Joi.string().optional().default('https://api.bolna.ai').description('Bolna API base URL'),
    BOLNA_MAX_CALL_DURATION_SECONDS: Joi.number()
      .integer()
      .min(0)
      .max(7200)
      .optional()
      .default(900)
      .description(
        'Max voice call length in seconds (sent as max_call_duration_seconds on POST /call when > 0). Set 0 to omit. Also set the same limit in Bolna Call tab for job + candidate agents.'
      ),

    // Microsoft / Outlook OAuth
    MICROSOFT_CLIENT_ID: Joi.string().optional().description('Microsoft OAuth client ID (for Outlook)'),
    MICROSOFT_CLIENT_SECRET: Joi.string().optional().description('Microsoft OAuth client secret'),
    MICROSOFT_REDIRECT_URI: Joi.string().optional().description('Microsoft OAuth redirect URI'),
    MICROSOFT_TENANT_ID: Joi.string().optional().default('common').description('Microsoft tenant ID (common for multi-tenant)'),

    // Auth rate limit (deployed apps often share IPs; increase to avoid 429 on sign-in)
    RATE_LIMIT_AUTH_WINDOW_MINUTES: Joi.number().optional().default(15).description('Auth rate limit window in minutes'),
    RATE_LIMIT_AUTH_MAX: Joi.number().optional().default(80).description('Max failed auth requests per window per IP'),
    RATE_LIMIT_JOBS_BROWSE_PER_MINUTE: Joi.number()
      .optional()
      .default(120)
      .description('Max GET /jobs/browse (and detail) requests per IP per minute'),

    /** Max requests per IP per window for auth routes that must count every call (forgot-password, verify-email, reset-password, self-registration). */
    RATE_LIMIT_AUTH_STRICT_MAX: Joi.number().integer().min(5).optional().default(30),
    RATE_LIMIT_AUTH_STRICT_WINDOW_MINUTES: Joi.number().integer().min(1).optional().default(15),
    /** Shared bucket for POST /public/register, /register-candidate, /jobs/:id/apply (per IP). */
    RATE_LIMIT_PUBLIC_REGISTRATION_MAX: Joi.number().integer().min(5).optional().default(45),
    RATE_LIMIT_PUBLIC_REGISTRATION_WINDOW_MINUTES: Joi.number().integer().min(5).optional().default(60),
    /** Other unauthenticated POSTs under /v1/public (LiveKit, recording, meetings). */
    RATE_LIMIT_PUBLIC_WRITE_MAX: Joi.number().integer().min(10).optional().default(120),
    RATE_LIMIT_PUBLIC_WRITE_WINDOW_MINUTES: Joi.number().integer().min(1).optional().default(15),

    // Reverse proxy: Express req.ip / X-Forwarded-For (activity logs geo, rate limits, secure cookies)
    TRUST_PROXY_HOPS: Joi.number()
      .integer()
      .min(0)
      .max(32)
      .optional()
      .default(0)
      .description(
        'Number of trusted reverse-proxy hops (0=off). Use 1 behind a single nginx/ALB/Cloudflare in front of Node. See Express "behind proxies" guide.'
      ),

    /** If "true" or "1", Express trust proxy is enabled as boolean (all hops). Prefer TRUST_PROXY_HOPS for a fixed count. */
    TRUST_PROXY: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),

    /** When > 0, MongoDB TTL index deletes ActivityLog documents `expireAfterSeconds` after createdAt (monitor runs ~60s). 0 = disabled. */
    ACTIVITY_LOG_TTL_SECONDS: Joi.number().integer().min(0).optional().default(0),

    /**
     * Comma-separated emails: sole accounts for Activity Logs API/UI and support camera invites.
     * When unset or empty, defaults to harvinder@superadmin.in for backward-compatible single-tenant setups.
     */
    DESIGNATED_SUPERADMIN_EMAILS: Joi.string()
      .optional()
      .allow('')
      .description('Comma-separated operator emails for activity logs + support camera'),

    // Voice agent knowledge base (RAG)
    KB_EMBEDDING_MODEL: Joi.string().optional().default('text-embedding-3-small'),
    KB_EMBEDDING_DIMENSIONS: Joi.number().integer().min(256).max(3072).optional().allow(null, ''),
    KB_CHUNK_TARGET_TOKENS: Joi.number().integer().min(128).max(8192).optional().default(768),
    KB_CHUNK_OVERLAP_TOKENS: Joi.number().integer().min(0).max(2048).optional().default(128),
    KB_TOP_K: Joi.number().integer().min(1).max(50).optional().default(8),
    KB_MIN_SIMILARITY: Joi.number().min(0).max(1).optional().default(0.28),
    KB_MAX_PDF_MB: Joi.number().integer().min(1).max(100).optional().default(25),
    KB_MAX_URL_BYTES: Joi.number().integer().min(1024).max(52428800).optional().default(2097152),
    KB_MAX_DOCS_PER_AGENT: Joi.number().integer().min(1).max(500).optional().default(50),
    KB_QUERY_CACHE_TTL_SECONDS: Joi.number().integer().min(0).max(86400).optional().default(3600),
    KB_QUERY_CACHE_MISS_TTL_SECONDS: Joi.number().integer().min(0).max(600).optional().default(120),
    MONGODB_VECTOR_SEARCH_ENABLED: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),

    /** Mirror PDF/URL ingests to Bolna hosted Knowledge Base (POST /knowledgebase). Requires BOLNA_API_KEY. */
    KB_BOLNA_SYNC_ENABLED: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),
    KB_BOLNA_KB_MULTILINGUAL: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),
    KB_BOLNA_KB_CHUNK_SIZE: Joi.number().integer().min(64).max(4096).optional(),
    KB_BOLNA_KB_OVERLAPPING: Joi.number().integer().min(0).max(2048).optional(),
    KB_BOLNA_KB_SIMILARITY_TOP_K: Joi.number().integer().min(1).max(50).optional(),

    /** HRM WebRTC (SignalR) — JWT must match hrm-webrtc/backend Jwt:Key, Issuer, Audience; role claim admin. */
    HRM_WEBRTC_JWT_SECRET: Joi.string().optional().allow('').description('Same value as HRM backend Jwt:Key'),
    HRM_WEBRTC_JWT_ISSUER: Joi.string().optional().allow('').description('Same as HRM Jwt:Issuer'),
    HRM_WEBRTC_JWT_AUDIENCE: Joi.string().optional().allow('').description('Same as HRM Jwt:Audience'),
    HRM_WEBRTC_SIGNALING_BASE_URL: Joi.string()
      .optional()
      .allow('')
      .description('HRM backend base URL (no trailing slash), e.g. https://hrm-api.example.com'),
    HRM_WEBRTC_TOKEN_EXPIRATION_MINUTES: Joi.number().integer().min(1).max(120).optional().default(15),

    /** When true, login/refresh/impersonation responses include JWT strings in JSON (cookies always set). Default: on in non-production, off in production unless set true. */
    AUTH_RETURN_TOKENS_IN_JSON: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),
    /** When true, GET /v1/openapi.json is served in production (default false there). Always served in dev/test. */
    EXPOSE_OPENAPI: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),
    /** bcrypt salt rounds for password hashing (default 12). */
    BCRYPT_SALT_ROUNDS: Joi.number().integer().min(8).max(20).optional().default(12),

    /** HMAC secret for referral link tokens; defaults to JWT_SECRET at runtime if unset. */
    REFERRAL_LINK_SECRET: Joi.string().min(16).optional().allow('').description('Referral ref= token signing'),
    /** Canonical org key embedded in referral payload (single-tenant default). */
    REFERRAL_DEFAULT_ORG_ID: Joi.string().trim().optional().default('default'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const designatedSuperadminRaw = (envVars.DESIGNATED_SUPERADMIN_EMAILS ?? '').trim();
const designatedSuperadminEmails = (designatedSuperadminRaw || 'harvinder@superadmin.in')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const isDesignatedSuperadminEmail = (email) => {
  if (!email || typeof email !== 'string') return false;
  return designatedSuperadminEmails.includes(email.trim().toLowerCase());
};

const trustProxyFlagRaw = String(envVars.TRUST_PROXY ?? '')
  .trim()
  .toLowerCase();
const trustProxy = trustProxyFlagRaw === 'true' || trustProxyFlagRaw === '1';

const resolvedBackendPublicUrl = (
  envVars.BACKEND_PUBLIC_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null) ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : null) ||
  `http://localhost:${envVars.PORT}`
).replace(/\/$/, '');

const config = {
  env: envVars.NODE_ENV,
  port: envVars.PORT,
  mongoose: {
    url: envVars.MONGODB_URL + (envVars.NODE_ENV === 'test' ? '-test' : ''),
    options: {},
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },
  email: {
    smtp: {
      host: envVars.SMTP_HOST,
      port: envVars.SMTP_PORT,
      secure: envVars.SMTP_PORT === 465,
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD,
      },
      tls: {
        rejectUnauthorized: !['false', '0'].includes(
          String(envVars.SMTP_TLS_REJECT_UNAUTHORIZED ?? 'true')
            .trim()
            .toLowerCase()
        ),
      },
    },
    from: envVars.EMAIL_FROM,
    replyTo: envVars.EMAIL_REPLY_TO,
  },
  corsOrigin: envVars.CORS_ORIGIN?.trim()
    ? envVars.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : true,
  // Email/share links: use public URLs. In production set FRONTEND_BASE_URL and BACKEND_PUBLIC_URL.
  // Fallbacks: SITE_URL/APP_URL for frontend; RENDER_EXTERNAL_URL, VERCEL_URL, RAILWAY_PUBLIC_DOMAIN for backend.
  frontendBaseUrl: (
    envVars.FRONTEND_BASE_URL ||
    envVars.SITE_URL ||
    envVars.APP_URL ||
    'http://localhost:3001'
  ).replace(/\/$/, ''),
  backendPublicUrl: resolvedBackendPublicUrl,
  openai: {
    apiKey: envVars.OPENAI_API_KEY || '',
  },
  youtube: {
    apiKey: envVars.GCP_YOUTUBE_API_KEY || envVars.YOUTUBE_API_KEY || '',
  },
  google: {
    clientId: envVars.GCP_GOOGLE_CLIENT_ID || '',
    clientSecret: envVars.GCP_GOOGLE_CLIENT_SECRET || '',
    redirectUri: (() => {
      const fromEnv = (envVars.GCP_GOOGLE_REDIRECT_URI || '').trim();
      const fallback = `http://localhost:${envVars.PORT}/v1/email/auth/google/callback`;
      if (!fromEnv && (envVars.GCP_GOOGLE_CLIENT_ID || '').trim()) {
        // eslint-disable-next-line no-console -- startup OAuth redirect hint
        console.warn(
          `[config] GCP_GOOGLE_REDIRECT_URI is missing or empty — Gmail OAuth will use ${fallback}. ` +
            `Set GCP_GOOGLE_REDIRECT_URI in ${envPath}`
        );
      }
      return fromEnv || fallback;
    })(),
  },
  microsoft: {
    clientId: envVars.MICROSOFT_CLIENT_ID || '',
    clientSecret: envVars.MICROSOFT_CLIENT_SECRET || '',
    redirectUri: (() => {
      const fromEnv = (envVars.MICROSOFT_REDIRECT_URI || '').trim();
      const fallback = `${resolvedBackendPublicUrl}/v1/outlook/auth/microsoft/callback`;
      if (!fromEnv && (envVars.MICROSOFT_CLIENT_ID || '').trim()) {
        // eslint-disable-next-line no-console -- startup OAuth redirect hint
        console.warn(
          `[config] MICROSOFT_REDIRECT_URI is missing or empty — Outlook OAuth will use ${fallback} (Outlook API). ` +
            `Set MICROSOFT_REDIRECT_URI in ${envPath} or BACKEND_PUBLIC_URL.`
        );
      }
      return fromEnv || fallback;
    })(),
    tenantId: (() => {
      const t = (envVars.MICROSOFT_TENANT_ID || 'common').trim();
      return t || 'common';
    })(),
  },
  aws: {
    accessKeyId: envVars.AWS_ACCESS_KEY_ID,
    secretAccessKey: envVars.AWS_SECRET_ACCESS_KEY,
    region: envVars.AWS_REGION,
    bucketName: envVars.AWS_S3_BUCKET_NAME,
  },
  livekit: {
    url: (envVars.LIVEKIT_URL || 'ws://localhost:7880').trim(),
    apiKey: envVars.LIVEKIT_API_KEY ? String(envVars.LIVEKIT_API_KEY).trim() : undefined,
    apiSecret: envVars.LIVEKIT_API_SECRET ? String(envVars.LIVEKIT_API_SECRET).trim() : undefined,
    minio: {
      endpoint: envVars.MINIO_ENDPOINT || 'http://minio:9000',
      publicEndpoint: envVars.MINIO_PUBLIC_ENDPOINT || 'http://localhost:9000',
      accessKey: envVars.MINIO_ACCESS_KEY || 'minioadmin',
      secretKey: envVars.MINIO_SECRET_KEY || 'minioadmin123',
      bucket: envVars.MINIO_BUCKET || 'recordings',
    },
    s3Bucket: envVars.LIVEKIT_S3_BUCKET,
  },
  bolna: {
    apiKey: envVars.BOLNA_API_KEY || '',
    /** Job posting / recruiter verification calls (no prompt PATCH in app). */
    agentId: envVars.BOLNA_AGENT_ID || '6afbccea-0495-4892-937c-6a5c9af12440',
    /**
     * Applicant verification only — receives PATCH system prompt before each call.
     * Must differ from agentId or flows overwrite each other’s behavior.
     */
    candidateAgentId: envVars.BOLNA_CANDIDATE_AGENT_ID || envVars.BOLNA_AGENT_ID || '6afbccea-0495-4892-937c-6a5c9af12440',
    fromPhoneNumber: envVars.BOLNA_FROM_PHONE_NUMBER || envVars.CALLER_ID || '',
    apiBase: envVars.BOLNA_API_BASE || 'https://api.bolna.ai',
    /** Applied to every outbound call; mirror in Bolna dashboard Call tab for each agent. */
    maxCallDurationSeconds: envVars.BOLNA_MAX_CALL_DURATION_SECONDS,
  },
  rateLimit: {
    authWindowMinutes: envVars.RATE_LIMIT_AUTH_WINDOW_MINUTES ?? 15,
    authMax: envVars.RATE_LIMIT_AUTH_MAX ?? 80,
    jobsBrowsePerMinute: envVars.RATE_LIMIT_JOBS_BROWSE_PER_MINUTE ?? 120,
    authStrictMax: envVars.RATE_LIMIT_AUTH_STRICT_MAX ?? 30,
    authStrictWindowMinutes: envVars.RATE_LIMIT_AUTH_STRICT_WINDOW_MINUTES ?? 15,
    publicRegistrationMax: envVars.RATE_LIMIT_PUBLIC_REGISTRATION_MAX ?? 45,
    publicRegistrationWindowMinutes: envVars.RATE_LIMIT_PUBLIC_REGISTRATION_WINDOW_MINUTES ?? 60,
    publicWriteMax: envVars.RATE_LIMIT_PUBLIC_WRITE_MAX ?? 120,
    publicWriteWindowMinutes: envVars.RATE_LIMIT_PUBLIC_WRITE_WINDOW_MINUTES ?? 15,
  },
  /** Express `trust proxy` hop count; 0 leaves default (do not trust X-Forwarded-For). Takes precedence over `trustProxy`. */
  trustProxyHops: envVars.TRUST_PROXY_HOPS ?? 0,
  /** When true and trustProxyHops is 0: `app.set('trust proxy', true)`. */
  trustProxy,
  /** In-app SOP reminders after candidate/training updates; set NOTIFY_SOP_REMINDERS=0 to disable. */
  notifySopReminders: process.env.NOTIFY_SOP_REMINDERS !== '0' && process.env.NOTIFY_SOP_REMINDERS !== 'false',
  activityLog: {
    ttlSeconds: envVars.ACTIVITY_LOG_TTL_SECONDS ?? 0,
  },
  designatedSuperadminEmails,
  isDesignatedSuperadminEmail,
  voiceAgentKb: {
    embeddingModel: envVars.KB_EMBEDDING_MODEL || 'text-embedding-3-small',
    embeddingDimensions:
      envVars.KB_EMBEDDING_DIMENSIONS != null && envVars.KB_EMBEDDING_DIMENSIONS !== ''
        ? Number(envVars.KB_EMBEDDING_DIMENSIONS)
        : null,
    chunkTargetTokens: envVars.KB_CHUNK_TARGET_TOKENS ?? 768,
    chunkOverlapTokens: envVars.KB_CHUNK_OVERLAP_TOKENS ?? 128,
    topK: envVars.KB_TOP_K ?? 8,
    minSimilarity: envVars.KB_MIN_SIMILARITY ?? 0.28,
    maxPdfMb: envVars.KB_MAX_PDF_MB ?? 25,
    maxUrlBytes: envVars.KB_MAX_URL_BYTES ?? 2097152,
    maxDocsPerAgent: envVars.KB_MAX_DOCS_PER_AGENT ?? 50,
    queryCacheTtlSeconds: envVars.KB_QUERY_CACHE_TTL_SECONDS ?? 3600,
    queryCacheMissTtlSeconds: envVars.KB_QUERY_CACHE_MISS_TTL_SECONDS ?? 120,
    mongodbVectorSearchEnabled: ['true', '1'].includes(
      String(envVars.MONGODB_VECTOR_SEARCH_ENABLED || '')
        .trim()
        .toLowerCase()
    ),
    bolnaSyncEnabled: ['true', '1'].includes(String(envVars.KB_BOLNA_SYNC_ENABLED || '').trim().toLowerCase()),
    bolnaKbMultilingual: ['true', '1'].includes(String(envVars.KB_BOLNA_KB_MULTILINGUAL || '').trim().toLowerCase()),
    bolnaKbChunkSize: envVars.KB_BOLNA_KB_CHUNK_SIZE ?? null,
    bolnaKbOverlapping: envVars.KB_BOLNA_KB_OVERLAPPING ?? null,
    bolnaKbSimilarityTopK: envVars.KB_BOLNA_KB_SIMILARITY_TOP_K ?? null,
  },
  hrmWebRtc: {
    jwtSecret: (envVars.HRM_WEBRTC_JWT_SECRET || '').trim(),
    jwtIssuer: (envVars.HRM_WEBRTC_JWT_ISSUER || '').trim(),
    jwtAudience: (envVars.HRM_WEBRTC_JWT_AUDIENCE || '').trim(),
    signalingBaseUrl: (envVars.HRM_WEBRTC_SIGNALING_BASE_URL || '').trim().replace(/\/+$/, ''),
    tokenExpirationMinutes: envVars.HRM_WEBRTC_TOKEN_EXPIRATION_MINUTES ?? 15,
  },
  webhooks: {
    bolnaSecret: (envVars.BOLNA_WEBHOOK_SECRET || '').trim(),
  },
  auth: {
    returnTokensInJson:
      envVars.NODE_ENV !== 'production' ||
      ['true', '1'].includes(String(envVars.AUTH_RETURN_TOKENS_IN_JSON || '').trim().toLowerCase()),
  },
  exposeOpenApi:
    envVars.NODE_ENV !== 'production' ||
    ['true', '1'].includes(String(envVars.EXPOSE_OPENAPI || '').trim().toLowerCase()),
  bcryptSaltRounds: envVars.BCRYPT_SALT_ROUNDS ?? 12,
  referral: {
    linkSecret: (() => {
      const s = (envVars.REFERRAL_LINK_SECRET || '').trim();
      if (s.length >= 16) return s;
      return envVars.JWT_SECRET;
    })(),
    defaultOrgId: (envVars.REFERRAL_DEFAULT_ORG_ID || 'default').trim() || 'default',
  },
};

// Production: warn if email/share links would use localhost
if (config.env === 'production') {
  const f = config.frontendBaseUrl || '';
  const b = config.backendPublicUrl || '';
  if (f.includes('localhost') || b.includes('localhost')) {
    // eslint-disable-next-line no-console
    console.warn(
      '[Config] Email and share links will use localhost. Set FRONTEND_BASE_URL and BACKEND_PUBLIC_URL in your deployment env.'
    );
  }
}

export default config;
