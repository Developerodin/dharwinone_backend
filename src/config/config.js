import dotenv from 'dotenv';
import path from 'path';
import Joi from 'joi';

dotenv.config();

const envVarsSchema = Joi.object()
  .keys({
    NODE_ENV: Joi.string().valid('production', 'development', 'test').required(),
    PORT: Joi.number().default(3000),
    MONGODB_URL: Joi.string().required().description('MongoDB URL'),
    JWT_SECRET: Joi.string().required().description('JWT secret key'),
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

    // CORS / Frontend
    CORS_ORIGIN: Joi.string().optional().description('Allowed CORS origin (comma-separated for multiple origins)'),
    FRONTEND_BASE_URL: Joi.string().optional().description('Frontend base URL for email links'),
    BACKEND_PUBLIC_URL: Joi.string().optional().description('Backend public URL for share links (e.g. https://api.example.com)'),

    // OpenAI (blog AI)
    OPENAI_API_KEY: Joi.string().optional().description('OpenAI API key for blog generation'),

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
    BOLNA_FROM_PHONE_NUMBER: Joi.string().optional().description('Bolna caller ID in E.164 format'),
    CALLER_ID: Joi.string().optional().description('Fallback caller ID for AddOn compatibility'),
    BOLNA_API_BASE: Joi.string().optional().default('https://api.bolna.ai').description('Bolna API base URL'),
  })
  .unknown();

const { value: envVars, error } = envVarsSchema.prefs({ errors: { label: 'key' } }).validate(process.env);

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

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
      auth: {
        user: envVars.SMTP_USERNAME,
        pass: envVars.SMTP_PASSWORD,
      },
    },
    from: envVars.EMAIL_FROM,
    replyTo: envVars.EMAIL_REPLY_TO,
  },
  corsOrigin: envVars.CORS_ORIGIN ? envVars.CORS_ORIGIN.split(',').map((o) => o.trim()) : true,
  frontendBaseUrl: envVars.FRONTEND_BASE_URL || 'http://localhost:3001',
  backendPublicUrl: envVars.BACKEND_PUBLIC_URL || `http://localhost:${envVars.PORT}`,
  openai: {
    apiKey: envVars.OPENAI_API_KEY || '',
  },
  aws: {
    accessKeyId: envVars.AWS_ACCESS_KEY_ID,
    secretAccessKey: envVars.AWS_SECRET_ACCESS_KEY,
    region: envVars.AWS_REGION,
    bucketName: envVars.AWS_S3_BUCKET_NAME,
  },
  livekit: {
    url: envVars.LIVEKIT_URL || 'ws://localhost:7880',
    apiKey: envVars.LIVEKIT_API_KEY,
    apiSecret: envVars.LIVEKIT_API_SECRET,
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
    agentId: envVars.BOLNA_AGENT_ID || '6afbccea-0495-4892-937c-6a5c9af12440',
    fromPhoneNumber: envVars.BOLNA_FROM_PHONE_NUMBER || envVars.CALLER_ID || '',
    apiBase: envVars.BOLNA_API_BASE || 'https://api.bolna.ai',
  },
};

export default config;
