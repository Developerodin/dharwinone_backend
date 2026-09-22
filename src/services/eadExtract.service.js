import OpenAI from 'openai';
import httpStatus from 'http-status';
import config from '../config/config.js';
import logger from '../config/logger.js';
import ApiError from '../utils/ApiError.js';
import { getPdfPageCount } from './documentExtraction.service.js';
import { parseJsonWithRepair } from './moduleOpenAI.service.js';

/**
 * EAD (Form I-766) card extraction.
 *
 * Deliberately a sibling of resumeSkillsExtract.service.js rather than an extension of it:
 * that service's prompts, JSON schema and MIME gates are all built for resumes and are wrong
 * for an ID card in every one of those three respects.
 *
 * The model is asked for RAW PRINTED STRINGS only. Every judgement -- what is a card number,
 * what is a date, whether the pair is coherent -- happens in the pure functions below, where
 * it can be tested without a network call.
 */

/**
 * gpt-4o rather than the gpt-4o-mini the resume path uses. This is provisional and unmeasured:
 * an EAD carries a holographic overlay, diagonal security print and a ghost photo over the
 * text, so the small print is genuinely hard to read. Compare the two against a real card and
 * drop to mini if they turn out to be at parity -- mini is substantially cheaper.
 */
const DEFAULT_MODEL = process.env.EAD_EXTRACT_OPENAI_MODEL || 'gpt-4o';

/** Card images leaving for OpenAI is a new external PII flow. Set EAD_EXTRACT_ENABLED=0 to stop it without a deploy. */
const EXTRACT_ENABLED = process.env.EAD_EXTRACT_ENABLED !== '0';

/** Base64 inflates by about a third, so 8MB in keeps the outbound request near 11MB. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** Front and back at most. Anything longer is not a card. */
const MAX_PDF_PAGES = 2;
/** Four short strings come back; this is generous for them. */
const MAX_TOKENS = 512;

function getOpenAIClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'EAD card scanning requires OPENAI_API_KEY on the server');
  }
  return new OpenAI({ apiKey });
}

/**
 * Anchored on the printed labels, with the specimen's three numeric decoys named outright.
 * On a real card USCIS#, Category and Card# are printed side by side on ONE line, so an
 * unprompted left-to-right read returns the A-Number every time.
 */
const SYSTEM_PROMPT = `You read a US Form I-766 Employment Authorization Document.
Return ONLY values printed next to these exact labels:
  Card#         -> cardNumberRaw
  Valid From    -> validFromRaw     (copy exactly as printed, do not reformat)
  Card Expires  -> expiresOnRaw     (copy exactly as printed, do not reformat)

USCIS#, Category and Card# are printed side by side on ONE line.
Read down from each label, never left to right across that line.

NEVER return as cardNumberRaw:
  - the USCIS# / A-Number (nine digits, often dashed, e.g. 000-000-701)
  - the Category (e.g. C09)
  - the control number beside "FORM I-766" (e.g. 99134258)
NEVER return as a date:
  - Date of Birth (printed as DD MMM YYYY, e.g. 01 JAN 1920)

Valid From and Card Expires are adjacent and share a format. Keep them in
printed order; do not swap them.

isEadCard is true only if the card reads "EMPLOYMENT AUTHORIZATION" or "FORM I-766".
Any field you cannot read: null. Never guess.`;

const RESPONSE_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'ead_card',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        isEadCard: { type: 'boolean' },
        cardNumberRaw: { type: ['string', 'null'] },
        validFromRaw: { type: ['string', 'null'] },
        expiresOnRaw: { type: ['string', 'null'] },
      },
      required: ['isEadCard', 'cardNumberRaw', 'validFromRaw', 'expiresOnRaw'],
    },
  },
};

/** Values a vision model returns when it means "nothing here". Treated as absence, not content. */
const SENTINELS = new Set([
  '', '-', '--', 'n/a', 'na', 'none', 'null', 'undefined',
  'unknown', 'not visible', 'not readable', 'illegible',
]);

/**
 * @param {unknown} raw
 * @returns {string|null} the trimmed string, or null if it is empty or a sentinel
 */
export function cleanRaw(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  return SENTINELS.has(s.toLowerCase()) ? null : s;
}

/**
 * USCIS# / A-Number: nine digits, optionally dashed 3-3-3. Verified against the public I-766
 * specimen (000-000-701). On the card this sits two columns LEFT of Card# on the same line,
 * which is precisely why a careless read returns it instead. Storing it as a card number is
 * the single failure this feature exists to prevent, so it is dropped rather than flagged.
 */
const A_NUMBER = /^\d{9}$|^\d{3}-\d{3}-\d{3}$/;

/** I-766 Card#: three letters then ten digits. Verified against the specimen (SRC0000000701). */
const EXPECTED_CARD = /^[A-Z]{3}\d{10}$/;

/**
 * @param {unknown} raw
 * @returns {{ value: string|null, needsReview: boolean, warning: string|null }}
 */
export function classifyCardNumber(raw) {
  const value = cleanRaw(raw);
  if (!value) return { value: null, needsReview: false, warning: null };

  const compact = value.replace(/\s+/g, '').toUpperCase();

  if (A_NUMBER.test(compact)) {
    return {
      value: null,
      needsReview: false,
      warning: 'That looks like a USCIS# (A-Number), not a Card#. The Card# is the rightmost of the three values on that line.',
    };
  }
  if (EXPECTED_CARD.test(compact)) {
    return { value: compact, needsReview: false, warning: null };
  }
  // Card formats vary by card revision, and only one revision has been seen. Rejecting an
  // unfamiliar-but-valid number outright would be worse than handing the user a flagged value
  // to confirm, so this branch keeps it.
  return {
    value: compact,
    needsReview: true,
    warning: 'That card number is not the usual three letters followed by ten digits. Check it before saving.',
  };
}

