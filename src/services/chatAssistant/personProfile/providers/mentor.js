// src/services/chatAssistant/personProfile/providers/mentor.js

import Mentor from '../../../../models/mentor.model.js';

export const MENTOR_FIELDS = {
  identity: {
    name:        { path: 'user.name', tier: 'directory', summary: true },
    phone:       { path: 'phone' },
    bio:         { path: 'bio', summary: true },
    dateOfBirth: { path: 'dateOfBirth', requires: 'mentors.manage', orSelf: true },
    gender:      { path: 'gender',      requires: 'mentors.manage', orSelf: true },
  },
  engagement: {
    status: { path: 'status' },
  },
};

export default {
  role: 'mentor',
  ns: 'mentors',
  store: Mentor,
  key: 'user',
  relatedTools: ['training_analytics'],
  FIELDS: MENTOR_FIELDS,
  deriveFns: {},
  load: (target) => Mentor.findOne({ user: target.userId }).populate('user', 'name').lean(),
};
