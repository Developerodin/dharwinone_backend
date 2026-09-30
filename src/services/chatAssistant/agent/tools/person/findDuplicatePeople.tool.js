import Joi from 'joi';
import { defineTool } from '../../defineTool.js';
import { EMPLOYEES_ACCESS, MAX_LIST_LIMIT, personRecordsScope, personRecordsDeps } from '../employees/common.js';
import { toApiFilter } from '../../../../../schemas/employees/employeeQuery.scope.js';
import { MAX_ROWS } from './common.js';

const BY = ['email', 'phone', 'both'];
const POPULATIONS = ['candidates', 'employees', 'all'];
// Employees page role filter: Candidate role, Employee role, or either (the page's "jobSeeker" scope).
const OWNER_ROLE = { candidates: 'candidate', employees: 'employee', all: 'jobSeeker' };
const PHONE_DIGITS = 10;
// Shorter digit strings are placeholders ("0", "123"), not phone numbers — grouping them is noise.
const MIN_PHONE_DIGITS = 7;
const EMAIL_UNIQUE_NOTE =
  'Profile emails are stored lower-case and unique in DharwinOne, so email groups only catch case / space variants.';

const str = (field) => ({ $toString: { $ifNull: [field, ''] } });

/** Lower-case, trimmed email. */
const EMAIL_KEY = { $toLower: { $trim: { input: str('$email') } } };

/** Digits only, last 10 — "+91 98765-43210" and "098765 43210" both key to 9876543210. */
const DIGITS = {
  $reduce: {
    input: { $regexFindAll: { input: str('$phoneNumber'), regex: '[0-9]' } },
    initialValue: '',
    in: { $concat: ['$$value', '$$this.match'] },
  },
};
const PHONE_KEY = {
  $let: {
    vars: { d: DIGITS },
    in: {
      $cond: [
        { $gte: [{ $strLenCP: '$$d' }, MIN_PHONE_DIGITS] },
        { $substrCP: ['$$d', { $max: [0, { $subtract: [{ $strLenCP: '$$d' }, PHONE_DIGITS] }] }, PHONE_DIGITS] },
        '',
      ],
    },
  },
};

export function duplicatePipeline(scopedFilter, field, limit) {
  return [
    { $match: scopedFilter },
    { $project: { fullName: 1, owner: 1, key: field === 'email' ? EMAIL_KEY : PHONE_KEY } },
    { $match: { key: { $nin: ['', null] } } },
    { $group: { _id: '$key', size: { $sum: 1 }, people: { $push: { id: '$_id', name: '$fullName', ownerUserId: '$owner' } } } },
    { $match: { size: { $gt: 1 } } },
    { $sort: { size: -1, _id: 1 } },
    {
      $facet: {
        total: [{ $count: 'n' }],
        groups: [{ $limit: limit }, { $project: { size: 1, people: { $slice: ['$people', MAX_ROWS] } } }],
      },
    },
  ];
}

const toGroup = (field) => (g) => ({
  matchedOn: field,
  // Shown as-is: the Employees page lists email and phone on every row it lets this viewer see.
  value: g._id,
  size: g.size,
  people: (g.people || []).map((p) => ({
    id: String(p.id),
    name: p.name ?? null,
    // The login that owns the profile — for a public-apply candidate that is the job creator, not the person.
    ownerUserId: p.ownerUserId != null ? String(p.ownerUserId) : null,
  })),
});

export default defineTool({
  name: 'find_duplicate_people',
  domain: 'person',
  kind: 'read',
  description:
    'Groups of candidate / employee profiles that share the same email (lower-case, trimmed) or phone (digits only, ' +
    'last 10). Use for "duplicate candidates", "same phone number on two profiles", "people with the same email", ' +
    '"clean up duplicates". NOT for finding one person by name (get_user / list_candidates) or counting people ' +
    '(count_candidates / count_employees).',
  measure:
    'Employees page profiles you can see (any employment status), grouped by shared contact value; a group is 2+ ' +
      'profiles. totalGroups counts every group; groups lists the largest first, at most 5 people each. ownerUserId is ' +
      'the login that owns the profile; a recruiter owns the public-apply candidates of their jobs, so it is not ' +
      'always the person — look people up by their profile id.',
  input: Joi.object({
    by: Joi.string().valid(...BY).default('both').description('Which contact field to compare. Default both.'),
    population: Joi.string().valid(...POPULATIONS).default('all')
      .description('candidates = Candidate role, employees = Employee role, all = either. Default all.'),
    limit: Joi.number().integer().min(1).max(MAX_LIST_LIMIT).default(MAX_ROWS)
      .description('Max groups to list (default 5, max 50). totalGroups is always the full count.'),
  }),
  access: EMPLOYEES_ACCESS,
  async execute({ by = 'both', population = 'all', limit = MAX_ROWS } = {}, ctx) {
    const user = personRecordsScope(ctx);
    const deps = personRecordsDeps(ctx);
    const castFilter = ctx?.deps?.castFilter ?? ((f) => deps.Employee.find().cast(deps.Employee, f));

    const roleFilter = { ownerUserRole: OWNER_ROLE[population], employmentStatus: 'all' };
    const apiFilter = await deps.applyEmployeeListScope(toApiFilter(roleFilter), user, user.authContext);
    const { mongoFilter } = await deps.buildEmployeeListMongoFilter(apiFilter);
    // ponytail: no Wave 1 tool groups profiles by contact value, so this is one $group aggregate over the
    // Employees page's own scoped filter. Aggregate $match does not cast, hence castFilter (string ids →
    // ObjectId). Ceiling: a scan of every scoped profile — fine to ~100k; past that, store normalised
    // email / phone keys with an index and group on those.
    const scoped = castFilter(mongoFilter);

    const fields = by === 'both' ? ['email', 'phone'] : [by];
    const results = await Promise.all(fields.map((f) => deps.Employee.aggregate(duplicatePipeline(scoped, f, limit))));

    const byField = {};
    const groups = [];
    fields.forEach((f, i) => {
      const facet = results[i]?.[0] || {};
      byField[f] = facet.total?.[0]?.n ?? 0;
      groups.push(...(facet.groups || []).map(toGroup(f)));
    });
    groups.sort((a, b) => b.size - a.size);
    const totalGroups = Object.values(byField).reduce((n, c) => n + c, 0);
    const listed = groups.slice(0, limit);

    return {
      by,
      population,
      totalGroups,
      byField,
      groups: listed,
      ...(totalGroups > listed.length ? { truncated: true } : {}),
      ...(fields.includes('email') ? { emailNote: EMAIL_UNIQUE_NOTE } : {}),
    };
  },
  render(result) {
    if (!result || typeof result.totalGroups !== 'number') return null;
    const rows = (result.groups || []).map((g) => ({
      matchedOn: g.matchedOn,
      value: g.value,
      size: String(g.size),
      people: g.people.map((p) => p.name ?? p.id).join(', '),
    }));
    return {
      blocks: rows.length ? [{
        type: 'table',
        id: 'duplicate-people',
        tableType: 'duplicate-people',
        title: `Duplicate profiles (${result.totalGroups} groups)`,
        columns: [
          { key: 'matchedOn', label: 'Matched on', priority: 'primary' },
          { key: 'value', label: 'Value', priority: 'primary' },
          { key: 'size', label: 'Profiles', priority: 'secondary' },
          { key: 'people', label: 'People', priority: 'primary' },
        ],
        rows,
        layout: 'auto',
      }] : [],
      facts: { counts: [{ kind: 'find_duplicate_people', label: 'duplicate groups', total: result.totalGroups }] },
    };
  },
});
