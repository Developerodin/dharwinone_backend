// src/services/chatAssistant/personProfile/providers/userScalar.js
//
// Recruiter, Agent and Administrator have no profile collection — their profile
// is the User row. One factory parameterized by namespace, rather than three
// near-identical files. Administrator passes ns=null: it has no permission
// namespace, so the projector's base gate short-circuits to allow and only the
// declared fields below are ever exposed.

import User from '../../../../models/user.model.js';

const USER_SCALAR_FIELDS = {
  identity: {
    name:     { path: 'name',        tier: 'directory', summary: true },
    email:    { path: 'email',       tier: 'directory' },
    phone:    { path: 'phoneNumber' },
    location: { path: 'location' },
  },
};

const RELATED = {
  recruiter:     ['fetch_candidates', 'fetch_job_applications'],
  agent:         [],
  administrator: [],
};

export function makeUserScalarProvider(role, ns) {
  return {
    role,
    ns,
    store: User,
    key: '_id',
    relatedTools: RELATED[role] ?? [],
    FIELDS: USER_SCALAR_FIELDS,
    deriveFns: {},
    load: (target) => User.findById(target.userId).lean(),
  };
}
