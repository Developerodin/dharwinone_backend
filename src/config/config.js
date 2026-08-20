import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import Joi from 'joi';

/** Stable 0–99 bucket for percent rollout gates (CHATBOT_ENTITY_QUERY_EMPLOYEES_PERCENT). */
export function stableHashUserId(userId) {
  const hash = crypto.createHash('sha256').update(String(userId)).digest();
  return hash.readUInt32BE(0) % 100;
}

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
      .default(24 * 60)
      .description('minutes after which verify email token expires (default 24h; JWT + Token.expires)'),
    SMTP_HOST: Joi.string().description('server that will send the emails'),
    SMTP_PORT: Joi.number().description('port to connect to the email server'),
    SMTP_TIMEOUT: Joi.number()
      .optional()
      .description('SMTP connection/greeting/socket timeout in seconds (e.g. 7 for Outlook)'),
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
    GCP_GOOGLE_APP_CLIENT_ID_ANDROID: Joi.string()
      .optional()
      .description('Google OAuth client ID for the Android app (installed/PKCE client, no secret)'),
    GCP_GOOGLE_APP_CLIENT_ID_IOS: Joi.string()
      .optional()
      .description('Google OAuth client ID for the iOS app (installed/PKCE client, no secret)'),
    EXPO_ACCESS_TOKEN: Joi.string()
      .optional()
      .description('Expo access token for sending push notifications (optional; enables enhanced security + rate limits)'),

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
    LIVEKIT_AGENTS_ENABLED: Joi.boolean()
      .truthy('true', '1')
      .falsy('false', '0')
      .default(true)
      .description('Dispatch meeting-summary and meeting-assistant LiveKit agents (set false to disable)'),

    // Bolna Calling
    BOLNA_API_KEY: Joi.string().optional().description('Bolna API key'),
    BOLNA_AGENT_ID: Joi.string().optional().description('Bolna agent ID'),
    BOLNA_CANDIDATE_AGENT_ID: Joi.string().optional().description('Bolna agent ID for candidate verification calls'),
    BOLNA_ADDITIONAL_AGENT_IDS: Joi.string()
      .optional()
      .description('Comma-separated extra Bolna agent IDs (e.g. retired agents still holding call history) to also pull executions/recordings from'),
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

    // Plivo — phone number search + purchase (HTTP Basic auth)
    PLIVO_AUTH_ID: Joi.string().optional().description('Plivo Auth ID'),
    PLIVO_AUTH_TOKEN: Joi.string().optional().description('Plivo Auth Token'),
    /** Public base URL Plivo fetches the call answer-XML from. Defaults to BACKEND_PUBLIC_URL. Must be publicly reachable (not localhost) — use an ngrok tunnel in dev. */
    PLIVO_ANSWER_BASE_URL: Joi.string().optional().description('Public base URL for Plivo answer_url webhook'),

    // Telephony provider switch + Twilio Voice (see docs/TWILIO_INTEGRATION_PLAN.md)
    TELEPHONY_PROVIDER: Joi.string().valid('plivo', 'twilio').optional().default('plivo'),
    TWILIO_AUTH_ID: Joi.string().optional().description('Twilio Account SID'),
    TWILIO_AUTH_TOKEN: Joi.string().optional().description('Twilio Auth Token'),
    TWILIO_API_SID: Joi.string().optional().description('Twilio API Key SID for Access Tokens'),
    TWILIO_API_SECRET: Joi.string().optional().description('Twilio API Key Secret'),
    TWILIO_TWIML_APP_SID: Joi.string().optional().description('Twilio TwiML App SID for Voice SDK'),
    TWILIO_PHONE_NUMBER: Joi.string().optional().description('Fallback outbound caller ID'),
    TWILIO_WEBHOOK_BASE_URL: Joi.string().optional().description('Deployed backend origin for Twilio webhooks'),
    TWILIO_VERIFY_WEBHOOKS: Joi.string().optional().description('true|false — validate X-Twilio-Signature'),
    TWILIO_INTELLIGENCE_SERVICE_SID: Joi.string().optional().description('Optional Conversational Intelligence service SID'),
    TWILIO_INBOUND_DEFAULT_USER: Joi.string().optional().description('Mongo user id that inbound PSTN calls ring (Voice SDK client)'),
    TWILIO_PUSH_CREDENTIAL_SID_IOS: Joi.string().optional().description('Twilio Push Credential SID for iOS VoIP push'),
    TWILIO_PUSH_CREDENTIAL_SID_ANDROID: Joi.string().optional().description('Twilio Push Credential SID for Android FCM push'),

    // Apollo.io — HR contact enrichment for External Jobs
    APOLLO_IO_API_KEY: Joi.string().optional().description('Apollo.io Master API key for people search and enrichment'),
    APOLLO_WEBHOOK_SECRET: Joi.string().optional().description('Random secret token in the Apollo webhook URL path to prevent spoofing'),

    // Microsoft / Outlook OAuth
    MICROSOFT_CLIENT_ID: Joi.string().optional().description('Microsoft OAuth client ID (for Outlook)'),
    MICROSOFT_CLIENT_SECRET: Joi.string().optional().description('Microsoft OAuth client secret'),
    MICROSOFT_REDIRECT_URI: Joi.string().optional().description('Microsoft OAuth redirect URI'),
    MICROSOFT_TENANT_ID: Joi.string().optional().default('common').description('Microsoft tenant ID (common for multi-tenant)'),
    // Separate Azure App Registration used by the mobile app (react-native-app-auth, public/PKCE client).
    // Refresh tokens are bound to the issuing client_id, so app-connected mailboxes must be refreshed with this client.
    MICROSOFT_APP_CLIENT_ID: Joi.string().optional().description('Microsoft OAuth client ID for the mobile app (public/PKCE client)'),
    MICROSOFT_APP_TENANT_ID: Joi.string().optional().description('Microsoft tenant ID for the mobile app registration (defaults to MICROSOFT_TENANT_ID)'),

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

    /** Candidate scheduler (`employee.scheduler.js`): resign auto-deactivate, joining reminders, role promotion, offer expiry. Default 5 min. */
    CANDIDATE_SCHEDULER_INTERVAL_MINUTES: Joi.number().integer().min(1).max(1440).optional().default(5),

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

    CONTACT_LOOKUP_HASH_SECRET: Joi.string()
      .min(32)
      .optional()
      .description('HMAC key for contact-lookup audit email hashes; derived from JWT_SECRET if unset'),
    CONTACT_LOOKUP_PER_MINUTE: Joi.number().integer().min(1).default(20),
    CONTACT_LOOKUP_PER_MINUTE_PER_IP: Joi.number().integer().min(1).default(40),

    PINECONE_API_KEY: Joi.string().optional().allow('').description('Pinecone API key for vector search'),
    PINECONE_INDEX: Joi.string().optional().default('dharwin-hr').description('Pinecone index name'),

    // Vector store selection. Both backends implement the same contract
    // (utils/pinecone.util.js dispatches), so switching is an env change plus a
    // re-run of the embedding sync to populate the newly selected store.
    VECTOR_DB: Joi.string().valid('pinecone', 'qdrant').default('pinecone')
      .description('Which vector database to use: pinecone | qdrant'),
    QDRANT_URL: Joi.string().uri().optional().allow('').default('http://127.0.0.1:6333')
      .description('Qdrant REST endpoint (docker-compose.qdrant.yml serves this for local dev)'),
    QDRANT_API_KEY: Joi.string().optional().allow('')
      .description('Qdrant API key — required for Qdrant Cloud, blank for a local container'),
    QDRANT_COLLECTION_PREFIX: Joi.string().optional().allow('')
      .description('Qdrant collection prefix; defaults to PINECONE_INDEX so both backends share one naming scheme'),

    // Chatbot — two-stage pipeline (classifier + scoped fetcher)
    CHATBOT_TWO_STAGE: Joi.boolean().default(false).description('Enable two-stage chatbot pipeline (classifier + scoped fetcher)'),
    CHATBOT_ENTITY_QUERY_EMPLOYEES: Joi.boolean()
      .default(false)
      .description('Route chatbot employee queries through canonical entityQuery pipeline'),
    CHATBOT_ENTITY_QUERY_EMPLOYEES_PERCENT: Joi.number()
      .integer()
      .min(0)
      .max(100)
      .default(100)
      .description('Percent of users (stable hash) enrolled in entityQuery when flag is on; 100 = all'),
    CHATBOT_QUERY_AUDIT_DEBUG: Joi.boolean()
      .default(false)
      .description('Include raw mongo filter in employee query audit logs (incident response only)'),

    // === AI Meeting Summary (Phase 1 — see docs/superpowers/specs/2026-05-11-...) ===
    OPENAI_MODEL_SUMMARY: Joi.string().default('gpt-4o-mini'),
    OPENAI_MODEL_EXTRACTION: Joi.string().default('gpt-4o'),
    OPENAI_MAX_INPUT_TOKENS: Joi.number().default(120000),
    SUMMARY_FINALIZE_TIMEOUT_MS: Joi.number().default(300000),
    SUMMARY_WORKER_CONCURRENCY: Joi.number().default(4),
    SUMMARY_MAP_WINDOW_TOKENS: Joi.number().default(6000),
    SUMMARY_MAP_PARALLELISM: Joi.number().default(5),
    AI_TRANSCRIPT_SEGMENT_WINDOW_MS: Joi.number().default(30000),
    AI_TRANSCRIPT_SEGMENT_BATCH_LIMIT: Joi.number().default(50),
    MAX_MEETING_DURATION_MINUTES: Joi.number().default(240),
    MAX_TRANSCRIPT_TOKENS: Joi.number().default(200000),
    REDIS_URL: Joi.string().default('redis://localhost:6379'),
    REDIS_QUEUE_DB: Joi.number().default(1),
    REDIS_PARTIAL_TRANSCRIPT_DB: Joi.number().default(2),
    REDIS_ENABLED: Joi.string().valid('true', 'false', '1', '0', '').optional().allow(null).empty(''),
    TRANSCRIPT_RETENTION_DAYS: Joi.number().default(365),
    SUMMARY_RETENTION_DAYS: Joi.number().default(365),
    AGENT_DISPATCH_RETENTION_DAYS: Joi.number().default(30),
    PROCESSED_WEBHOOK_RETENTION_DAYS: Joi.number().default(7),
    DLQ_RETENTION_DAYS: Joi.number().default(90),
    PRESIGN_EXPIRY_SECONDS: Joi.number().default(900),

    /** Task board V2 runtime flag (GET /v1/feature-flags/taskboard-v2). V2 is the only UI; default all. */
    FEATURE_FLAG_TASKBOARD_V2_ROLLOUT: Joi.string()
      .valid('off', 'internal', 'tenant-allowlist', 'all')
      .optional()
      .default('all'),
    /** Comma-separated user emails always enabled for taskboard-v2 (even when rollout is off). */
    FEATURE_FLAG_TASKBOARD_V2_ALLOWLIST: Joi.string().optional().allow(''),
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

