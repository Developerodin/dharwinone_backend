import Joi from 'joi';

export const filters = Joi.object({
  search: Joi.string().min(1)
    .description('Matches name or email — like the Users directory search box.'),
  status: Joi.string().valid('active', 'pending', 'disabled', 'deleted', 'all')
    .description(
      'Defaults to active. Pass "all" only when the user asks for every status ' +
        '(e.g. "including disabled", "every account").'
    ),
  role: Joi.alternatives()
    .try(Joi.string().min(1), Joi.array().items(Joi.string().min(1)).max(10))
    .description(
      'Any role name in the system (e.g. "Administrator", "Sales Agent", ' +
        '"Recruiter") — not limited to a fixed list. Pass an array to match ANY of ' +
        'several roles. An unrecognized name is an error, not a silent empty result.'
    ),
  location: Joi.string().min(1).description('Filter by location (partial match).'),
  domain: Joi.string().min(1).description('Filter by domain/specialization (partial match).'),
  education: Joi.string().min(1).description('Filter by education (partial match).'),
  inactiveDays: Joi.number().integer().min(1).max(3650)
    .description(
      'No sign-in in the last N days: last login older than N days, or never signed in on an account older ' +
        'than N days. E.g. "not logged in for a month" → 30.'
    ),
  neverLoggedIn: Joi.boolean()
    .description('true = accounts with no recorded sign-in at all; false = accounts that have signed in.'),
}).description('User filters. Omit a key to leave it unfiltered; status defaults to active.');

/**
 * Same idiom as jobs' withDefaultStatus: status defaults to 'active', except a
 * breakdown BY status defaults to unfiltered ('all') so it isn't collapsed to
 * one bucket.
 * @param {object} [f]
 * @param {{ groupBy?: string }} [opts]
 */
export function withDefaultStatus(f = {}, { groupBy } = {}) {
  if (f.status) return { ...f };
  return { ...f, status: groupBy === 'status' ? 'all' : 'active' };
}
