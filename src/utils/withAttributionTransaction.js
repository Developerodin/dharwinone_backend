import mongoose from 'mongoose';

export function isDuplicateKeyError(err) {
  return Boolean(err && err.code === 11000);
}

export function isTransactionNotSupportedError(err) {
  if (!err) return false;
  if (err.code === 20) return true;
  return String(err.message || '').includes('Transaction numbers are only allowed');
}

/** Cached after first probe; null = unknown, true/false = resolved. */
let transactionsSupported = null;

export function resetAttributionTransactionSupportCache() {
  transactionsSupported = null;
}

async function runWithoutTransaction(fn) {
  return fn(null);
}

export async function withAttributionTransaction(fn) {
  if (transactionsSupported === false) {
    return runWithoutTransaction(fn);
  }

  const session = await mongoose.startSession();
  try {
    const result = await session.withTransaction(
      async () => fn(session),
      {
        readConcern: { level: 'majority' },
        writeConcern: { w: 'majority' },
      }
    );
    transactionsSupported = true;
    return result;
  } catch (err) {
    if (isTransactionNotSupportedError(err)) {
      transactionsSupported = false;
      return runWithoutTransaction(fn);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

export async function withAttributionTransactionRetryOnce(fn) {
  try {
    return await withAttributionTransaction(fn);
  } catch (err) {
    if (!isDuplicateKeyError(err)) throw err;
    try {
      return await withAttributionTransaction(fn);
    } catch (err2) {
      if (isDuplicateKeyError(err2)) {
        const wrapped = new Error('Concurrent assignment race');
        wrapped.statusCode = 409;
        wrapped.code = 'CONCURRENT_ASSIGNMENT_RACE';
        throw wrapped;
      }
      throw err2;
    }
  }
}
