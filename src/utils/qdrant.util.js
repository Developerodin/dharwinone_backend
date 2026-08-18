// uat.dharwin.backend/src/utils/qdrant.util.js
//
// Qdrant implementation of the vector-store contract. Selected by VECTOR_DB=qdrant;
// pinecone.util.js is the façade that dispatches here, so nothing else in the app
// imports this file directly and a Pinecone deployment never loads the Qdrant SDK.
//
// Mapping from the Pinecone model:
//   index + namespace  ->  one Qdrant collection per namespace, named
//                          `${QDRANT_COLLECTION_PREFIX}__${namespace}`
//   record id (string) ->  deterministic UUIDv5 point id (Qdrant ids must be uint
//                          or UUID); the original string is kept in the payload as
//                          `_vectorId` so deletes and reads round-trip.
//   metadata           ->  Qdrant payload, verbatim.
//
// Collections are created on demand with the same geometry Pinecone uses
// (1536 dims, cosine), so embeddings are interchangeable between the backends.

import crypto from 'crypto';
import { QdrantClient } from '@qdrant/js-client-rest';
import config from '../config/config.js';
import logger from '../config/logger.js';

const VECTOR_SIZE = 1536;
const DISTANCE = 'Cosine';

/**
 * Payload fields to index, per namespace. Qdrant needs a payload index on a
 * filtered field to estimate its cardinality; without one a filtered search
 * cannot plan against the HNSW graph and degrades toward a scan whose cost grows
 * with total vectors rather than with the matching slice.
 *
 * Only `jobs` is queried with a filter today — chatAssistant.service.js:2671 and
 * :2756. The employees/students queries pass null, so indexing those collections
 * would cost memory and buy nothing; add entries here if a filter is added there.
 *
 * These must stay in step with the payload written by embeddingSync.scheduler.js
 * (`upsertJobs` and the Job post-save hook). An index on a field the payload never
 * writes is inert — it cannot make a clause match.
 */
const INDEXED_PAYLOAD_FIELDS = {
  jobs: ['status', 'jobOrigin', 'jobType', 'location', 'experienceLevel'],
};

let _client = null;
const _ensuredCollections = new Map();

function getClient() {
  if (_client) return _client;
  const { url, apiKey } = config.vectorDb.qdrant;
  if (!url) throw new Error('QDRANT_URL not configured');
  _client = new QdrantClient({
    url,
    ...(apiKey ? { apiKey } : {}),
    // The SDK otherwise refuses any server whose minor version differs from its
    // own by more than one. Qdrant here is self-hosted and pinned by
    // docker-compose.qdrant.yml, so that gate only breaks deployments that are
    // working fine. Everything this module calls — the Universal Query API,
    // collection CRUD, upsert/delete — has been stable server-side since 1.10.
    checkCompatibility: false,
  });
  return _client;
}

/** `dharwin-hr__employees` — one collection per Pinecone namespace. */
export function collectionFor(namespace) {
  return `${config.vectorDb.qdrant.collectionPrefix}__${namespace}`;
}

/**
 * Qdrant point ids must be an unsigned int or a UUID, but every caller here uses
 * strings like `employee_<mongoId>`. Hash them into a stable UUIDv5 so the same
 * logical record always lands on the same point — upserts stay idempotent and
 * deletes hit the right row.
 * @param {string} id
 * @returns {string} UUID
 */