/** Nodemailer SMTP — Microsoft 365 / Outlook uses STARTTLS on 587 (secure: false). */
const smtpPort = Number(envVars.SMTP_PORT) || 587;
const smtpTimeoutSec = Number(envVars.SMTP_TIMEOUT);
const smtpTimeoutMs =
  Number.isFinite(smtpTimeoutSec) && smtpTimeoutSec > 0 ? smtpTimeoutSec * 1000 : undefined;
const smtpTlsRejectUnauthorized = !['false', '0'].includes(
  String(envVars.SMTP_TLS_REJECT_UNAUTHORIZED ?? 'true')
    .trim()
    .toLowerCase()
);
const smtpTransport = {
  host: envVars.SMTP_HOST,
  port: smtpPort,
  secure: smtpPort === 465,
  // O365 rejects bursts of parallel SMTP connections with "432 4.3.2 Concurrent
  // connections limit exceeded" (seen when a meeting invite fans out to 19 recipients
  // at once — 5 of them never got the email). Pooling funnels all sends through a few
  // persistent connections; nodemailer queues the rest internally.
  pool: true,
  maxConnections: Number(envVars.SMTP_MAX_CONNECTIONS) || 2,
  maxMessages: 100,
  auth: {
    user: envVars.SMTP_USERNAME,
    pass: envVars.SMTP_PASSWORD,
  },
};
if (smtpTimeoutMs) {
  smtpTransport.connectionTimeout = smtpTimeoutMs;
  smtpTransport.greetingTimeout = smtpTimeoutMs;
  smtpTransport.socketTimeout = smtpTimeoutMs;
}
// Only disable TLS verification when explicitly requested (dev/self-signed). Outlook/M365 expects default verification.
if (!smtpTlsRejectUnauthorized) {
  smtpTransport.tls = { rejectUnauthorized: false };
}

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
    options: {
      // Production: indexes are managed by deploys/migrations, not by every Node boot.
      // autoIndex=true makes mongoose ensure every schema index on connect — that
      // serializes index builds and spikes RAM during startup (each duplicate-index
      // warning we ship today turns into a real `createIndexes` call). Set
      // MONGOOSE_AUTO_INDEX=1 once when you intentionally want to apply new indexes,
      // then unset it.
      autoIndex: envVars.NODE_ENV !== 'production'
        || ['1', 'true'].includes(String(process.env.MONGOOSE_AUTO_INDEX || '').toLowerCase()),
      // Bound the connection pool — Render dynos can OOM if mongoose opens unlimited sockets
      // (each socket buffers replies). 20 is enough for a single-region web dyno.
      maxPoolSize: Number(process.env.MONGOOSE_MAX_POOL || 20),
      minPoolSize: Number(process.env.MONGOOSE_MIN_POOL || 2),
      // Atlas / VPN / Docker DNS can exceed 10s; dev default is more forgiving. Override with MONGOOSE_SERVER_SELECTION_MS.
      serverSelectionTimeoutMS: Number(
        process.env.MONGOOSE_SERVER_SELECTION_MS ??
          (envVars.NODE_ENV === 'development' ? 30000 : 10000)
      ),
      socketTimeoutMS: Number(process.env.MONGOOSE_SOCKET_TIMEOUT_MS || 45000),
    },
  },
  jwt: {
    secret: envVars.JWT_SECRET,
    accessExpirationMinutes: envVars.JWT_ACCESS_EXPIRATION_MINUTES,
    refreshExpirationDays: envVars.JWT_REFRESH_EXPIRATION_DAYS,
    resetPasswordExpirationMinutes: envVars.JWT_RESET_PASSWORD_EXPIRATION_MINUTES,
    verifyEmailExpirationMinutes: envVars.JWT_VERIFY_EMAIL_EXPIRATION_MINUTES,
  },
  email: {
    smtp: smtpTransport,
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
  // Expo push notifications. accessToken is optional (see push.service.js).
  expo: {
    accessToken: (envVars.EXPO_ACCESS_TOKEN || '').trim(),
  },
  // Mobile app's Google OAuth clients (installed/PKCE, no secret). Used to refresh tokens for
  // Gmail accounts connected from the app, since refresh tokens are bound to their issuing client_id.
  googleApp: {
    androidClientId: (envVars.GCP_GOOGLE_APP_CLIENT_ID_ANDROID || '').trim(),
    iosClientId: (envVars.GCP_GOOGLE_APP_CLIENT_ID_IOS || '').trim(),
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
  // Mobile app's Azure App Registration (public/PKCE client). Used to refresh tokens for
  // accounts connected from the app, since refresh tokens are bound to their issuing client_id.
  microsoftApp: {
    clientId: (envVars.MICROSOFT_APP_CLIENT_ID || '').trim(),
    tenantId: (() => {
      const t = (envVars.MICROSOFT_APP_TENANT_ID || envVars.MICROSOFT_TENANT_ID || 'common').trim();
      return t || 'common';
    })(),
  },
  aws: {
    accessKeyId: envVars.AWS_ACCESS_KEY_ID ? String(envVars.AWS_ACCESS_KEY_ID).trim() : undefined,
    secretAccessKey: envVars.AWS_SECRET_ACCESS_KEY ? String(envVars.AWS_SECRET_ACCESS_KEY).trim() : undefined,
    region: String(envVars.AWS_REGION || 'us-east-1').trim(),
    bucketName: envVars.AWS_S3_BUCKET_NAME ? String(envVars.AWS_S3_BUCKET_NAME).trim() : undefined,
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
    agentsEnabled: envVars.LIVEKIT_AGENTS_ENABLED,
  },
  bolna: {
    apiKey: envVars.BOLNA_API_KEY || '',
    /** Job posting / recruiter verification calls (no prompt PATCH in app). */
    agentId: String(envVars.BOLNA_AGENT_ID || '').trim(),
    /**
     * Applicant verification only — receives PATCH system prompt before each call.
     * Must differ from agentId or flows overwrite each other’s behavior.
     */
    candidateAgentId: String(envVars.BOLNA_CANDIDATE_AGENT_ID || '').trim(),
    /**
     * Extra agent IDs to ALSO pull executions/recordings from. Set when an agent
     * is retired/replaced (e.g. a new job-verification agent) but the old agent
     * still holds historical call recordings. Comma-separated in env.
     */
    additionalAgentIds: String(envVars.BOLNA_ADDITIONAL_AGENT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    fromPhoneNumber: envVars.BOLNA_FROM_PHONE_NUMBER || envVars.CALLER_ID || '',
    apiBase: envVars.BOLNA_API_BASE || 'https://api.bolna.ai',
    /** Applied to every outbound call; mirror in Bolna dashboard Call tab for each agent. */
    maxCallDurationSeconds: envVars.BOLNA_MAX_CALL_DURATION_SECONDS,
  },
  plivo: {
    authId: envVars.PLIVO_AUTH_ID || '',
    authToken: envVars.PLIVO_AUTH_TOKEN || '',
    /** Where Plivo fetches call answer-XML. Must be publicly reachable; falls back to the backend public URL. */
    answerBaseUrl: (envVars.PLIVO_ANSWER_BASE_URL || resolvedBackendPublicUrl).replace(/\/$/, ''),
  },
  telephony: {
    provider: envVars.TELEPHONY_PROVIDER === 'twilio' ? 'twilio' : 'plivo',
  },
  twilio: {
    accountSid: envVars.TWILIO_AUTH_ID || '',
    authToken: envVars.TWILIO_AUTH_TOKEN || '',
    apiKeySid: envVars.TWILIO_API_SID || '',
    apiKeySecret: envVars.TWILIO_API_SECRET || '',
    twimlAppSid: envVars.TWILIO_TWIML_APP_SID || '',
    phoneNumber: envVars.TWILIO_PHONE_NUMBER || '',
    webhookBaseUrl: (envVars.TWILIO_WEBHOOK_BASE_URL || resolvedBackendPublicUrl).replace(/\/$/, ''),
    verifyWebhooks:
      String(envVars.TWILIO_VERIFY_WEBHOOKS || '').toLowerCase() === 'true'
        ? true
        : String(envVars.TWILIO_VERIFY_WEBHOOKS || '').toLowerCase() === 'false'
          ? false
          : undefined,
    intelligenceServiceSid: envVars.TWILIO_INTELLIGENCE_SERVICE_SID || '',
    inboundDefaultUser: (envVars.TWILIO_INBOUND_DEFAULT_USER || '').trim(),
    pushCredentialSidIos: envVars.TWILIO_PUSH_CREDENTIAL_SID_IOS || '',
    pushCredentialSidAndroid: envVars.TWILIO_PUSH_CREDENTIAL_SID_ANDROID || '',
  },
  apollo: {
    apiKey: envVars.APOLLO_IO_API_KEY || '',
    webhookSecret: (envVars.APOLLO_WEBHOOK_SECRET || '').trim(),
  },
  contactLookup: {
    hashSecret: envVars.CONTACT_LOOKUP_HASH_SECRET || '',
    perMinute: envVars.CONTACT_LOOKUP_PER_MINUTE,
    perMinutePerIp: envVars.CONTACT_LOOKUP_PER_MINUTE_PER_IP,
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
  /** ATS offer → placement → onboarding (feature flags and optional defaults) */
  ats: {
    joiningRemindersEnabled: ['true', '1'].includes(String(process.env.JOINING_REMINDERS_ENABLED || '').toLowerCase()),
    preboardingChecklistEnabled: process.env.PREBOARDING_CHECKLIST_ENABLED !== 'false',
    onboardingChecklistEnabled: process.env.ONBOARDING_CHECKLIST_ENABLED !== 'false',
    defaultOnboardingModuleId: (process.env.DEFAULT_ONBOARDING_MODULE_ID || '').trim(),
  },
  candidate: {
    schedulerIntervalMinutes: envVars.CANDIDATE_SCHEDULER_INTERVAL_MINUTES,
  },
  pinecone: {
    apiKey: envVars.PINECONE_API_KEY || '',
    indexName: envVars.PINECONE_INDEX || 'dharwin-hr',
  },
  vectorDb: {
    /** 'pinecone' | 'qdrant' — read by utils/pinecone.util.js, which dispatches. */
    provider: envVars.VECTOR_DB || 'pinecone',
    qdrant: {
      url: envVars.QDRANT_URL || 'http://127.0.0.1:6333',
      apiKey: envVars.QDRANT_API_KEY || '',
      // Same logical index name as Pinecone so the two stores stay comparable.
      collectionPrefix: envVars.QDRANT_COLLECTION_PREFIX || envVars.PINECONE_INDEX || 'dharwin-hr',
    },
  },
  chatbot: {
    /** When true, classifier+fetchPeople runs in prepareContext. entityQuery early gate still wins for employee queries when entityQueryEmployees is on. */
    twoStage: envVars.CHATBOT_TWO_STAGE,
    entityQueryEmployees: envVars.CHATBOT_ENTITY_QUERY_EMPLOYEES,
    entityQueryEmployeesPercent: envVars.CHATBOT_ENTITY_QUERY_EMPLOYEES_PERCENT,
    queryAuditDebug: envVars.CHATBOT_QUERY_AUDIT_DEBUG,
  },
  ai: {
    summaryModel: envVars.OPENAI_MODEL_SUMMARY,
    extractionModel: envVars.OPENAI_MODEL_EXTRACTION,
    maxInputTokens: envVars.OPENAI_MAX_INPUT_TOKENS,
    finalizeTimeoutMs: envVars.SUMMARY_FINALIZE_TIMEOUT_MS,
    workerConcurrency: envVars.SUMMARY_WORKER_CONCURRENCY,
    mapWindowTokens: envVars.SUMMARY_MAP_WINDOW_TOKENS,
    mapParallelism: envVars.SUMMARY_MAP_PARALLELISM,
    segmentWindowMs: envVars.AI_TRANSCRIPT_SEGMENT_WINDOW_MS,
    segmentBatchLimit: envVars.AI_TRANSCRIPT_SEGMENT_BATCH_LIMIT,
    maxMeetingDurationMinutes: envVars.MAX_MEETING_DURATION_MINUTES,
    maxTranscriptTokens: envVars.MAX_TRANSCRIPT_TOKENS,
    presignExpirySeconds: envVars.PRESIGN_EXPIRY_SECONDS,
  },
  redis: {
    enabled: String(envVars.REDIS_ENABLED ?? '').trim().toLowerCase() === 'true' || String(envVars.REDIS_ENABLED ?? '').trim() === '1',
    url: envVars.REDIS_URL,
    queueDb: envVars.REDIS_QUEUE_DB,
    partialDb: envVars.REDIS_PARTIAL_TRANSCRIPT_DB,
  },
  retention: {
    transcriptDays: envVars.TRANSCRIPT_RETENTION_DAYS,
    summaryDays: envVars.SUMMARY_RETENTION_DAYS,
    agentDispatchDays: envVars.AGENT_DISPATCH_RETENTION_DAYS,
    processedWebhookDays: envVars.PROCESSED_WEBHOOK_RETENTION_DAYS,
    dlqDays: envVars.DLQ_RETENTION_DAYS,
  },
  featureFlags: {
    taskboardV2: {
      rollout: envVars.FEATURE_FLAG_TASKBOARD_V2_ROLLOUT || 'off',
      allowlistEmails: new Set(
        (envVars.FEATURE_FLAG_TASKBOARD_V2_ALLOWLIST || '')
          .split(',')
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean)
      ),
    },
  },
};

// Unified list of every Bolna agent we own — job recruiter, candidate, and any
// retired agents kept around for their historical recordings. Use this anywhere
// you enumerate agents (execution sync, recording backfill) so old-agent calls
// are never missed.
config.bolna.allAgentIds = [
  ...new Set(
    [config.bolna.agentId, config.bolna.candidateAgentId, ...config.bolna.additionalAgentIds].filter(Boolean)
  ),
];

// Production: warn if email/share links would use localhost or SMTP is incomplete
if (config.env === 'production') {
  const f = config.frontendBaseUrl || '';
  const b = config.backendPublicUrl || '';
  if (f.includes('localhost') || b.includes('localhost')) {
    // eslint-disable-next-line no-console
    console.warn(
      '[Config] Email and share links will use localhost. Set FRONTEND_BASE_URL and BACKEND_PUBLIC_URL in your deployment env.'
    );
  }
  const missingSmtp = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'EMAIL_FROM'].filter(
    (key) => !String(envVars[key] ?? '').trim()
  );
  if (missingSmtp.length) {
    // eslint-disable-next-line no-console
    console.warn(`[Config] SMTP not fully configured for production mail: ${missingSmtp.join(', ')}`);
  }
  if (config.bolna.apiKey) {
    const missingBolna = ['BOLNA_AGENT_ID', 'BOLNA_CANDIDATE_AGENT_ID'].filter(
      (key) => !String(envVars[key] ?? '').trim()
    );
    if (missingBolna.length) {
      // eslint-disable-next-line no-console
      console.warn(
        `[Config] Bolna API key is set but agent IDs are missing: ${missingBolna.join(', ')}. Voice calls will fail until configured.`
      );
    }
  }
}

export default config;
