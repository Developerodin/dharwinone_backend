import OpenAI from 'openai';
import config from '../../../../../config/config.js';
import { sanitizeCallRecord } from '../../../../../utils/callRecordAccess.util.js';
import { fieldAccess, istDay } from './common.js';

// defineTool rejects timeoutMs above 15000 (kept under the 20000ms model step).
// The wave asked for 20000; a request that long would be aborted by the registry
// first, so the OpenAI call is cut inside the tool budget.
export const EXTRACT_REQUEST_MS = 14000;
const MAX_TRANSCRIPT_CHARS = 12000;
const MAX_QUOTE_CHARS = 400;
const MAX_LIST_ITEMS = 8;
const MIN_QUOTE_CHARS = 3;
const OBJECT_ID_RE = /^[a-fA-F0-9]{24}$/;

const SCALAR_KEYS = ['expectedSalary', 'noticePeriod', 'joiningDate', 'callbackRequest', 'whyDeclined', 'visa'];
const LIST_KEYS = ['questions', 'concerns', 'otherOffers', 'followUps'];

const AGENT_ROLES = new Set(['agent', 'assistant', 'bot', 'system', 'ai']);
const PERSON_ROLES = new Set(['user', 'candidate', 'callee', 'human', 'customer', 'recipient']);

const LINE_TS = /^(?:\[(\d{1,2}:\d{2}(?::\d{2})?)\]|\((\d{1,2}:\d{2}(?::\d{2})?)\)|(\d{1,2}:\d{2}(?::\d{2})?))(?=\s|$)/;

export const ATTRIBUTION =
  'Each takeaway is a quote from the transcript. Use the statement ("the candidate said" or "the agent said"). These are not verified facts.';

export const TRANSCRIPT_READING =
  'Answer what was said only from `transcript`. basis "explicit" means that quote is in the transcript. ' +
  'A null basis means the extractor returned null — read `transcript` before answering. That is not "absent". ' +
  'If the words are in `transcript`, quote them and say explicit. If you go beyond those words, say inferred. ' +
  'Say absent only after you checked and the words are not in `transcript`. Never say the transcript did not ' +
  'capture something when transcriptAvailable is true unless you checked. Never say the transcript is missing ' +
  'when transcriptAvailable is true. basis "no_transcript" means no transcript was loaded. Never invent a quote.';

const TRANSCRIPT_ABSENT =
  'The transcript is absent for this call. Do not invent what was said.';

function basisOf(takeaways, transcriptAvailable) {
  const basis = {};
  for (const key of [...SCALAR_KEYS, ...LIST_KEYS]) {
    if (!transcriptAvailable) basis[key] = 'no_transcript';
    else basis[key] = takeaways?.[key] ? 'explicit' : null;
  }
  return basis;
}

const SYSTEM = [
  'You extract takeaways from one phone-call transcript. Reply with one JSON object and nothing else.',
  'Keys: expectedSalary, noticePeriod, joiningDate, questions, concerns, otherOffers, callbackRequest, whyDeclined, visa, followUps.',
  'A scalar is null or {"quote":"...","timestamp":null}. A list is an array of those objects, or [].',
  'quote must be copied verbatim from the transcript. If it was not said, use null or []. Do not infer or paraphrase.',
  'timestamp is the time mark on the same line as the quote, or null. Never invent a timestamp.',
  'expectedSalary = pay they said they want. noticePeriod = notice they said. joiningDate = a join date they said.',
  'questions = questions asked. concerns = worries they stated. otherOffers = other job offers they said they have.',
  'callbackRequest = they asked to be called again. whyDeclined = why they said they are declining or not interested.',
  'visa = a visa they mentioned. followUps = other next steps they asked for, not a repeat of the callback quote.',
].join(' ');

export function blankTakeaways() {
  return {
    expectedSalary: null,
    noticePeriod: null,
    joiningDate: null,
    questions: null,
    concerns: null,
    otherOffers: null,
    callbackRequest: null,
    whyDeclined: null,
    visa: null,
    followUps: null,
  };
}

/** Call Transcripts / Call AI toggles. Null when both are on. */
export function toggleRefusal(access) {
  if (access?.canViewTranscripts && access?.canViewAi) return null;
  const missingToggles = [];
  const parts = [];
  if (!access?.canViewTranscripts) {
    missingToggles.push('Call Transcripts');
    parts.push('You cannot see call transcripts. The Call Transcripts toggle is off for your role.');
  }
  if (!access?.canViewAi) {
    missingToggles.push('Call AI');
    parts.push('The Call AI toggle is off for your role.');
  }
  return { refused: true, error: parts.join(' '), missingToggles };
}

