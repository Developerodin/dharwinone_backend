import { Pinecone } from '@pinecone-database/pinecone';
import config from '../config/config.js';
import logger from '../config/logger.js';

let _client = null;
let _index = null;

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

export async function ensureIndex() {
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
  if (!vectors?.length) return;
  const valid = vectors.filter((v) => v?.id && Array.isArray(v.values) && v.values.length > 0);
  if (!valid.length) {
    logger.warn(`[Pinecone] upsert ${namespace}: all ${vectors.length} records had no values, skipping`);
    return;
  }
  if (valid.length < vectors.length) {
    logger.warn(`[Pinecone] upsert ${namespace}: skipped ${vectors.length - valid.length} records with missing values`);
  }
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
  if (!ids?.length) return;
  const index = getIndex();
  await index.namespace(namespace).deleteMany(ids);
}

export async function pineconeHealthCheck() {
  try {
    const index = getIndex();
    await index.describeIndexStats();
    return true;
  } catch (err) {
    logger.warn('[Pinecone] health check failed:', err.message);
    return false;
  }
}
