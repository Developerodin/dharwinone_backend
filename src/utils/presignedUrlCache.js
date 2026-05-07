const DEFAULT_TTL_MS = 6 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

const store = new Map();

const set = (key, url, ttlMs = DEFAULT_TTL_MS) => {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.delete(key);
  store.set(key, { url, expiresAt: Date.now() + ttlMs });
};

const get = (key) => {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  store.delete(key);
  store.set(key, entry);
  return entry.url;
};

const wrap = (signer) => async (key, expiresInSeconds = 7 * 24 * 3600) => {
  const cached = get(key);
  if (cached) return cached;
  const url = await signer(key, expiresInSeconds);
  const ttlMs = Math.min(DEFAULT_TTL_MS, Math.floor(expiresInSeconds * 1000 * 0.8));
  set(key, url, ttlMs);
  return url;
};

const clear = () => store.clear();

export { get, set, wrap, clear };
export default { get, set, wrap, clear };