function formatStartMs(ms) {
  const s = Math.max(0, Math.floor(Number(ms) / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function timestampOfTurn(turn) {
  if (turn == null || typeof turn !== 'object') return null;
  if (turn.timestamp != null && String(turn.timestamp).trim()) return String(turn.timestamp).trim();
  if (turn.time != null && String(turn.time).trim()) return String(turn.time).trim();
  if (turn.start != null && String(turn.start).trim()) return String(turn.start).trim();
  if (Number.isFinite(Number(turn.startMs))) return formatStartMs(turn.startMs);
  return null;
}

function renderTurn(turn) {
  if (typeof turn === 'string') return turn.trim();
  if (!turn || typeof turn !== 'object') return '';
  const text = turn.text ?? turn.content ?? turn.message ?? turn.transcript ?? '';
  const spoken = String(text ?? '').trim();
  if (!spoken) return '';
  const ts = timestampOfTurn(turn);
  const who = turn.role ?? turn.speaker ?? turn.speakerName ?? turn.name ?? '';
  const prefix = [ts ? `[${ts}]` : '', who].filter(Boolean).join(' ');
  return prefix ? `${prefix}: ${spoken}` : spoken;
}

/** String, turn array, or { messages } → one transcript the quote check can search. */
export function renderTranscript(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(renderTurn).filter(Boolean).join('\n');
  if (typeof value === 'object') {
    if (Array.isArray(value.messages)) return renderTranscript(value.messages);
    if (value.text) return String(value.text).trim();
  }
  return '';
}

function timestampOn(line) {
  const m = LINE_TS.exec(String(line ?? '').trimStart());
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
}

function speakerOn(line, fallback) {
  const rest = String(line ?? '').trimStart().replace(LINE_TS, '').trim();
  const m = /^([A-Za-z][A-Za-z .'_-]{0,40}):\s/.exec(rest);
  if (!m) return fallback;
  const role = m[1].trim().toLowerCase();
  if (AGENT_ROLES.has(role)) return 'the agent';
  if (PERSON_ROLES.has(role)) return fallback;
  return fallback;
}

function collapsedMap(hay) {
  const map = [];
  let out = '';
  let started = false;
  for (let i = 0; i < hay.length; i += 1) {
    const ch = hay[i];
    if (/\s/.test(ch)) {
      if (started && !out.endsWith(' ')) {
        out += ' ';
        map.push(i);
      }
      continue;
    }
    started = true;
    out += ch.toLowerCase();
    map.push(i);
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    map.pop();
  }
  return { out, map };
}

/** Verbatim slice of `hay` matching `needle`, or null. Whitespace and case may differ. */
function originalSlice(hay, needle) {
  const q = String(needle ?? '').trim();
  if (q.length < MIN_QUOTE_CHARS || !hay) return null;
  const exact = hay.indexOf(q);
  if (exact >= 0) return hay.slice(exact, exact + q.length);
  const at = hay.toLowerCase().indexOf(q.toLowerCase());
  if (at >= 0) return hay.slice(at, at + q.length);
  const collapsedNeedle = q.replace(/\s+/g, ' ').trim().toLowerCase();
  if (collapsedNeedle.length < MIN_QUOTE_CHARS) return null;
  const { out, map } = collapsedMap(hay);
  const pos = out.indexOf(collapsedNeedle);
  if (pos < 0) return null;
  const from = map[pos];
  const to = map[pos + collapsedNeedle.length - 1] + 1;
  return hay.slice(from, to);
}

function capQuote(slice) {
  return slice.length > MAX_QUOTE_CHARS ? slice.slice(0, MAX_QUOTE_CHARS) : slice;
}

/**
 * A quote that is not a substring of the transcript is dropped.
 * The timestamp is the one printed on that line. The model's timestamp is ignored.
 */
export function locateQuote(transcript, quote, fallback) {
  const text = String(transcript ?? '');
  const needle = String(quote ?? '').trim();
  if (!text || needle.length < MIN_QUOTE_CHARS) return null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const slice = originalSlice(line, needle);
    if (!slice) continue;
    return { quote: capQuote(slice), timestamp: timestampOn(line), who: speakerOn(line, fallback) };
  }
  const slice = originalSlice(text, needle);
  if (!slice) return null;
  const idx = text.toLowerCase().indexOf(slice.toLowerCase());
  const lineNo = text.slice(0, Math.max(0, idx)).split(/\r?\n/).length - 1;
  const line = lines[lineNo] || '';
  return { quote: capQuote(slice), timestamp: timestampOn(line), who: speakerOn(line, fallback) };
}

function statementFor(found, day) {
  const when = day || 'an unknown date';
  const end = /[.!?]$/.test(found.quote) ? '' : '.';
  return `On ${when} ${found.who} said "${found.quote}"${end}`;
}

function groundOne(raw, transcript, day, fallback) {
  const quote = typeof raw === 'string' ? raw : raw?.quote;
  const found = locateQuote(transcript, quote, fallback);
  if (!found) return null;
  return { quote: found.quote, timestamp: found.timestamp, statement: statementFor(found, day) };
}

function groundList(raw, transcript, day, fallback) {
  const items = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const grounded = groundOne(item, transcript, day, fallback);
    if (!grounded) continue;
    const key = grounded.quote.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(grounded);
    if (out.length >= MAX_LIST_ITEMS) break;
  }
  return out.length ? out : null;
}

/** Drop anything the model did not quote from this transcript. Missing items stay null. */
export function groundTakeaways(raw, transcript, { day, fallback }) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = blankTakeaways();
  for (const key of SCALAR_KEYS) out[key] = groundOne(src[key], transcript, day, fallback);
  for (const key of LIST_KEYS) out[key] = groundList(src[key], transcript, day, fallback);
  return out;
}

export function speakerFallback(record) {
  const candidate = record?.candidate || /application/i.test(record?.purpose || '');
  return candidate ? 'the candidate' : 'the person called';
}

function personMatch(person) {
  const q = String(person ?? '').trim();
  if (OBJECT_ID_RE.test(q)) return { candidateId: q };
  if (q.length < 2) throw new Error('A name or phone needs at least 2 characters.');
  return { search: q };
}

function isNameToken(q) {
  return /^[A-Za-z][A-Za-z.'-]{1,99}$/.test(q);
}

function isPersonQuery(q) {
  if (/\s/.test(q)) return true;
  if (OBJECT_ID_RE.test(q)) return true;
  return /^\+?\d[\d\s()-]{6,}$/.test(q);
}

async function viewerOf(user, deps) {
  return { userId: String(user?.id ?? user?._id ?? ''), isAdmin: await deps.userIsAdmin(user) };
}

async function gateCall(executionId, viewer, deps) {
  const scope = await deps.getCallRecordScopeFields(executionId);
  if (!scope) return { missing: true };
  if (!(await deps.userCanAccessCallRecord(scope, viewer))) return { forbidden: true };
  return { ok: true };
}

const FORBIDDEN = Object.freeze({ forbidden: true, error: 'You do not have access to this call.' });

async function latestForPerson(q, viewer, deps) {
  const data = await deps.listCallRecords({
    ...personMatch(q),
    sortBy: 'createdAt',
    order: 'desc',
    page: 1,
    limit: 1,
    ...viewer,
  });
  const row = data?.results?.[0];
  if (!row?.executionId) return { notFound: true, searchedFor: q };
  const gate = await gateCall(String(row.executionId), viewer, deps);
  if (gate.forbidden) return FORBIDDEN;
  if (!gate.ok) return { notFound: true, searchedFor: q };
  return {
    executionId: String(row.executionId),
    person: row.displayName ?? row.businessName ?? null,
  };
}

async function resolveCall(q, viewer, deps) {
  if (isPersonQuery(q)) return latestForPerson(q, viewer, deps);
  const gate = await gateCall(q, viewer, deps);
  if (gate.ok) return { executionId: q, person: null };
  if (gate.forbidden) return FORBIDDEN;
  if (isNameToken(q)) return latestForPerson(q, viewer, deps);
  return { notFound: true, id: q };
}

function parseModelJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

async function requestTakeaways(client, transcript) {
  const res = await client.chat.completions.create({
    model: config.ai.extractionModel,
    temperature: 0,
    response_format: { type: 'json_object' },
    max_tokens: 1500,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: `Transcript:\n${transcript}` },
    ],
  }, { timeout: EXTRACT_REQUEST_MS, maxRetries: 0 });
  return parseModelJson(res?.choices?.[0]?.message?.content);
}

function openaiClient() {
  const apiKey = config.openai?.apiKey;
  if (!apiKey) return null;
  return new OpenAI({ apiKey, timeout: EXTRACT_REQUEST_MS, maxRetries: 0 });
}

/**
 * The transcript get_call_takeaways grounded against, without the extraction model.
 * Same access gate and renderTranscript as that tool. No write.
 * A missing or unreadable call returns null. Callers treat that as no transcript
 * for the quote check; they do not keep an unverified quote.
 */
export async function loadCallTranscript({ callId, user, deps }) {
  const q = String(callId ?? '').trim();
  if (!q) return null;
  const viewer = await viewerOf(user, deps);
  const gate = await gateCall(q, viewer, deps);
  if (!gate.ok) return null;
  if (toggleRefusal(fieldAccess(user))) {
    return { transcriptAvailable: false, transcript: '', transcriptState: 'no_transcript' };
  }
  const raw = await deps.CallRecord.findOne({ executionId: q }).lean();
  if (!raw) return null;
  const record = sanitizeCallRecord(raw, fieldAccess(user));
  const rendered = renderTranscript(record.transcript || record.conversationTranscript);
  if (!rendered) {
    return { transcriptAvailable: false, transcript: '', transcriptState: 'no_transcript' };
  }
  const transcript = rendered.length > MAX_TRANSCRIPT_CHARS ? rendered.slice(0, MAX_TRANSCRIPT_CHARS) : rendered;
  return { transcriptAvailable: true, transcript };
}

/**
 * One call's transcript takeaways. No write.
 * ponytail: every ask re-runs the extraction. The upgrade is storing the grounded
 * takeaways on CallRecord so a repeat question reads them instead of calling the model.
 */
export async function runCallTakeaways({ call, user, deps }) {
  const q = String(call ?? '').trim();
  if (!q) throw new Error('Give a call id or the person\'s name.');

  const viewer = await viewerOf(user, deps);
  const resolved = await resolveCall(q, viewer, deps);
  if (resolved.notFound || resolved.forbidden) return resolved;

  const refusal = toggleRefusal(fieldAccess(user));
  if (refusal) return refusal;

  const raw = await deps.CallRecord.findOne({ executionId: resolved.executionId }).lean();
  if (!raw) return { notFound: true, id: resolved.executionId };

  const access = fieldAccess(user);
  const record = sanitizeCallRecord(raw, access);
  const rendered = renderTranscript(record.transcript || record.conversationTranscript);
  const callRow = {
    id: resolved.executionId,
    when: record.createdAt ?? null,
    person: resolved.person ?? record.businessName ?? record.displayName ?? null,
  };
  if (!rendered) {
    return {
      call: callRow,
      takeaways: blankTakeaways(),
      transcriptAvailable: false,
      transcriptMissing: true,
      transcriptState: 'no_transcript',
      basis: basisOf(blankTakeaways(), false),
      reading: TRANSCRIPT_ABSENT,
    };
  }

  const truncated = rendered.length > MAX_TRANSCRIPT_CHARS;
  const transcript = truncated ? rendered.slice(0, MAX_TRANSCRIPT_CHARS) : rendered;
  const loaded = {
    transcriptAvailable: true,
    transcript,
    reading: TRANSCRIPT_READING,
    ...(truncated ? { transcriptTruncated: true } : {}),
  };
  const client = deps.openai ?? openaiClient();
  if (!client) {
    return { call: callRow, error: 'Call takeaways need the AI service, and it is not configured.', ...loaded };
  }

  let parsed;
  try {
    parsed = await requestTakeaways(client, transcript);
  } catch {
    return { call: callRow, error: 'Could not read takeaways from this call right now.', ...loaded };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { call: callRow, error: 'Could not read takeaways from this call right now.', ...loaded };
  }

  const takeaways = groundTakeaways(parsed, transcript, {
    day: istDay(record.completedAt || record.createdAt),
    fallback: speakerFallback(record),
  });
  return {
    call: callRow,
    takeaways,
    basis: basisOf(takeaways, true),
    attribution: ATTRIBUTION,
    ...loaded,
  };
}
