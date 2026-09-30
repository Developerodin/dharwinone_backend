import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import {
  REFERRALS_ACCESS, MAX_LIST_LIMIT, SHARES_NOT_CAPTURED, referralsScope, referralsDeps, referralRow, linkIssuedFor,
} from './common.js';

// Each match costs one ActivityLog lookup for "who issued the link"; later matches skip it.
export const LINK_LOOKUPS_MAX = 5;
const NO_LINK_RECORD =
  'No link-issued record — onboarding invites, backfilled referrals and links issued before auditing have none.';

export default defineTool({
  name: 'get_referral',
  domain: 'referrals',
  kind: 'read',
  description:
    'Who referred a person: referrer, assigned sales agent, lead id and attribution id, channel (job link or ' +
    'onboard invite), job, when the referral was claimed, pipeline status, any attribution override, and who ' +
    'issued the referral link and when. If they are not a referral lead, says whether they came in directly. ' +
    'Use for "who referred <person>", "was <person> referred", "which sales agent brought in <person>".',
  input: Joi.object({
    person: Joi.string().min(1).max(200).required()
      .description('The referred person — name or email, partial match.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(20)
      .description('Max matches to return (default 20). total is always the full count.'),
  }),
  access: REFERRALS_ACCESS,
  async execute({ person, limit = 20 } = {}, ctx) {
    const user = referralsScope(ctx);
    const deps = referralsDeps(ctx);
    const res = await deps.searchReferralLeads(user, { search: person, page: 1, limit });
    if (res?.forbidden) return { error: res.reason || 'You do not have access to referral leads.' };

    const withLinks = async (rows, total, extra = {}) => {
      const records = rows.map(referralRow);
      const head = records.slice(0, LINK_LOOKUPS_MAX);
      const jtis = await deps.fetchReferralJtis(head.map((r) => r.leadId));
      const issued = await Promise.all(head.map((r) => linkIssuedFor(jtis.get(r.leadId), user, deps)));
      records.forEach((r, i) => {
        r.linkIssued = issued[i] ?? null;
        if (i >= LINK_LOOKUPS_MAX) r.linkIssuedNote = `Only looked up for the first ${LINK_LOOKUPS_MAX} matches.`;
        else if (!issued[i]) r.linkIssuedNote = NO_LINK_RECORD;
      });
      return { total, records, ...extra, notCaptured: SHARES_NOT_CAPTURED };
    };

    if (res?.results?.length) return withLinks(res.results, res.total ?? res.results.length);

    // A scoped viewer only sees their own leads, so "not in my leads" says nothing about anyone else's referral.
    if (!(await deps.canSeeAllReferralLeads(user))) {
      return {
        total: 0,
        records: [],
        referred: null,
        note: 'Not among the referral leads you can see (ones you referred or are the sales agent for). ' +
          'Whether someone else referred them is outside your view.',
        notCaptured: SHARES_NOT_CAPTURED,
      };
    }

    const people = await deps.runPersonList({
      filters: { search: person }, ownerUserRole: 'candidate', limit: 5, user, deps: deps.personDeps,
    });
    const found = people?.records || [];
    // The person search also matches fields the Refer Leads search does not (employee id, phone...), so a
    // match here can still be a referral lead. Only people with no referrer on record are "direct".
    const referredIds = found.length ? await deps.referrerIdsFor(found.map((p) => p.id)) : new Set();
    const missed = found.filter((p) => referredIds.has(String(p.id)));
    if (missed.length) {
      const hits = await Promise.all(
        missed.map((p) => deps.searchReferralLeads(user, { search: p.email || p.name, page: 1, limit: 5 })),
      );
      const rows = hits.flatMap((h, i) => (h?.results || []).filter((r) => String(r.id ?? r._id) === String(missed[i].id)));
      const unlisted = missed.filter((p) => !rows.some((r) => String(r.id ?? r._id) === String(p.id)));
      return withLinks(rows, rows.length, unlisted.length
        ? {
          unlisted: unlisted.map((p) => ({ candidate: p.name, referred: true })),
          unlistedNote: 'A referrer is recorded for them, but they are not on the Refer Leads page (e.g. their ' +
            'portal account was removed), so the referral details are not shown.',
        }
        : {});
    }
    const direct = found.map((p) => ({ candidate: p.name, email: p.email, referred: false, referredBy: null }));
    if (direct.length) {
      return {
        total: 0,
        records: [],
        direct,
        note: 'No referrer is recorded in DharwinOne for them, so they came in directly (not through a referral link or invite).',
        notCaptured: SHARES_NOT_CAPTURED,
      };
    }
    return { total: 0, records: [], notFound: true, notCaptured: SHARES_NOT_CAPTURED };
  },
  render(result) {
    if (!result?.records?.length) return null;
    return {
      blocks: [{
        type: 'table',
        id: 'referral-detail',
        tableType: 'referral-detail',
        title: `Referrals (${result.total})`,
        columns: [
          { key: 'candidate', label: 'Person', priority: 'primary' },
          { key: 'referredBy', label: 'Referred by', priority: 'primary' },
          { key: 'salesAgent', label: 'Sales agent', priority: 'secondary' },
          { key: 'channel', label: 'Channel', priority: 'secondary' },
          { key: 'referredAt', label: 'Referred', priority: 'secondary', format: 'date' },
        ],
        rows: result.records.map((r) => ({
          candidate: r.candidate ?? '—',
          referredBy: r.referredBy ?? '—',
          salesAgent: r.salesAgent ?? '—',
          channel: r.channel ?? '—',
          referredAt: r.referredAt ?? '—',
        })),
        layout: 'auto',
      }],
    };
  },
});
