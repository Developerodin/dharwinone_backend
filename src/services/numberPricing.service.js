/**
 * Retail monthly pricing for Buy Number.
 * Resolve order: exact country+type → country+* → *+type → *+* → hard default $9.
 */

import httpStatus from 'http-status';
import NumberPricingConfig from '../models/numberPricingConfig.model.js';
import ApiError from '../utils/ApiError.js';
import logger from '../config/logger.js';

export const DEFAULT_RETAIL_MONTHLY_PRICE = 9;
export const DEFAULT_CURRENCY = 'USD';

let seedPromise = null;

/** Ensure the global default $9 row exists (idempotent). */
export async function ensureDefaultPricing() {
  if (!seedPromise) {
    seedPromise = (async () => {
      try {
        await NumberPricingConfig.findOneAndUpdate(
          { countryIso: '*', numberType: '*' },
          {
            $setOnInsert: {
              countryIso: '*',
              numberType: '*',
              monthlyPriceUsd: DEFAULT_RETAIL_MONTHLY_PRICE,
              currency: DEFAULT_CURRENCY,
              isActive: true,
            },
          },
          { upsert: true, new: true },
        );
      } catch (err) {
        seedPromise = null;
        logger.warn('[NumberPricing] failed to seed default price', { err: err?.message });
        throw err;
      }
    })();
  }
  return seedPromise;
}

function normalizeType(numberType) {
  const t = String(numberType || 'local').toLowerCase().replace(/[\s_-]/g, '');
  if (t === 'tollfree') return 'tollfree';
  if (t === 'mobile') return 'mobile';
  if (t === '*') return '*';
  return 'local';
}

function normalizeCountry(countryIso) {
  const iso = String(countryIso || '*').trim().toUpperCase();
  return iso || '*';
}

/**
 * In-memory resolve against a list of active pricing rows.
 * @param {Array<{ countryIso: string, numberType: string, monthlyPriceUsd: number, currency?: string }>} rows
 */
export function resolveRetailPriceFromRows(rows, { countryIso, numberType } = {}) {
  const country = normalizeCountry(countryIso);
  const type = normalizeType(numberType);
  const byKey = new Map();
  for (const row of rows || []) {
    byKey.set(`${row.countryIso}|${row.numberType}`, row);
  }

  const candidates = [`${country}|${type}`, `${country}|*`, `*|${type}`, `*|*`];

  for (const key of candidates) {
    const row = byKey.get(key);
    if (row && row.monthlyPriceUsd != null) {
      return {
        monthlyPriceUsd: Number(row.monthlyPriceUsd),
        currency: row.currency || DEFAULT_CURRENCY,
        matched: key,
      };
    }
  }

  return {
    monthlyPriceUsd: DEFAULT_RETAIL_MONTHLY_PRICE,
    currency: DEFAULT_CURRENCY,
    matched: 'hard-default',
  };
}

/**
 * @param {{ countryIso?: string, numberType?: string }} params
 * @returns {Promise<{ monthlyPriceUsd: number, currency: string, matched: string }>}
 */
export async function resolveRetailPrice({ countryIso, numberType } = {}) {
  await ensureDefaultPricing();
  const rows = await NumberPricingConfig.find({ isActive: true }).lean();
  return resolveRetailPriceFromRows(rows, { countryIso, numberType });
}

export async function listPricingConfigs({ includeInactive = false } = {}) {
  await ensureDefaultPricing();
  const query = includeInactive ? {} : { isActive: true };
  return NumberPricingConfig.find(query).sort({ countryIso: 1, numberType: 1 }).lean();
}

/**
 * Upsert a pricing row by countryIso + numberType.
 * @param {{ countryIso: string, numberType: string, monthlyPriceUsd: number, currency?: string, isActive?: boolean }} body
 */
export async function upsertPricingConfig(body = {}) {
  const countryIso = normalizeCountry(body.countryIso);
  const numberType = normalizeType(body.numberType);
  if (countryIso !== '*' && !/^[A-Z]{2}$/.test(countryIso)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'countryIso must be * or a 2-letter ISO code');
  }
  if (!['local', 'mobile', 'tollfree', '*'].includes(numberType)) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Invalid numberType');
  }
  if (body.monthlyPriceUsd == null || Number(body.monthlyPriceUsd) < 0) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'monthlyPriceUsd must be a non-negative number');
  }

  const doc = await NumberPricingConfig.findOneAndUpdate(
    { countryIso, numberType },
    {
      $set: {
        monthlyPriceUsd: Number(body.monthlyPriceUsd),
        currency: String(body.currency || DEFAULT_CURRENCY).toUpperCase(),
        isActive: body.isActive !== undefined ? Boolean(body.isActive) : true,
      },
    },
    { upsert: true, new: true, runValidators: true },
  );
  return doc;
}

export async function deletePricingConfig(id) {
  const doc = await NumberPricingConfig.findById(id);
  if (!doc) throw new ApiError(httpStatus.NOT_FOUND, 'Pricing config not found');
  if (doc.countryIso === '*' && doc.numberType === '*') {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Cannot delete the global default pricing row');
  }
  await doc.deleteOne();
  return { deleted: true, id: String(id) };
}

export default {
  DEFAULT_RETAIL_MONTHLY_PRICE,
  DEFAULT_CURRENCY,
  ensureDefaultPricing,
  resolveRetailPrice,
  resolveRetailPriceFromRows,
  listPricingConfigs,
  upsertPricingConfig,
  deletePricingConfig,
};