export function pointIdFor(id) {
  /* eslint-disable no-bitwise -- RFC 4122 UUID v5 from SHA-1 */
  const h = crypto.createHash('sha1').update(String(id)).digest();
  // RFC 4122 §4.3: stamp version 5 and the IETF variant.
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = h.subarray(0, 16).toString('hex');
  /* eslint-enable no-bitwise */
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Translate a Pinecone metadata filter into a Qdrant filter.
 *
 * Throws on an operator it does not understand rather than dropping the clause:
 * these filters carry tenant scoping (adminId), so a silently-ignored condition
 * would leak another tenant's vectors.
 *
 * @param {Record<string, unknown>|null|undefined} filter
 * @returns {object|undefined} Qdrant filter, or undefined when unfiltered
 */
export function toQdrantFilter(filter) {
  if (!filter || !Object.keys(filter).length) return undefined;
  const must = [];
  for (const [key, cond] of Object.entries(filter)) {
    if (cond === null || typeof cond !== 'object') {
      must.push({ key, match: { value: cond } });
      continue;
    }
    for (const op of Object.keys(cond)) {
      const val = cond[op];
      if (op === '$eq') must.push({ key, match: { value: val } });
      else if (op === '$ne') must.push({ key, match: { except: [val] } });
      else if (op === '$in') must.push({ key, match: { any: val } });
      else if (op === '$nin') must.push({ key, match: { except: val } });
      else throw new Error(`[Qdrant] unsupported filter operator "${op}" on "${key}"`);
    }
  }
  return { must };
}

async function ensureCollection(namespace) {
  const name = collectionFor(namespace);
  if (_ensuredCollections.has(name)) return _ensuredCollections.get(name);
  const promise = (async () => {
    const client = getClient();
    const { collections } = await client.getCollections();
    if (!collections?.some((c) => c.name === name)) {
      logger.info(`[Qdrant] creating collection "${name}" (${VECTOR_SIZE} dims, ${DISTANCE})`);
      await client.createCollection(name, { vectors: { size: VECTOR_SIZE, distance: DISTANCE } });
    }
    // Runs for pre-existing collections too, not just freshly created ones —
    // deployments predating this code have the collection but no index.
    // createPayloadIndex is idempotent, and this whole block is memoised in
    // _ensuredCollections, so it costs one call per namespace per process.
    for (const field of INDEXED_PAYLOAD_FIELDS[namespace] || []) {
      // eslint-disable-next-line no-await-in-loop -- one-time startup path, four fields at most
      await client.createPayloadIndex(name, { field_name: field, field_schema: 'keyword', wait: true });
    }
    return name;
  })().catch((err) => {
    _ensuredCollections.delete(name);
    throw err;
  });
  _ensuredCollections.set(name, promise);
  return promise;
}

/** Namespaces mirrored from Pinecone; created up front so the first query never 404s. */
// `external_jobs` was dropped: every ExternalJob is mirrored into a Job row and
// already embedded in `jobs`, so the namespace held a duplicate nothing queried.
// An existing collection is left in place — delete it by hand once confirmed.
const KNOWN_NAMESPACES = ['students', 'jobs', 'employees', 'attendance', 'kb_chunks'];

/** Parity with pinecone.util#ensureIndex — called once by the embedding sync scheduler. */
export async function ensureIndex() {
  for (const ns of KNOWN_NAMESPACES) {
    // eslint-disable-next-line no-await-in-loop -- one-time startup path; keeps log order readable
    await ensureCollection(ns);
  }
  logger.info(`[Qdrant] ${KNOWN_NAMESPACES.length} collections ready at ${config.vectorDb.qdrant.url}`);
}

const UPSERT_BATCH = Number(process.env.QDRANT_UPSERT_BATCH || 100);

/**
 * @param {string} namespace
 * @param {{ id: string, values: number[], metadata: Record<string, string|boolean> }[]} vectors
 */
export async function upsert(namespace, vectors) {
  if (!vectors?.length) return;
  const valid = vectors.filter((v) => v?.id && Array.isArray(v.values) && v.values.length > 0);
  if (!valid.length) {
    logger.warn(`[Qdrant] upsert ${namespace}: all ${vectors.length} records had no values, skipping`);
    return;
  }
  if (valid.length < vectors.length) {
    logger.warn(`[Qdrant] upsert ${namespace}: skipped ${vectors.length - valid.length} records with missing values`);
  }
  const name = await ensureCollection(namespace);
  const client = getClient();
  let sent = 0;
  for (let i = 0; i < valid.length; i += UPSERT_BATCH) {
    const slice = valid.slice(i, i + UPSERT_BATCH);
    const points = slice.map((v) => ({
      id: pointIdFor(v.id),
      vector: v.values,
      payload: { ...(v.metadata || {}), _vectorId: v.id },
    }));
    // eslint-disable-next-line no-await-in-loop -- sequential batches bound memory, same as the Pinecone path
    await client.upsert(name, { wait: true, points });
    sent += slice.length;
    slice.length = 0;
  }
  logger.info(`[Qdrant] upsert ${namespace}: sent=${sent}`);
}

/**
 * @param {string} namespace
 * @param {number[]} queryEmbedding
 * @param {number} topK
 * @param {Record<string, unknown>} filter must include adminId for multi-tenancy
 * @returns {Promise<Array<{ id: string, score: number, metadata: object }>>}
 *   Shaped like Pinecone's ScoredPineconeRecord so callers need no branching.
 */
export async function query(namespace, queryEmbedding, topK, filter) {
  const name = await ensureCollection(namespace);
  const client = getClient();
  // client.query (the Universal Query API) replaced the removed client.search
  // in @qdrant/js-client-rest v1.13+; it answers with { points: [...] }.
  const res = await client.query(name, {
    query: queryEmbedding,
    limit: topK,
    with_payload: true,
    filter: toQdrantFilter(filter),
  });
  return (res?.points || []).map((p) => {
    const { _vectorId, ...metadata } = p.payload || {};
    return { id: _vectorId || String(p.id), score: p.score, metadata };
  });
}

/**
 * @param {string} namespace
 * @param {string[]} ids original Pinecone-style string ids
 */
export async function remove(namespace, ids) {
  if (!ids?.length) return;
  const name = await ensureCollection(namespace);
  const client = getClient();
  await client.delete(name, { wait: true, points: ids.map(pointIdFor) });
}

export async function healthCheck() {
  try {
    await getClient().getCollections();
    return true;
  } catch (err) {
    logger.warn('[Qdrant] health check failed:', err?.message || String(err));
    return false;
  }
}
