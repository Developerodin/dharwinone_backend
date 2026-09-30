import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { MAX_LIST_LIMIT, hiringScope, placementQueryFilter } from './common.js';
import { placementFilters } from './filters.js';
import {
  DOCUMENTS_ACCESS, SCAN_CAP, DOCUMENT_FIELDS, NOT_CAPTURED, detailDeps, idOf, canViewOthersDocuments, ownsProfile,
  resolveProfile, loadDocumentProfiles, documentDetail, documentSummary, documentActorIds, userNames,
} from './placementDetail.js';

const ONLY_WITH = ['pending_review', 'rejected', 'missing', 'expiring'];
const OTHERS_DENIED =
  'You can only see your own documents (someone else\'s need candidates.manage, employees.manage or a ' +
  'pre-boarding permission).';
const UPLOADER_NOTE =
  `Uploader is only recorded for resume and cover-letter versions; for other documents it is ${NOT_CAPTURED}.`;

const keepFor = (onlyWith) => (s) => {
  if (onlyWith === 'pending_review') return s.counts.pendingReview > 0;
  if (onlyWith === 'rejected') return s.counts.rejected > 0;
  if (onlyWith === 'missing') return s.counts.missing > 0;
  if (onlyWith === 'expiring') return s.expiries.some((e) => e.expiringSoon);
  return true;
};

async function personView(emp, candidateUserId, withinDays, deps) {
  const names = await userNames(documentActorIds(emp), deps);
  return {
    ...documentDetail(emp, { names, candidateUserId, now: deps.now(), withinDays }),
    uploaderNote: UPLOADER_NOTE,
  };
}

export default defineTool({
  name: 'list_documents',
  domain: 'hiring',
  kind: 'read',
  description:
    'Candidate / employee documents. For one person (person): every uploaded document with its review status ' +
    '(pending review / approved / rejected, by whom, rejection reason), who uploaded it where recorded, ' +
    'documents requested but still missing, and EAD / visa expiry. For a group (cohort = placement filters, ' +
    'e.g. { stage: "preBoarding" } or { joiningBetween }): per-person counts, with onlyWith to keep only people ' +
    'with documents pending review, rejected, missing, or expiring within expiringWithinDays. No person and no ' +
    'cohort = your own documents. "Required" means documents staff requested from the person.',
  measure:
    'Documents on candidate / employee profiles. Cohort mode counts PEOPLE (one per placement\'s candidate, ' +
      'from the Pre-boarding/Onboarding pages you can see, Cancelled left out unless cohort.status says so).',
  input: Joi.object({
    person: Joi.string().min(1).max(120).description('Name, email or employee id of one person.'),
    cohort: placementFilters.description('The people in these placements (same filters as list_placements).'),
    onlyWith: Joi.string().valid(...ONLY_WITH).description('Cohort only: keep people with at least one such document.'),
    expiringWithinDays: Joi.number().integer().min(1).max(365).default(30)
      .description('Window for "expiring soon" on EAD / visa (already expired counts too).'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20),
  }).oxor('person', 'cohort'),
  access: DOCUMENTS_ACCESS,
  async execute({ person, cohort, onlyWith, expiringWithinDays, limit } = {}, ctx) {
    const user = hiringScope(ctx);
    const deps = detailDeps(ctx);
    const canViewOthers = canViewOthersDocuments(user);

    if (cohort) {
      if (!canViewOthers) return { error: OTHERS_DENIED };
      const res = await deps.queryPlacements(
        placementQueryFilter(cohort), { page: 1, limit: SCAN_CAP, sortBy: 'joiningDate:desc' }, user,
      );
      const rows = res?.results || [];
      const ids = [...new Set(rows.map((p) => idOf(p.candidate)).filter(Boolean))];
      const profiles = await loadDocumentProfiles(ids, deps);
      const now = deps.now();
      const people = ids.map((cid) => profiles.get(cid)).filter(Boolean)
        .map((emp) => documentSummary(emp, { now, withinDays: expiringWithinDays }))
        .filter(keepFor(onlyWith));
      return {
        total: people.length,
        records: people.slice(0, limit),
        placementsScanned: rows.length,
        ...((res?.totalResults ?? 0) > rows.length ? { scanTruncated: true } : {}),
        filtersApplied: { cohort, ...(onlyWith ? { onlyWith } : {}), expiringWithinDays },
      };
    }

    if (person) {
      const found = await resolveProfile(person, deps);
      // Without the documents gate, a name lookup must not reveal who exists (names / employee ids of
      // profiles the viewer cannot open): anything but one profile they own is the same refusal.
      if (!canViewOthers && !(found.profile && ownsProfile(found.profile, user))) return { error: OTHERS_DENIED };
      if (found.notFound !== undefined) return { notFound: 'person', searchedFor: found.notFound };
      if (found.matches) return { matches: found.matches };
      const emp = found.profile;
      const login = emp.email
        ? await deps.User.findOne({ email: String(emp.email).toLowerCase() }).select('_id').lean()
        : null;
      return personView(emp, idOf(login), expiringWithinDays, deps);
    }

    if (!user.email) return { notFound: 'profile' };
    const own = await deps.Employee.findOne({ email: String(user.email).toLowerCase() }).select(DOCUMENT_FIELDS).lean();
    if (!own) return { notFound: 'profile', note: 'You have no candidate or employee profile with documents.' };
    return personView(own, idOf(user), expiringWithinDays, deps);
  },
});
