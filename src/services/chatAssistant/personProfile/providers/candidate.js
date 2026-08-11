// src/services/chatAssistant/personProfile/providers/candidate.js
//
// Same physical document as employee.js. Two things follow:
//   1. `requires` strings name employees.manage, NOT candidates.manage. The gate
//      protects a byte on disk, and candidates.read is granted by interviews.read
//      (config/permissions.js:96-105) — gating on the candidate namespace would let
//      an interview scheduler read salary and immigration data.
//   2. Role resolution goes through roleRegistry, never getAtsJobSeekerRoleIds(),
//      which folds Employee and Candidate together (role.service.js:118).

import Employee from '../../../../models/employee.model.js';
import { employmentStatus } from './employee.js';

export const CANDIDATE_FIELDS = {
  identity: {
    name:  { path: 'fullName', tier: 'directory', summary: true },
    email: { path: 'email' },
    phone: { path: 'phoneNumber' },
    bio:   { path: 'shortBio' },
  },
  application: {
    joiningDate: { path: 'joiningDate', requires: 'candidates.read', summary: true },
    designation: { path: 'designation', tier: 'directory' },
    department:  { path: 'department',  tier: 'directory' },
  },
  compensation: {
    salaryRange: { path: 'salaryRange', requires: 'employees.manage', orSelf: true },
  },
  immigration: {
    sevisId:  { path: 'sevisId',  requires: 'employees.manage', orSelf: true },
    ead:      { path: 'ead',      requires: 'employees.manage', orSelf: true },
    visaType: { path: 'visaType', requires: 'employees.manage', orSelf: true },
  },
  internal: {
    recruiterFeedback: { path: 'recruiterFeedback', requires: 'employees.manage' },
    recruiterRating:   { path: 'recruiterRating',   requires: 'employees.manage' },
  },
};

export default {
  role: 'candidate',
  ns: 'candidates',
  store: Employee,
  key: 'owner',
  relatedTools: ['fetch_job_applications', 'fetch_interviews', 'fetch_offers'],
  FIELDS: CANDIDATE_FIELDS,
  deriveFns: { employmentStatus },
  load: (target) => Employee.findOne({ owner: target.userId }).lean(),
};
