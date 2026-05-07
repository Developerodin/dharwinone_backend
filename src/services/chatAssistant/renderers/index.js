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
import { buildFallback, isEmptyResult, moduleForKind } from '../fallbackGenerator.js';

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
  fetch_jobs:                          (fact, _fetched, ctx) => renderGenericCount(fact, ctx),
  fetch_candidates:                    (fact, _fetched, ctx) => renderGenericCount(fact, ctx),
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

  for (const fact of order) {
    if (!fact?.kind) continue;
    const sourceKey = KIND_TO_FETCHED_KEY[fact.kind] || fact.kind;
    if (usedSourceKeys.has(sourceKey)) continue;

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

    const out = renderBlock(fact.kind, fact, fetched, ctx);
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
