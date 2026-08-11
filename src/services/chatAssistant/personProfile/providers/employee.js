// src/services/chatAssistant/personProfile/providers/employee.js
//
// The Employee document is ALSO the Candidate document — employee.model.js binds
// the schema to the Mongo collection 'candidates', and ensureCandidateProfileForUser
// does Employee.findOne({owner}). candidate.js reads the same store under a
// different namespace; see selectProviders.js for the collapse rule.

import Employee from '../../../../models/employee.model.js';
import { resignationCutoff } from '../../employeeEmploymentFilter.js';

/**
 * Mirrors employmentStatusClause(): a resignDate AFTER the UTC end-of-day cutoff
 * means the person is on notice and still active. resignDate is stored date-only
 * in UTC while the server runs IST, so the cutoff is UTC 23:59:59.999.
 */
export function employmentStatus(doc) {
  const resign = doc?.resignDate;
  if (!resign) return 'active';
  return new Date(resign) <= resignationCutoff() ? 'resigned' : 'active';
}

/**
 * `load` populates reportingManager, so this reads a name off a subdocument. A
 * plain `path` declaration would put a raw ObjectId in front of the model, which
 * it would then read out loud as if it were an answer.
 */
export function reportingManagerName(doc) {
  return doc?.reportingManager?.name ?? null;
}

function positionName(doc) {
  const pos = doc?.position;
  if (!pos) return null;
  if (typeof pos === 'object' && pos.name) return pos.name;
  return null;
}

function summarizeList(items, formatter, emptyLabel = null) {
  if (!Array.isArray(items) || !items.length) return emptyLabel;
  const lines = items.slice(0, 5).map(formatter).filter(Boolean);
  if (!lines.length) return emptyLabel;
  const suffix = items.length > 5 ? ` (+${items.length - 5} more)` : '';
  return `${lines.join('; ')}${suffix}`;
}

export function qualificationsSummary(doc) {
  return summarizeList(
    doc?.qualifications,
    (q) => [q.degree, q.institute, q.endYear ? `(${q.endYear})` : ''].filter(Boolean).join(' at '),
    null
  );
}

export function experiencesSummary(doc) {
  return summarizeList(
    doc?.experiences,
    (e) => [e.role, e.company].filter(Boolean).join(' at '),
    null
  );
}

export function skillsSummary(doc) {
  return summarizeList(
    doc?.skills,
    (s) => (s.level && s.level !== 'Beginner' ? `${s.name} (${s.level})` : s.name),
    null
  );
}

export function documentsSummary(doc) {
  return summarizeList(
    doc?.documents,
    (d) => d.label || d.type || d.originalName || 'Document',
    null
  );
}

export function salarySlipsSummary(doc) {
  return summarizeList(
    doc?.salarySlips,
    (s) => [s.month, s.year].filter(Boolean).join(' '),
    null
  );
}

export function recruiterNotesSummary(doc) {
  return summarizeList(
    doc?.recruiterNotes,
    (n) => n.note,
    null
  );
}

export const EMPLOYEE_FIELDS = {
  identity: {
    name:       { path: 'fullName',             tier: 'directory', summary: true },
    email:      { path: 'email' },
    workEmail:  { path: 'companyAssignedEmail', tier: 'directory' },
    phone:      { path: 'phoneNumber' },
    employeeId: { path: 'employeeId' },
    bio:        { path: 'shortBio' },
  },
  employment: {
    joiningDate:      { path: 'joiningDate', summary: true },
    resignDate:       { path: 'resignDate',  requires: 'employees.manage' },
    employmentStatus: { derive: 'employmentStatus', total: true,
                        requires: 'employees.manage', summary: true },
  },
  organization: {
    department:       { path: 'department',  tier: 'directory' },
    designation:      { path: 'designation', tier: 'directory' },
    position:         { derive: 'positionName', tier: 'directory' },
    reportingManager: { derive: 'reportingManagerName' },
  },
  education: {
    degree:           { path: 'degree', tier: 'directory' },
    qualifications:   { derive: 'qualificationsSummary', requires: 'employees.read', orSelf: true, summary: true },
  },
  experience: {
    experiences:      { derive: 'experiencesSummary', requires: 'employees.read', orSelf: true, summary: true },
  },
  skills: {
    skills:           { derive: 'skillsSummary', tier: 'directory', summary: true },
  },
  documents: {
    documents:        { derive: 'documentsSummary', requires: 'employees.manage', orSelf: true },
  },
  payroll: {
    salarySlips:      { derive: 'salarySlipsSummary', requires: 'employees.manage', orSelf: true },
  },
  notes: {
    recruiterNotes:   { derive: 'recruiterNotesSummary', requires: 'employees.manage' },
  },
  compensation: {
    salaryRange:      { path: 'salaryRange',      requires: 'employees.manage', orSelf: true },
    compensationType: { path: 'compensationType', requires: 'employees.manage' },
  },
  immigration: {
    sevisId:  { path: 'sevisId',  requires: 'employees.manage', orSelf: true },
    ead:      { path: 'ead',      requires: 'employees.manage', orSelf: true },
    visaType: { path: 'visaType', requires: 'employees.manage', orSelf: true },
  },
  internal: {
    // No orSelf key: the default is false, which is exactly what we want. An
    // employee must not read their own recruiter rating.
    recruiterFeedback: { path: 'recruiterFeedback', requires: 'employees.manage' },
    recruiterRating:   { path: 'recruiterRating',   requires: 'employees.manage' },
  },
};

export default {
  role: 'employee',
  ns: 'employees',
  store: Employee,
  key: 'owner',
  relatedTools: ['fetch_employee_overview', 'fetch_employee_attendance',
                 'fetch_leave_requests', 'fetch_tasks', 'fetch_projects'],
  FIELDS: EMPLOYEE_FIELDS,
  deriveFns: {
    employmentStatus,
    reportingManagerName,
    positionName,
    qualificationsSummary,
    experiencesSummary,
    skillsSummary,
    documentsSummary,
    salarySlipsSummary,
    recruiterNotesSummary,
  },
  load: (target) =>
    Employee.findOne({ owner: target.userId })
      .populate('reportingManager', 'name')
      .populate('position', 'name')
      .lean(),
};
