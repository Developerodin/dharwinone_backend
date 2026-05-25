import mongoose from 'mongoose';

export function isDuplicateKeyError(err) {
  return Boolean(err && err.code === 11000);
}

export async function withAttributionTransaction(fn) {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => fn(session), {
      readConcern: { level: 'majority' },
      writeConcern: { w: 'majority' },
    });
  } finally {
    session.endSession();
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
