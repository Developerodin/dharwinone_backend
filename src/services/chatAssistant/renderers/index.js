// uat.dharwin.backend/src/services/chatAssistant/renderers/index.js
//
// Registry + dispatcher for structured-block renderers. Each per-kind
// renderer takes the matching retrieval payload (or the fact entry) and
// returns either { block, markdown } or null. Callers build a Block[]
// array from `facts` (deterministic numeric truth) + the corresponding
// `fetched` payload (records, breakdowns, page).
//
// Purely additive: existing markdown emit sites in chatAssistant.service.js
// remain untouched. blocks[] is appended to the response envelope alongside
// the existing `reply` markdown string.

import { renderEmployees }    from './employees.js';
import { renderPeople }       from './people.js';
import { renderAttendance }   from './attendance.js';
import { renderGenericCount } from './genericCount.js';
import { renderJobs }         from './jobs.js';
import { buildFallback, isEmptyResult, moduleForKind } from '../fallbackGenerator.js';

// User-intent detector — distinguishes "how many jobs?" (wants a count card)
// from "list all jobs" / "show every employee" (wants the full record set).
// On list intent we suppress count-summary blocks for kinds whose only
// structured renderer is renderGenericCount, so the LLM-streamed markdown
// (which already carries the detailed list) renders through on the frontend
// instead of being clobbered by a "Jobs (45) / Total: 45" card.
const LIST_INTENT_RE = new RegExp(
  [
    '\\b(list|show|display|give|present|tell|enumerate)\\s+(me\\s+)?(all|every|each|complete|full|the)\\b',
    '\\b(complete|full|detailed?|entire)\\s+list\\b',
    '\\blist\\s+(jobs?|candidates?|employees?|offers?|placements?|leaves?|leave\\s+requests?|positions?|openings?|roles?|backdated\\s+\\w+)\\b',
    '\\bshow\\s+(jobs?|candidates?|employees?|offers?|placements?|leaves?|positions?|openings?)\\b',
    '\\bdetails?\\s+of\\s+(all|every|each)\\b',
    '\\bwho\\s+(are|is)\\s+(all|every|the)\\b',
  ].join('|'),
  'i'
);

/**
 * @param {string} msg
 * @returns {boolean}
 */
export function detectListIntent(msg) {
  if (!msg || typeof msg !== 'string') return false;
  return LIST_INTENT_RE.test(msg);
}

// Kinds whose registered renderer is generic-count only (no per-record table).
// On list intent these emit no block so the streamed markdown carries detail.
// `fetch_jobs` is intentionally excluded — its dedicated renderer emits a
// TableBlock when records exist (which paginates on the frontend) and decides
// internally whether to fall back to count card / null based on list intent.
const COUNT_ONLY_KINDS = new Set([
  'fetch_leave_requests',
  'fetch_backdated_attendance_requests',
  'fetch_roles',
  'fetch_placements',
  'fetch_offers',
]);

// Kinds whose render output requires the matching `fetched` payload to be
// present and non-empty (records, perDay rows, etc.). Generic-count kinds
// (jobs/candidates/leave/...) carry their authoritative total on the fact
// itself, so an empty fetched payload is NOT an empty result.
const REQUIRES_PAYLOAD = new Set([
  'fetch_employees',
  'fetch_people',
  'attendance_summary_day',
  'attendance_summary_range',
]);

// fact.kind → key in `fetched` whose data the renderer consumes. Used to
// dedupe (e.g. attendance_summary_day + _range share one source).
const KIND_TO_FETCHED_KEY = {
  fetch_employees:                     'fetch_employees',
  fetch_people:                        'fetch_people',
  attendance_summary_day:              'fetch_attendance_summary',
  attendance_summary_range:            'fetch_attendance_summary',
  fetch_leave_requests:                'fetch_leave_requests',
  fetch_backdated_attendance_requests: 'fetch_backdated_attendance_requests',
  fetch_jobs:                          'fetch_jobs',
  fetch_candidates:                    'fetch_candidates',
  fetch_roles:                         'fetch_roles',
  fetch_placements:                    'fetch_placements',
  fetch_offers:                        'fetch_offers',
};