/**
 * The I-766 prints MM/DD/YY. Only that order is read -- the card is always a US document, so
 * there is no locale to infer and nothing to guess. A two-digit year uses a fixed pivot rather
 * than one relative to today, so the same input parses to the same date whenever it is run.
 */
const YEAR_PIVOT = 79;

/**
 * @param {unknown} raw
 * @returns {string|null} an ISO YYYY-MM-DD date, or null if it is not a readable card date
 */
export function parseCardDate(raw) {
  const value = cleanRaw(raw);
  if (!value) return null;

  const m = value.match(/^(\d{1,2})\s*\/\s*(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (!m) return null;

  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (m[3].length === 2) year = year <= YEAR_PIVOT ? 2000 + year : 1900 + year;

  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Date.UTC silently rolls 02/31 into 03/03, so the round trip is what actually rejects it.
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }

  const pad = (n, width) => String(n).padStart(width, '0');
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

const EMPTY_FIELDS = { cardNumber: null, validFrom: null, validTo: null };

/**
 * Turn the model's raw reading into the fields the form consumes.
 * @param {{ isEadCard?: boolean, cardNumberRaw?: unknown, validFromRaw?: unknown, expiresOnRaw?: unknown }} parsed
 * @returns {{ fields: typeof EMPTY_FIELDS, needsReview: string[], warnings: string[] }}
 */
export function buildEadFields(parsed) {
  if (parsed?.isEadCard === false) {
    return {
      fields: { ...EMPTY_FIELDS },
      needsReview: [],
      warnings: ['This does not look like an EAD card. Check that you picked the front of the card.'],
    };
  }

  const warnings = [];
  const needsReview = [];

  const card = classifyCardNumber(parsed?.cardNumberRaw);
  if (card.warning) warnings.push(card.warning);
  if (card.needsReview) needsReview.push('cardNumber');

  let validFrom = parseCardDate(parsed?.validFromRaw);
  let validTo = parseCardDate(parsed?.expiresOnRaw);

  // Warn only when the model DID read something that then failed to parse. A null it never
  // read is simply an absent field and needs no noise.
  if (cleanRaw(parsed?.validFromRaw) && !validFrom) {
    warnings.push('Could not read "Valid From" as a date. Enter it by hand.');
  }
  if (cleanRaw(parsed?.expiresOnRaw) && !validTo) {
    warnings.push('Could not read "Card Expires" as a date. Enter it by hand.');
  }

  // ISO YYYY-MM-DD compares correctly as a string, so no Date objects are needed here.
  if (validFrom && validTo && validFrom > validTo) {
    // Never swap. A swap turns a misread into a record that looks entirely plausible.
    warnings.push('"Valid From" falls after "Card Expires", so both dates were discarded. Enter them by hand.');
    validFrom = null;
    validTo = null;
  }

  return {
    fields: { cardNumber: card.value, validFrom, validTo },
    needsReview,
    warnings,
  };
}

/**
 * Read an EAD card image (or a short PDF of one) and return the three profile fields.
 * Stateless: reads nothing from the database and writes nothing anywhere.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @param {string} filename
 * @returns {Promise<{ fields: { cardNumber: string|null, validFrom: string|null, validTo: string|null }, needsReview: string[], warnings: string[] }>}
 */
export async function extractEadCardFromBuffer(buffer, mimeType, filename) {
  if (!EXTRACT_ENABLED) {
    throw new ApiError(httpStatus.SERVICE_UNAVAILABLE, 'EAD card scanning is switched off.');
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
      throw new ApiError(httpStatus.BAD_REQUEST, 'Upload the card only, at most 2 pages.');
    }
  }

  const b64 = Buffer.from(buffer).toString('base64');
  const filePart = isPdf
    ? {
        type: 'file',
        file: { filename: filename || 'ead.pdf', file_data: `data:application/pdf;base64,${b64}` },
      }
    : {
        type: 'image_url',
        // detail:'high' is not optional here -- the card numbers are small print under a
        // holographic overlay, and the low-detail tiling loses them.
        image_url: { url: `data:${mime || 'image/jpeg'};base64,${b64}`, detail: 'high' },
      };

  const client = getOpenAIClient();

  let completion;
  try {
    completion = await client.chat.completions.create({
      model: DEFAULT_MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [filePart, { type: 'text', text: 'Read this EAD card.' }] },
      ],
      response_format: RESPONSE_SCHEMA,
      max_tokens: MAX_TOKENS,
      temperature: 0,
    });
  } catch (e) {
    logger.warn('[eadExtract] OpenAI error', { message: e?.message });
    throw new ApiError(
      httpStatus.BAD_GATEWAY,
      'Could not read the card just now. Try again, or type the details in by hand.'
    );
  }

  const parsed = parseJsonWithRepair(
    String(completion.choices?.[0]?.message?.content || ''),
    'eadExtract'
  );
  const result = buildEadFields(parsed);

  // Booleans only. A card number must never reach the logs.
  logger.info(
    '[eadExtract] done model=%s isEadCard=%s card=%s from=%s to=%s warnings=%s',
    completion.model || DEFAULT_MODEL,
    parsed?.isEadCard,
    Boolean(result.fields.cardNumber),
    Boolean(result.fields.validFrom),
    Boolean(result.fields.validTo),
    result.warnings.length
  );

  return result;
}
