// src/services/chatAssistant/personProfile/fieldProjector.js
//
// Projects a provider's declared FIELDS map over one document for one viewer.
//
// ORDER MATTERS: the permission gate runs BEFORE the value is read. That makes
// `redacted` a function of (viewer permissions x declared FIELDS) alone, so it is
// identical for every person. The reverse order leaks: `redacted:['sevisId']`
// would mean "this person holds a visa", and `redacted:['resignDate']` would
// announce a resignation before HR does — to anyone with `employees.read`.

import { hasApiPermissionFromContext } from '../../../utils/permissionCheck.js';

const MIN_SUMMARY = 2;

function isEmpty(v) {
  if (v === null || v === undefined || v === '') return true;
  return Array.isArray(v) && v.length === 0;
}

function readPath(doc, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), doc);
}

/** The visibility ladder from spec §7. True when the viewer may see the field. */
function isAllowed(decl, ctx) {
  if (decl.tier === 'directory') return true;
  const can = (p) => hasApiPermissionFromContext(ctx.permissions, ctx.platformSuperUser, p);
  if (!decl.requires) return (ctx.ns ? can(`${ctx.ns}.read`) : true) || ctx.isSelf;
  if (can(decl.requires)) return true;
  return ctx.isSelf && decl.orSelf === true;
}

/**
 * @param {object|null} doc            provider document, or null when no record exists
 * @param {object} FIELDS              section -> key -> declaration
 * @param {{permissions:Set<string>, platformSuperUser:boolean, isSelf:boolean, ns:string|null}} ctx
 * @param {Record<string, (doc:object)=>any>} deriveFns
 */
export function projectFields(doc, FIELDS, ctx, deriveFns = {}) {
  const fields = {};
  const availableFields = [];
  const visibleFields = [];
  const missing = [];
  const redacted = [];
  const notApplicable = [];
  const summaryCandidates = [];
  const sectionOf = new Map();

  for (const [section, keys] of Object.entries(FIELDS)) {
    for (const [key, decl] of Object.entries(keys)) {
      availableFields.push(key);
      sectionOf.set(key, section);

      if (!isAllowed(decl, ctx)) { redacted.push(key); continue; }

      let value;
      if (decl.derive) {
        const fn = deriveFns[decl.derive];
        value = fn ? fn(doc) : undefined;
        if (isEmpty(value) && !decl.total) { missing.push(key); continue; }
      } else {
        value = doc ? readPath(doc, decl.path) : undefined;
        if (isEmpty(value)) { missing.push(key); continue; }
      }

      fields[key] = value;
      visibleFields.push(key);
      if (decl.summary) summaryCandidates.push(key);
    }
  }

  // Backfill so a brief answer is never composed entirely of negatives.
  const summaryFields = [...summaryCandidates];
  for (const key of visibleFields) {
    if (summaryFields.length >= MIN_SUMMARY) break;
    if (!summaryFields.includes(key)) summaryFields.push(key);
  }

  // Deliverable sections only — offering a section then refusing it is worse
  // than never offering it.
  const sections = [...new Set(visibleFields.map((k) => sectionOf.get(k)))];

  return { fields, availableFields, visibleFields, missing, redacted, notApplicable,
           summaryFields, sections };
}