const KIND_RENDERERS = {
  fetch_employees: (fact, fetched, ctx) =>
    renderEmployees(fetched?.fetch_employees, { role: fact.role, ...ctx }),
  fetch_people: (_fact, fetched, ctx) =>
    renderPeople(fetched?.fetch_people, ctx),
  attendance_summary_day: (_fact, fetched, ctx) =>
    renderAttendance(fetched?.fetch_attendance_summary, ctx),
  attendance_summary_range: (_fact, fetched, ctx) =>
    renderAttendance(fetched?.fetch_attendance_summary, ctx),
  fetch_leave_requests:                (fact, _fetched, ctx) => renderGenericCount(fact, ctx),
  fetch_backdated_attendance_requests: (fact, _fetched, ctx) => renderGenericCount(fact, ctx),
  fetch_jobs:                          (fact, fetched, ctx)  => renderJobs(fetched?.fetch_jobs, ctx, fact),
  // fetch_candidates carries record rows (name/email/phone/status). Render as
  // a TableBlock when records are present so "list them" shows actual people;
  // fall back to count-only group block when no records were fetched.
  fetch_candidates: (fact, fetched, ctx) => {
    const data = fetched?.fetch_candidates;
    const records = Array.isArray(data?.records) ? data.records : [];
    if (records.length) {
      const reshaped = {
        records: records.map((r) => {
          const roleNames = Array.isArray(r.roleNames) && r.roleNames.length
            ? r.roleNames
            : (Array.isArray(r.roleIds) && r.roleIds.length
                ? r.roleIds.map((x) => (typeof x === 'object' ? x.name : x)).filter(Boolean)
                : ['Candidate']);
          return {
            name: r.name,
            email: r.email,
            phone: r.phoneNumber || r.phone,
            roleNames,
            role: roleNames,
            department: r.department || r.designation || null,
            employmentState: r.status || 'active',
          };
        }),
        total: data.total ?? records.length,
        requestedRole: 'Candidate',
      };
      const out = renderEmployees(reshaped, { role: 'Candidate', ...ctx });
      if (out) return out;
    }
    // No records: on list intent suppress the count card so the streamed
    // markdown list (or fallback explanation) shows through. Otherwise
    // keep the count summary for "how many candidates" style questions.
    if (ctx?.listIntent) return null;
    return renderGenericCount(fact, ctx);
  },
  fetch_roles:                         (fact, _fetched, ctx) => renderGenericCount(fact, ctx),
  fetch_placements:                    (fact, _fetched, ctx) => renderGenericCount(fact, ctx),
  fetch_offers:                        (fact, _fetched, ctx) => renderGenericCount(fact, ctx),
};

/**
 * Render a single fact-kind. Returns `{ block, markdown }` (block may be
 * null for empty payloads) or `null` if no renderer is registered.
 *
 * @param {string} kind
 * @param {object} fact
 * @param {object} fetched
 * @param {object} [ctx]
 */
export function renderBlock(kind, fact, fetched, ctx = {}) {
  const fn = KIND_RENDERERS[kind];
  if (!fn) return null;
  try {
    return fn(fact, fetched, ctx) || null;
  } catch {
    return null;
  }
}

/**
 * Build Block[] from extracted facts + matching fetched payload.
 * - Primary fact renders first.
 * - Remaining facts render in registry order, deduped by fetched source key.
 *
 * @param {{ counts: object[], primary: object|null }} facts
 * @param {object} fetched
 * @param {{ queryArg?:string, role?:string }} [ctx]
 * @returns {{ blocks: object[], markdownParts: string[] }}
 */
export function blocksFromFacts(facts, fetched, ctx = {}) {
  /** @type {object[]} */
  const blocks = [];
  /** @type {string[]} */
  const markdownParts = [];
  if (!facts) return { blocks, markdownParts };

  const usedSourceKeys = new Set();
  const order = [];
  if (facts.primary) order.push(facts.primary);
  for (const f of facts.counts || []) {
    if (f && f !== facts.primary) order.push(f);
  }

  const listIntent = detectListIntent(ctx.queryArg);
  const renderCtx = { ...ctx, listIntent };

  for (const fact of order) {
    if (!fact?.kind) continue;
    const sourceKey = KIND_TO_FETCHED_KEY[fact.kind] || fact.kind;
    if (usedSourceKeys.has(sourceKey)) continue;

    // List intent + count-only kind → suppress the count card so the LLM's
    // streamed markdown list renders instead of being overridden by a
    // summary block on the frontend (which gates content on blocks.length).
    if (listIntent && COUNT_ONLY_KINDS.has(fact.kind)) {
      usedSourceKeys.add(sourceKey);
      continue;
    }

    const sourcePayload = fetched ? fetched[sourceKey] : null;

    // Empty / notFound — emit a contextual FallbackBlock instead of a
    // structured block. Markdown twin is also produced so old clients +
    // LLM context get the same explanation. Only applies to kinds whose
    // render needs the fetched payload — generic-count kinds carry their
    // total on the fact and render even with an empty fetched map.
    if (REQUIRES_PAYLOAD.has(fact.kind) && isEmptyResult(sourcePayload)) {
      const fb = buildFallback({
        module: moduleForKind(fact.kind),
        queryArg: ctx.queryArg ?? sourcePayload?.searchedFor ?? null,
        filters: pickFilters(fact, sourcePayload),
        archived: sourcePayload?.archived || null,
        similarMatches: sourcePayload?.similarMatches || null,
      });
      blocks.push(fb.block);
      markdownParts.push(fb.markdown);
      usedSourceKeys.add(sourceKey);
      continue;
    }

    const out = renderBlock(fact.kind, fact, fetched, renderCtx);
    if (!out) continue;
    usedSourceKeys.add(sourceKey);

    if (out.block) blocks.push(out.block);
    if (out.markdown) markdownParts.push(out.markdown);
  }

  return { blocks, markdownParts };
}

/**
 * Surface filter context from the fact + payload so FallbackBlock can
 * explain why the search came back empty.
 * @param {object} fact
 * @param {object|null} payload
 */
function pickFilters(fact, payload) {
  /** @type {{role?:string, department?:string, status?:string}} */
  const out = {};
  if (fact?.role) out.role = fact.role;
  if (payload?.statusFilter) out.status = payload.statusFilter;
  if (payload?.requestedRole && !out.role) out.role = payload.requestedRole;
  if (payload?.department) out.department = payload.department;
  return Object.keys(out).length ? out : null;
}
