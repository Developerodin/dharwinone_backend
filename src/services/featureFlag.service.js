import config from '../config/config.js';

const CACHE_TTL_MS = 60000;
const cache = new Map();

const ROLLOUTS = new Set(['off', 'internal', 'tenant-allowlist', 'all']);

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

const cacheKey = (flagKey, userId, email) => `${flagKey}:${userId || ''}:${email || ''}`;

const readCache = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit.value;
};

const writeCache = (key, value) => {
  cache.set(key, { at: Date.now(), value });
};

/** Test-only: clear in-memory flag cache between cases. */
export const __resetFeatureFlagCache = () => {
  cache.clear();
};

const resolveTaskboardV2 = (user) => {
  const { rollout, allowlistEmails } = config.featureFlags.taskboardV2;
  const email = normalizeEmail(user?.email);
  const onAllowlist = email && allowlistEmails.has(email);
  const isInternal = email && config.isDesignatedSuperadminEmail(email);

  let enabled = false;
  let userOverride = false;

  if (onAllowlist) {
    enabled = true;
    userOverride = rollout !== 'all';
  } else if (rollout === 'all') {
    enabled = true;
  } else if (rollout === 'internal' && isInternal) {
    enabled = true;
  } else if (rollout === 'tenant-allowlist' && onAllowlist) {
    enabled = true;
  }

  return {
    enabled,
    ...(userOverride ? { userOverride: true } : {}),
    rollout,
  };
};

const RESOLVERS = {
  'taskboard-v2': resolveTaskboardV2,
};

/**
 * Resolve a runtime feature flag for the authenticated user.
 * Unknown keys return { enabled: false, rollout: 'off' }.
 */
export const resolveFeatureFlag = (flagKey, user) => {
  const key = typeof flagKey === 'string' ? flagKey.trim() : '';
  const userId = user?.id || user?._id || '';
  const email = normalizeEmail(user?.email);
  const ck = cacheKey(key, userId, email);
  const cached = readCache(ck);
  if (cached) return cached;

  const resolver = RESOLVERS[key];
  const value = resolver
    ? resolver(user)
    : { enabled: false, rollout: 'off' };

  if (!ROLLOUTS.has(value.rollout)) {
    value.rollout = 'off';
  }

  writeCache(ck, value);
  return value;
};
