import { STALE_MESSAGE } from '../../../sageActions.js';

export const HEX_ID_RE = /^[0-9a-fA-F]{24}$/;
export const MAX_PEOPLE = 10;

/** Fail closed: scope helpers treat a missing user as unrestricted. */
export function actorOf(ctx) {
  const id = ctx?.user?.id ?? ctx?.user?._id;
  if (!id) throw new Error('actions need an authenticated user with an id');
  return { user: ctx.user, userId: String(id) };
}

export const idOf = (v) => (v == null ? null : String(v?._id ?? v?.id ?? v));

export const escapeRegex = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function nameList(people) {
  const names = people.map((p) => p.name).filter(Boolean);
  if (names.length <= 1) return names[0] || '1 person';
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Confirm-time check: re-run prepare and refuse unless the targets, every summary line and the
 * payload are unchanged, so commit never does something the card did not say.
 * Same comparison as actions/interviews/common.js recheckSameDraft.
 */
export function recheckSameDraft(prepare) {
  return async (draft, ctx) => {
    const fresh = await prepare(draft.args, ctx);
    if (!fresh?.ok) return { ok: false, error: fresh?.error || STALE_MESSAGE };
    const ids = (s) => JSON.stringify((s?.targets || []).map((t) => String(t.id)).sort());
    const same = ids(fresh.summary) === ids(draft.summary)
      && JSON.stringify(fresh.summary?.lines) === JSON.stringify(draft.summary?.lines)
      && JSON.stringify(fresh.payload) === JSON.stringify(draft.payload);
    return same ? { ok: true } : { ok: false, error: STALE_MESSAGE };
  };
}
