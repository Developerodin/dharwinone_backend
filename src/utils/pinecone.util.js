// uat.dharwin.backend/src/utils/pinecone.util.js
//
// Vector-store façade. Despite the filename — kept so the existing import sites
// and, critically, the module mocks that reference this exact specifier stay
// valid — this module serves BOTH backends:
//
//   VECTOR_DB=pinecone (default) -> the Pinecone implementation in this file
//   VECTOR_DB=qdrant             -> delegated to ./qdrant.util.js
//
// The five exported functions are the entire contract. Callers never branch on
// the provider, and the Qdrant SDK loads lazily so a Pinecone deployment never
// pulls it in.
//
// Switching providers is an env change plus one embedding-sync run to populate
// the newly selected store; the two stores are not replicated to each other.

import { Pinecone } from '@pinecone-database/pinecone';
import config from '../config/config.js';
import logger from '../config/logger.js';

/**
 * True when this process is configured to talk to Qdrant.
 * Optional-chained with a 'pinecone' fallback so a partially-stubbed config
 * (as in pinecone.util.test.js) still resolves to the Pinecone path.
 */
const useQdrant = () => (config?.vectorDb?.provider ?? 'pinecone') === 'qdrant';

/** Lazy import — @qdrant/js-client-rest is only loaded when actually selected. */
const qdrant = () => import('./qdrant.util.js');

let _client = null;
let _index = null;
let _ensureIndexPromise = null;

function getClient() {
  if (_client) return _client;
  if (!config.pinecone.apiKey) throw new Error('PINECONE_API_KEY not configured');
  _client = new Pinecone({ apiKey: config.pinecone.apiKey });
  return _client;
}

function getIndex() {
  if (_index) return _index;
  const client = getClient();
  _index = client.index(config.pinecone.indexName);
  return _index;
}

// Called once per process on first upsert. Without this, a rotated PINECONE_API_KEY
// pointing at an empty project 404s every live hook silently.
async function ensureIndexOnce() {
  if (_ensureIndexPromise) return _ensureIndexPromise;
  _ensureIndexPromise = ensureIndex().catch((err) => {
    _ensureIndexPromise = null;
    throw err;
  });
  return _ensureIndexPromise;
}

export async function ensureIndex() {
  if (useQdrant()) return (await qdrant()).ensureIndex();
  const client = getClient();
  const indexName = config.pinecone.indexName;
  try {
    const list = await client.listIndexes();
    const exists = list.indexes?.some((i) => i.name === indexName);
    if (!exists) {
      logger.info(`[Pinecone] creating index "${indexName}" (1536 dims, cosine, serverless aws us-east-1)`);
      await client.createIndex({
        name: indexName,
        dimension: 1536,
        metric: 'cosine',
        spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
      });
      // Wait for index to be ready
      let ready = false;
      for (let i = 0; i < 30 && !ready; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const desc = await client.describeIndex(indexName);
        ready = desc.status?.ready === true;
      }
      logger.info(`[Pinecone] index "${indexName}" ready`);
    } else {
      logger.info(`[Pinecone] index "${indexName}" already exists`);
    }
  } catch (err) {
    logger.error('[Pinecone] ensureIndex failed:', err?.message || String(err));
    throw err;
  }
}

// Pinecone caps records-per-upsert; chunk to bound memory + payload size.
// 1536-dim float vector ≈ 6 KB; 100 vecs ≈ 600 KB per HTTP call (safe for 512 MB Render dynos).
const PINECONE_UPSERT_BATCH = Number(process.env.PINECONE_UPSERT_BATCH || 100);

/**
 * @param {string} namespace  'students' | 'jobs' | 'employees' | 'kb_chunks'
 * @param {{ id: string, values: number[], metadata: Record<string,string|boolean> }[]} vectors
 */
export async function pineconeUpsert(namespace, vectors) {
  if (useQdrant()) return (await qdrant()).upsert(namespace, vectors);
  if (!vectors?.length) return;
  const valid = vectors.filter((v) => v?.id && Array.isArray(v.values) && v.values.length > 0);
  if (!valid.length) {
    logger.warn(`[Pinecone] upsert ${namespace}: all ${vectors.length} records had no values, skipping`);
    return;
  }
  if (valid.length < vectors.length) {
    logger.warn(`[Pinecone] upsert ${namespace}: skipped ${vectors.length - valid.length} records with missing values`);
  }
  await ensureIndexOnce();
  const index = getIndex();
  let totalUpserted = 0;
  for (let i = 0; i < valid.length; i += PINECONE_UPSERT_BATCH) {
    const slice = valid.slice(i, i + PINECONE_UPSERT_BATCH);
    // This SDK build's UpsertCommand.validator reads options.records, so wrap in { records }.
    // eslint-disable-next-line no-await-in-loop -- sequential upserts avoid Pinecone rate limits within one namespace
    const result = await index.namespace(namespace).upsert({ records: slice });
    totalUpserted += Number(result?.upsertedCount ?? slice.length);
    // Drop slice ref so the previous batch's vectors can be GCed before the next batch
    slice.length = 0;
  }
  logger.info(`[Pinecone] upsert ${namespace}: sent=${valid.length} upserted=${totalUpserted}`);
}

/**
 * @param {string} namespace
 * @param {number[]} queryEmbedding
 * @param {number} topK
 * @param {Record<string,unknown>} filter  — must include adminId for multi-tenancy
 * @returns {import('@pinecone-database/pinecone').ScoredPineconeRecord[]}
 */
export async function pineconeQuery(namespace, queryEmbedding, topK, filter) {
  if (useQdrant()) return (await qdrant()).query(namespace, queryEmbedding, topK, filter);
  const index = getIndex();
  const queryOptions = {
    vector: queryEmbedding,
    topK,
    includeMetadata: true,
  };
  if (filter && Object.keys(filter).length > 0) queryOptions.filter = filter;
  const result = await index.namespace(namespace).query(queryOptions);
  return result.matches ?? [];
}

/**
 * @param {string} namespace
 * @param {string[]} ids
 */
export async function pineconeDelete(namespace, ids) {
  if (useQdrant()) return (await qdrant()).remove(namespace, ids);
  if (!ids?.length) return;
  const index = getIndex();
  await index.namespace(namespace).deleteMany(ids);
}

export async function pineconeHealthCheck() {
  if (useQdrant()) return (await qdrant()).healthCheck();
  try {
    const index = getIndex();
    await index.describeIndexStats();
    return true;
  } catch (err) {
    logger.warn('[Pinecone] health check failed:', err.message);
    return false;
  }
}
