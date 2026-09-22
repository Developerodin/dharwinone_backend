import OpenAI from 'openai';
import httpStatus from 'http-status';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import { getPdfPageCount } from './documentExtraction.service.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';
import { cleanRaw, guardDateOrder } from '../utils/scanFieldHelpers.util.js';

/**
 * Visa foil extraction — a sibling of eadExtract.service.js, not a branch inside it.
 *
 * The two documents differ in exactly the places that matter, so one shared extractor
 * would need a conditional at every step:
 *   - the EAD prints MM/DD/YY, the visa prints DD MMM YYYY;
 *   - the EAD's decoys are the USCIS# and a form control number, the visa's are the
 *     passport number and its own control number;
 *   - on the EAD the date of birth is printed in a different format from the target
 *     dates, so format alone separates them. On the visa, date of birth, issue date
 *     and expiration date all share DD MMM YYYY, and nothing but the printed label
 *     tells them apart. That is why the prompt anchors hard on labels, and why an
 *     unreadable date stays null rather than borrowing another date nearby.
 *
 * As with the EAD, the model returns raw printed strings only; every judgement happens
 * in the pure functions below, where it can be tested without a network call.
 */

const DEFAULT_MODEL = process.env.VISA_EXTRACT_OPENAI_MODEL || 'gpt-4o';

/** Visa images leaving for OpenAI is an external PII flow. Set VISA_EXTRACT_ENABLED=0 to stop it without a deploy. */
const EXTRACT_ENABLED = process.env.VISA_EXTRACT_ENABLED !== '0';

/** Base64 inflates by about a third, so 8MB in keeps the outbound request near 11MB. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** A visa page, at most a scan of both sides. Anything longer is not a visa. */
const MAX_PDF_PAGES = 2;
const MAX_TOKENS = 512;

function getOpenAIClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Visa scanning requires OPENAI_API_KEY on the server');
  }
  return new OpenAI({ apiKey });
}

const SYSTEM_PROMPT = `You read a visa foil pasted into a passport.
Return ONLY values printed next to these exact labels:
  Visa Number      -> visaNumberRaw
  Issue Date       -> issueDateRaw     (copy exactly as printed, do not reformat)
  Expiration Date  -> expiryDateRaw    (copy exactly as printed, do not reformat)

NEVER return as visaNumberRaw:
  - the Passport No. (a letter followed by digits, e.g. P00000001)
  - the Control No. (a long digit run, e.g. 00000000000001)
  - anything from the two machine-readable lines at the bottom

Date of Birth, Issue Date and Expiration Date are ALL printed in the same
DD MMM YYYY format on this document. Only the printed label tells them apart.
Read down from each label. NEVER return the Date of Birth as either date, and
never substitute one date for another when a label is hard to read.

Keep Issue Date and Expiration Date in printed order; do not swap them.

isVisa is true only if the document reads "VISA".
Any field you cannot read: null. Never guess.`;

const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'visa_foil',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        isVisa: { type: 'boolean' },
        visaNumberRaw: { type: ['string', 'null'] },
        issueDateRaw: { type: ['string', 'null'] },
        expiryDateRaw: { type: ['string', 'null'] },
      },
      required: ['isVisa', 'visaNumberRaw', 'issueDateRaw', 'expiryDateRaw'],
    },
  },
};

/**
 * Passport number: a letter then digits. Printed directly under Given Names on the
 * specimen, one row from the visa number, which is why a careless read returns it.
 */
const PASSPORT_NUMBER = /^[A-Z]\d{6,9}$/;

/** Control number: a long digit run along the bottom of the foil (14 on the specimen). */
const CONTROL_NUMBER = /^\d{12,}$/;

/** US visa foil number: eight digits, printed in red. Verified against the specimen (00000001). */
const EXPECTED_VISA_NUMBER = /^\d{8}$/;

/**
 * @param {unknown} raw
 * @returns {{ value: string|null, needsReview: boolean, warning: string|null }}
 */
export function classifyVisaNumber(raw) {
  const value = cleanRaw(raw);
  if (!value) return { value: null, needsReview: false, warning: null };

  const compact = value.replace(/\s+/g, '').toUpperCase();

  if (PASSPORT_NUMBER.test(compact)) {
    return {
      value: null,
      needsReview: false,
      warning: 'That looks like the passport number, not the visa number. The visa number is printed in red at the top right.',
    };
  }
  if (CONTROL_NUMBER.test(compact)) {
    return {
      value: null,
      needsReview: false,
      warning: 'That looks like the control number along the bottom, not the visa number.',
    };
  }
  if (EXPECTED_VISA_NUMBER.test(compact)) {
    return { value: compact, needsReview: false, warning: null };
  }
  // Only one issuing country's foil has been seen, and layouts differ between them.
  // Refusing an unfamiliar-but-valid number outright would be worse than handing the
  // user a flagged value to confirm.
  return {
    value: compact,
    needsReview: true,
    warning: 'That visa number is not the usual eight digits. Check it before saving.',
  };
}

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6,
  JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12,
};

