#!/usr/bin/env node
/**
 * Simulation: Email link URL detection across different domains.
 * Verifies how reset-password and verification links are built in:
 * - Localhost (dev)
 * - Staging / production with Origin/Referer
 * - Production with X-Forwarded headers (reverse proxy)
 * - Explicit FRONTEND_BASE_URL env
 *
 * Run: node scripts/simulate-email-links.mjs
 * Or with production env: FRONTEND_BASE_URL=https://app.dharwin.com node scripts/simulate-email-links.mjs
 */

/* eslint-disable no-console */

const defaultBase = (configBase) => (configBase || 'http://localhost:3001').replace(/\/$/, '');

function resolveFrontendBaseUrl(req, override, configBase) {
  const fallback = defaultBase(configBase);

  if (override && typeof override === 'string' && override.trim()) {
    return override.trim().replace(/\/$/, '');
  }

  if (req && req.headers) {
    const origin = req.headers.origin || req.headers.Origin;
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.origin) return url.origin;
      } catch {
        /* ignore */
      }
    }

    const referer = req.headers.referer || req.headers.Referer;
    if (referer) {
      try {
        const url = new URL(referer);
        if (url.origin) return url.origin;
      } catch {
        /* ignore */
      }
    }

    const forwardedHost = req.headers['x-forwarded-host'] || req.headers['X-Forwarded-Host'];
    const forwardedProto = req.headers['x-forwarded-proto'] || req.headers['X-Forwarded-Proto'] || 'https';
    if (forwardedHost) {
      const host = Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost.split(',')[0].trim();
      const proto = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto.split(',')[0].trim();
      if (host && !host.match(/^api\./) && !host.includes(':3000')) {
        return `${proto}://${host}`.replace(/\/$/, '');
      }
    }
  }

  return fallback;
}

function buildResetUrl(base, token) {
  return `${base}/authentication/reset-password/${token}`;
}

function buildVerifyUrl(base, token) {
  return `${base}/authentication/verify-email/${token}`;
}

const TOKEN = 'sample-token-abc123';

// Use FRONTEND_BASE_URL from env if set (simulates production run)
const envConfig = process.env.FRONTEND_BASE_URL || null;

const scenarios = [
  {
    name: 'Localhost (no req, no config)',
    req: null,
    override: null,
    configBase: null,
    expected: 'http://localhost:3001',
  },
  {
    name: 'Localhost with Origin',
    req: { headers: { origin: 'http://localhost:3001' } },
    override: null,
    configBase: null,
    expected: 'http://localhost:3001',
  },
  {
    name: 'Localhost with Referer',
    req: { headers: { referer: 'http://localhost:3001/authentication/forgot-password/' } },
    override: null,
    configBase: null,
    expected: 'http://localhost:3001',
  },
  {
    name: 'Production with Origin',
    req: { headers: { origin: 'https://app.dharwin.com' } },
    override: null,
    configBase: 'https://app.dharwin.com',
    expected: 'https://app.dharwin.com',
  },
  {
    name: 'Staging with Referer',
    req: { headers: { referer: 'https://staging.dharwin.com/authentication/forgot-password/' } },
    override: null,
    configBase: 'https://app.dharwin.com',
    expected: 'https://staging.dharwin.com',
  },
  {
    name: 'Production with X-Forwarded (reverse proxy)',
    req: {
      headers: {
        'x-forwarded-host': 'app.dharwin.com',
        'x-forwarded-proto': 'https',
      },
    },
    override: null,
    configBase: 'https://app.dharwin.com',
    expected: 'https://app.dharwin.com',
  },
  {
    name: 'Production config fallback (no req)',
    req: null,
    override: null,
    configBase: 'https://app.dharwin.com',
    expected: 'https://app.dharwin.com',
  },
  {
    name: 'Env FRONTEND_BASE_URL (when configBase undefined)',
    req: null,
    override: null,
    configBase: undefined,
    expected: envConfig || 'http://localhost:3001',
  },
  {
    name: 'Explicit override wins',
    req: { headers: { origin: 'https://staging.dharwin.com' } },
    override: 'https://custom.example.com',
    configBase: 'https://app.dharwin.com',
    expected: 'https://custom.example.com',
  },
  {
    name: 'API host ignored (use config)',
    req: {
      headers: {
        'x-forwarded-host': 'api.dharwin.com',
        'x-forwarded-proto': 'https',
      },
    },
    override: null,
    configBase: 'https://app.dharwin.com',
    expected: 'https://app.dharwin.com',
  },
  {
    name: 'Backend port 3000 ignored (use config)',
    req: {
      headers: {
        'x-forwarded-host': 'localhost:3000',
        'x-forwarded-proto': 'http',
      },
    },
    override: null,
    configBase: 'http://localhost:3001',
    expected: 'http://localhost:3001',
  },
];

console.log('═══ Email Link URL Simulation ═══\n');
console.log('Env FRONTEND_BASE_URL:', envConfig || '(not set)\n');

let passed = 0;
let failed = 0;

for (const s of scenarios) {
  const configBase = s.configBase !== undefined ? s.configBase : envConfig;
  const result = resolveFrontendBaseUrl(s.req, s.override, configBase);
  const ok = result === s.expected;

  if (ok) passed++;
  else failed++;

  const status = ok ? '✓' : '✗';
  console.log(`${status} ${s.name}`);
  console.log(`   Base URL: ${result}`);
  if (!ok) {
    console.log(`   Expected: ${s.expected}`);
  }
  console.log(`   Reset:    ${buildResetUrl(result, TOKEN)}`);
  console.log(`   Verify:   ${buildVerifyUrl(result, TOKEN)}`);
  console.log();
}

console.log('─────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
