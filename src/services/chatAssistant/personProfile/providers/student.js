// src/services/chatAssistant/personProfile/providers/student.js
//
// Canonical keys are shared with employee.js; `path` differs because Student
// stores `bio`/`phone` where Employee stores `shortBio`/`phoneNumber`.
// Collection-valued fields (education[], experience[], skills, documents,
// address) are deferred: Employee and Student diverge in SHAPE, not just key,
// and the projector has no truncation contract yet.

import Student from '../../../../models/student.model.js';

export const STUDENT_FIELDS = {
  identity: {
    name:        { path: 'user.name', tier: 'directory', summary: true },
    phone:       { path: 'phone' },
    bio:         { path: 'bio' },
    dateOfBirth: { path: 'dateOfBirth', requires: 'students.manage', orSelf: true },
    gender:      { path: 'gender',      requires: 'students.manage', orSelf: true },
  },
  enrolment: {
    joiningDate: { path: 'joiningDate', summary: true },
    position:    { path: 'position' },
    status:      { path: 'status' },
  },
};

export default {
  role: 'student',
  ns: 'students',
  store: Student,
  key: 'user',
  relatedTools: ['training_analytics', 'fetch_attendance'],
  FIELDS: STUDENT_FIELDS,
  deriveFns: {},
  load: (target) => Student.findOne({ user: target.userId }).populate('user', 'name').lean(),
};
