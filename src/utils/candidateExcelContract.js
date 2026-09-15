/**
 * Single workbook contract for employee Excel template, export, and import.
 * Import parsers and the frontend template must match these headers exactly.
 */

export const SHEET_NAMES = Object.freeze({
  details: 'Employee Details',
  qualifications: 'Qualifications',
  experience: 'Experience',
  skills: 'Skills',
  social: 'Social Links',
  documents: 'Documents',
  salarySlips: 'Salary Slips',
});

/** Legacy import aliases → canonical sheet names. Template/export use canonical only. */
export const SHEET_ALIASES = Object.freeze({
  'employee details': SHEET_NAMES.details,
  'personal info': SHEET_NAMES.details,
  qualifications: SHEET_NAMES.qualifications,
  qualification: SHEET_NAMES.qualifications,
  experience: SHEET_NAMES.experience,
  'work experience': SHEET_NAMES.experience,
  skills: SHEET_NAMES.skills,
  'social links': SHEET_NAMES.social,
  documents: SHEET_NAMES.documents,
  'salary slips': SHEET_NAMES.salarySlips,
});

export const IDENTITY_HEADERS = Object.freeze(['Employee ID', 'Full Name', 'Email']);

export const EMPLOYEE_DETAILS_HEADERS = Object.freeze([
  'Employee ID',
  'Full Name',
  'Email',
  'Password',
  'Phone Number',
  'Country Code',
  'Owner',
  'Owner Email',
  'Admin',
  'Admin Email',
  'Assigned Agent Name',
  'Assigned Agent Email',
  'Designation',
  'Position',
  'Compensation Status',
  'Employment Status',
  'Profile Completion %',
  'Profile Status',
  'Short Bio',
  'SEVIS ID',
  'EAD',
  'Degree',
  'Visa Type',
  'Custom Visa Type',
  'Supervisor Name',
  'Supervisor Contact',
  'Supervisor Country Code',
  'Salary Range',
  'Street Address',
  'Street Address 2',
  'City',
  'State',
  'Zip Code',
  'Country',
  'Created At',
  'Updated At',
]);

export const QUALIFICATIONS_HEADERS = Object.freeze([
  ...IDENTITY_HEADERS,
  'Degree',
  'Institute',
  'Location',
  'Start Year',
  'End Year',
  'Description',
]);

export const EXPERIENCE_HEADERS = Object.freeze([
  ...IDENTITY_HEADERS,
  'Company',
  'Role',
  'Start Date',
  'End Date',
  'Currently Working',
  'Description',
]);

export const SKILLS_HEADERS = Object.freeze([...IDENTITY_HEADERS, 'Skill Name', 'Level', 'Category']);

export const SOCIAL_HEADERS = Object.freeze([...IDENTITY_HEADERS, 'Platform', 'URL']);

export const DOCUMENTS_HEADERS = Object.freeze([
  ...IDENTITY_HEADERS,
  'Document Name',
  'Document Type',
  'Upload Status',
  'Mime Type',
  'Note',
]);

export const SALARY_SLIPS_HEADERS = Object.freeze([...IDENTITY_HEADERS, 'Month', 'Year']);

export const DOCUMENTS_NOTE = 'files not included';

export const SAMPLE_IMPORT_PASSWORD = 'Welcome1A';

export function normalizeHeader(header) {
  return String(header || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function normalizeEmail(email) {
  return String(email || '')
    .trim()
    .toLowerCase();
}

export function fmtIsoDate(d) {
  if (d === null || d === undefined || d === '') return '';
  if (d instanceof Date && !Number.isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  if (typeof d === 'number' && Number.isFinite(d)) {
    const parsed = excelSerialToParts(d);
    if (parsed) return parsed;
  }
  const asDate = new Date(d);
  if (!Number.isNaN(asDate.getTime()) && String(d).trim() !== '') {
    if (/^\d{4}-\d{2}-\d{2}/.test(String(d).trim())) {
      return String(d).trim().slice(0, 10);
    }
    return asDate.toISOString().slice(0, 10);
  }
  return String(d);
}

function excelSerialToParts(serial) {
  const epoch = Date.UTC(1899, 11, 30);
  const ms = epoch + Math.round(serial * 86400000);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
}

export function compensationStatusLabel(compensationType) {
  return String(compensationType || '').toLowerCase() === 'unpaid' ? 'Unpaid' : 'Paid';
}

export function compensationTypeFromLabel(value) {
  const s = String(value || '')
    .trim()
    .toLowerCase();
  if (s === 'unpaid') return 'unpaid';
  if (s === 'paid') return 'paid';
  return undefined;
}

export function employmentStatusLabel({ isActive, resignDate } = {}) {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  if (resignDate) {
    const rd = new Date(resignDate);
    rd.setHours(0, 0, 0, 0);
    if (!Number.isNaN(rd.getTime()) && rd <= cutoff) return 'Resigned';
  }
  if (isActive === false) return 'Resigned';
  return 'Active';
}

export function parseCurrentlyWorking(value) {
  const s = String(value ?? '')
    .trim()
    .toLowerCase();
  if (['yes', 'true', '1'].includes(s)) return true;
  if (['no', 'false', '0', ''].includes(s)) return false;
  return false;
}

export function isPasswordPolicyOk(password) {
  const value = String(password || '');
  return value.length >= 8 && /\d/.test(value) && /[A-Z]/.test(value);
}

export function resolveSheetName(workbook, canonicalName) {
  if (!workbook?.SheetNames) return null;
  if (workbook.SheetNames.includes(canonicalName)) return canonicalName;
  const wanted = String(canonicalName).trim().toLowerCase();
  for (const name of workbook.SheetNames) {
    const key = String(name).trim().toLowerCase();
    if (SHEET_ALIASES[key] === canonicalName || key === wanted) return name;
  }
  return null;
}

export function headerIndexMap(headers) {
  const map = {};
  (headers || []).forEach((header, index) => {
    const key = normalizeHeader(header);
    if (key && map[key] === undefined) map[key] = index;
  });
  return map;
}

export function cellAt(row, indexMap, ...headerKeys) {
  for (const key of headerKeys) {
    const idx = indexMap[normalizeHeader(key)];
    if (idx === undefined) continue;
    const raw = row?.[idx];
    if (raw === null || raw === undefined) continue;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '') continue;
    return value;
  }
  return '';
}

export function findCandidateByJoinKey(candidates, { email, employeeId }) {
  const e = normalizeEmail(email);
  if (e) {
    const byEmail = candidates.find((c) => normalizeEmail(c.email) === e);
    if (byEmail) return byEmail;
  }
  const id = String(employeeId || '').trim();
  if (id) {
    const byId = candidates.find((c) => String(c.employeeId || '').trim() === id);
    if (byId) return byId;
  }
  return null;
}
