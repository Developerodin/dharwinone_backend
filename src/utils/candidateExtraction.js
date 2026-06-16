/**
 * Parse Bolna's nested `extracted_data` (Category -> Name -> {objective, confidence})
 * into typed candidate-verification fields. Defensive: missing/unknown -> null.
 */

const CATEGORY = 'Candidate Verification';
const FIELD = {
  nameConfirmed: 'Name Confirmed',
  correctedName: 'Corrected Name',
  jobConfirmed: 'Job Confirmed',
  availability: 'Availability',
  currentLocation: 'Current Location',
  stillInterested: 'Still Interested',
  callOutcome: 'Call Outcome',
};
const INTEREST = new Set(['interested', 'not_interested', 'withdrew']);
const OUTCOME = new Set(['fully_confirmed', 'partially_confirmed', 'refused', 'voicemail', 'no_data']);

function readField(extractedData, name) {
  const cat = extractedData && extractedData[CATEGORY];
  const entry = cat && cat[name];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return { value: null, confidence: null };
  return {
    value: entry.objective ?? null,
    confidence: typeof entry.confidence === 'number' ? entry.confidence : null,
  };
}
function toBool(v) {
  if (v === true || v === false) return v;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === 'yes') return true;
    if (s === 'false' || s === 'no') return false;
  }
  return null;
}
function toText(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}
function toEnum(v, allowed) {
  const s = toText(v);
  if (!s) return null;
  const k = s.toLowerCase().replace(/[\s-]+/g, '_');
  return allowed.has(k) ? k : null;
}

export function parseCandidateExtraction(extractedData) {
  const raw = {
    nameConfirmed: readField(extractedData, FIELD.nameConfirmed),
    correctedName: readField(extractedData, FIELD.correctedName),
    jobConfirmed: readField(extractedData, FIELD.jobConfirmed),
    availability: readField(extractedData, FIELD.availability),
    currentLocation: readField(extractedData, FIELD.currentLocation),
    stillInterested: readField(extractedData, FIELD.stillInterested),
    callOutcome: readField(extractedData, FIELD.callOutcome),
  };
  const out = {
    nameConfirmed: toBool(raw.nameConfirmed.value),
    correctedName: toText(raw.correctedName.value),
    jobConfirmed: toBool(raw.jobConfirmed.value),
    availability: toText(raw.availability.value),
    currentLocation: toText(raw.currentLocation.value),
    stillInterested: toEnum(raw.stillInterested.value, INTEREST),
    callOutcome: toEnum(raw.callOutcome.value, OUTCOME),
  };
  const confs = [];
  let present = 0;
  for (const key of Object.keys(FIELD)) {
    if (out[key] != null) {
      present += 1;
      if (raw[key].confidence != null) confs.push(raw[key].confidence);
    }
  }
  out.minConfidence = confs.length ? Math.min(...confs) : null;
  out.fieldsPresent = present;
  return out;
}

const ERROR_MARKERS = [/an error occurred/i, /streamreader/i, /unexpected keyword argument/i];
// Tunable confidence floor: completed-call extractions below this are treated as unreliable.
const MIN_CONFIDENCE = 0.4;

/**
 * Derive a call-quality flag. Pure (no timestamps — caller stamps evaluatedAt).
 * @param {{ status?: string, transcript?: string, verification: object, extractionPresent: boolean }} p
 * @returns {{ status: 'ok'|'needs_review', reasons: string[] }}
 */
export function evaluateCallQuality({ status, transcript, verification, extractionPresent }) {
  const reasons = [];
  const isCompleted = String(status || '').toLowerCase() === 'completed';
  const t = String(transcript || '');

  if (ERROR_MARKERS.some((re) => re.test(t))) reasons.push('runtime_error_in_transcript');

  const userTurns = (t.match(/^\s*user:/gim) || []).length;
  if (isCompleted && userTurns === 0) reasons.push('no_user_turns');

  if (isCompleted && extractionPresent && verification && verification.fieldsPresent === 0) {
    reasons.push('empty_extraction');
  }
  if (
    isCompleted &&
    extractionPresent &&
    verification &&
    verification.minConfidence != null &&
    verification.minConfidence < MIN_CONFIDENCE
  ) {
    reasons.push('low_confidence');
  }

  return { status: reasons.length ? 'needs_review' : 'ok', reasons };
}

/**
 * Combine parse + quality. Pure. Caller stamps extractedAt/evaluatedAt.
 * @param {{ extractedData?: object, transcript?: string, status?: string }} p
 */
export function deriveCallInsights({ extractedData, transcript, status }) {
  const verification = parseCandidateExtraction(extractedData);
  const extractionPresent =
    !!extractedData && typeof extractedData === 'object' && Object.keys(extractedData).length > 0;
  const callQuality = evaluateCallQuality({ status, transcript, verification, extractionPresent });
  return { verification, callQuality };
}