/**
 * The foil prints DD MMM YYYY with a four-digit year, so there is no century to infer
 * and no numeric month that could be mistaken for a day. The slash format the EAD uses
 * is deliberately NOT accepted: letting it through would mean an EAD date could pass a
 * visa scan unnoticed.
 *
 * @param {unknown} raw
 * @returns {string|null} an ISO YYYY-MM-DD date, or null if it is not a readable visa date
 */
export function parseVisaDate(raw) {
  const value = cleanRaw(raw);
  if (!value) return null;

  const m = value.match(/^(\d{1,2})[\s-]+([A-Za-z]{3})[\s-]+(\d{4})$/);
  if (!m) return null;

  const day = Number(m[1]);
  const month = MONTHS[m[2].toUpperCase()];
  const year = Number(m[3]);
  if (!month || day < 1 || day > 31) return null;

  // Date.UTC silently rolls 31 FEB into early March, so the round trip is what rejects it.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }

  const pad = (n, width) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

const EMPTY_FIELDS = { visaNumber: null, issueDate: null, expiryDate: null };

/**
 * Turn the model's raw reading into the fields the form consumes.
 * @param {{ isVisa?: boolean, visaNumberRaw?: unknown, issueDateRaw?: unknown, expiryDateRaw?: unknown }} parsed
 * @returns {{ fields: typeof EMPTY_FIELDS, needsReview: string[], warnings: string[] }}
 */
export function buildVisaFields(parsed) {
  if (parsed?.isVisa === false) {
    return {
      fields: { ...EMPTY_FIELDS },
      needsReview: [],
      warnings: ['This does not look like a visa. Check that you picked the visa page.'],
    };
  }

  const warnings = [];
  const needsReview = [];

  const number = classifyVisaNumber(parsed?.visaNumberRaw);
  if (number.warning) warnings.push(number.warning);
  if (number.needsReview) needsReview.push('visaNumber');

  let issueDate = parseVisaDate(parsed?.issueDateRaw);
  let expiryDate = parseVisaDate(parsed?.expiryDateRaw);

  // Warn only when the model DID read something that then failed to parse. A null it
  // never read is simply an absent field and needs no noise.
  if (cleanRaw(parsed?.issueDateRaw) && !issueDate) {
    warnings.push('Could not read "Issue Date" as a date. Enter it by hand.');
  }
  if (cleanRaw(parsed?.expiryDateRaw) && !expiryDate) {
    warnings.push('Could not read "Expiration Date" as a date. Enter it by hand.');
  }

  const ordered = guardDateOrder(
    issueDate,
    expiryDate,
    '"Issue Date" falls after "Expiration Date", so both dates were discarded. Enter them by hand.'
  );
  issueDate = ordered.from;
  expiryDate = ordered.to;
  if (ordered.warning) warnings.push(ordered.warning);

  return {
    fields: { visaNumber: number.value, issueDate, expiryDate },
    needsReview,
    warnings,
  };
}

/**
 * Read a visa image (or a short PDF of one) and return the three profile fields.
 * Stateless: reads nothing from the database and writes nothing anywhere.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} filename
 * @returns {Promise<{ fields: typeof EMPTY_FIELDS, needsReview: string[], warnings: string[] }>}
 */
export async function extractVisaFromBuffer(buffer, mimeType, filename) {
  if (!EXTRACT_ENABLED) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'Visa scanning is switched off.');
  }
  if (!buffer?.length) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'file is required (multipart field name: file)');
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'That image is too large. Maximum 8MB.');
  }

  const mime = String(mimeType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  const isPdf = mime === 'application/pdf' || name.endsWith('.pdf');

  if (isPdf) {
    const pages = await getPdfPageCount(buffer);
    if (pages < 1 || pages > MAX_PDF_PAGES) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'Upload the visa page only, at most 2 pages.');
    }
  }

  const b64 = Buffer.from(buffer).toString('base64');
  const filePart = isPdf
    ? {
        type: 'file',
        file: { filename: filename || 'visa.pdf', file_data: `data:application/pdf;base64,${b64}` },
      }
    : {
        // detail:'high' is not optional: the visa number is small red print and the
        // low-detail tiling loses it.
        type: 'image_url',
        image_url: { url: `data:${mime || 'image/jpeg'};base64,${b64}`, detail: 'high' },
      };

  const client = getOpenAIClient();

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [filePart, { type: 'text', text: 'Read this visa.' }] },
      ],
      response_format: RESPONSE_SCHEMA,
      max_tokens: MAX_TOKENS,
      temperature: 0,
    });
  } catch (e) {
    logger.warn('[visaExtract] OpenAI error', { message: e?.message });
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      'Could not read the visa just now. Try again, or type the details in by hand.'
    );
  }

  const parsed = parseJsonWithRepair(
    String(completion.choices?.[0]?.message?.content || ''),
    'visaExtract'
  );
  const result = buildVisaFields(parsed);

  // Booleans only. A visa number must never reach the logs.
  logger.info(
    '[visaExtract] done model=%s isVisa=%s number=%s issue=%s expiry=%s warnings=%s',
    completion.model || DEFAULT_MODEL,
    parsed?.isVisa,
    Boolean(result.fields.visaNumber),
    Boolean(result.fields.issueDate),
    Boolean(result.fields.expiryDate),
    result.warnings.length
  );

  return result;
}
