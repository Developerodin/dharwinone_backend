import XLSX from 'xlsx';
import httpStatus from 'http-status';
import ApiError from '../utils/ApiError.js';
import Employee from '../models/employee.model.js';
import { createCandidate, updateCandidateById } from './employee.service.js';
import {
  SHEET_NAMES,
  cellAt,
  compensationTypeFromLabel,
  findCandidateByJoinKey,
  fmtIsoDate,
  headerIndexMap,
  isPasswordPolicyOk,
  normalizeEmail,
  parseCurrentlyWorking,
  resolveSheetName,
} from '../utils/candidateExcelContract.js';

const PHONE_RULES = {
  IN: { regex: /^[6-9]\d{9}$/, length: 10, example: '9876543210' },
  US: { regex: /^\d{10}$/, length: 10, example: '2025551234' },
  CA: { regex: /^\d{10}$/, length: 10, example: '4165551234' },
  GB: { regex: /^[1-9]\d{9,10}$/, length: [10, 11], example: '7700900123' },
  AU: { regex: /^[2-4789]\d{8}$/, length: 9, example: '412345678' },
  PK: { regex: /^3\d{9}$/, length: 10, example: '3001234567' },
  BD: { regex: /^1[3-9]\d{8}$/, length: 10, example: '1712345678' },
  PH: { regex: /^9\d{9}$/, length: 10, example: '9171234567' },
  SG: { regex: /^[689]\d{7}$/, length: 8, example: '91234567' },
  AE: { regex: /^[2-9]\d{8}$/, length: 9, example: '501234567' },
  SA: { regex: /^5\d{8}$/, length: 9, example: '501234567' },
  ZA: { regex: /^[6-9]\d{8}$/, length: 9, example: '712345678' },
  NG: { regex: /^[7-9]\d{9}$/, length: 10, example: '8012345678' },
  KE: { regex: /^7\d{8}$/, length: 9, example: '712345678' },
  DE: { regex: /^[1-9]\d{9,11}$/, length: [10, 11, 12], example: '15112345678' },
  FR: { regex: /^[1-9]\d{8}$/, length: 9, example: '612345678' },
  ES: { regex: /^[6-9]\d{8}$/, length: 9, example: '612345678' },
  IT: { regex: /^3\d{8,9}$/, length: [9, 10], example: '3123456789' },
  BR: { regex: /^[1-9]\d{9,10}$/, length: [10, 11], example: '11987654321' },
  MX: { regex: /^1\d{9}$/, length: 10, example: '1234567890' },
  AR: { regex: /^[2-9]\d{9}$/, length: 10, example: '1123456789' },
  CN: { regex: /^1[3-9]\d{9}$/, length: 11, example: '13812345678' },
  JP: { regex: /^[1-9]\d{8,9}$/, length: [9, 10], example: '9012345678' },
  KR: { regex: /^[1-9]\d{8,9}$/, length: [9, 10], example: '1012345678' },
  TH: { regex: /^[6-9]\d{8}$/, length: 9, example: '812345678' },
  VN: { regex: /^9\d{8}$/, length: 9, example: '912345678' },
  ID: { regex: /^8\d{9,10}$/, length: [10, 11], example: '81234567890' },
  MY: { regex: /^1[0-9]\d{7,8}$/, length: [9, 10], example: '123456789' },
  NZ: { regex: /^[2-9]\d{7}$/, length: 8, example: '21234567' },
};

const LEGACY_SUPPLEMENTAL_SHEETS = ['Visa and IDs', 'Supervisor and salary', 'Address'];
const SKILL_LEVELS = new Set(['Beginner', 'Intermediate', 'Advanced', 'Expert']);

function validatePhoneForCountry(phoneNumber, countryCode) {
  if (!phoneNumber) return { valid: false, error: 'Phone number is required' };
  const digits = String(phoneNumber).replace(/\D/g, '');
  const rule = PHONE_RULES[countryCode];
  if (!rule) {
    if (digits.length >= 6 && digits.length <= 15) return { valid: true, digits };
    return { valid: false, error: `Phone must be 6-15 digits (country ${countryCode})` };
  }
  if (!rule.regex.test(digits)) {
    const lengthMsg = Array.isArray(rule.length)
      ? `${rule.length[0]}-${rule.length[rule.length - 1]} digits`
      : `${rule.length} digits`;
    return {
      valid: false,
      error: `Invalid ${countryCode} phone number. Expected ${lengthMsg} (e.g., ${rule.example})`,
    };
  }
  return { valid: true, digits };
}

function rowHasValues(row) {
  return Boolean(row && row.some((cell) => cell !== undefined && cell !== null && String(cell).trim() !== ''));
}

function sheetAoa(workbook, canonicalName) {
  const name = resolveSheetName(workbook, canonicalName);
  if (!name) return null;
  const data = XLSX.utils.sheet_to_json(workbook.Sheets[name], { header: 1, defval: '', raw: true });
  if (!data.length) return null;
  return data;
}

function strCell(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return fmtIsoDate(value);
  return String(value).trim();
}

function joinFromRow(indexMap, row) {
  return {
    email: strCell(cellAt(row, indexMap, 'Email')),
    employeeId: strCell(cellAt(row, indexMap, 'Employee ID', 'EmployeeID')),
  };
}

function mergeDetailsRow(candidate, headers, row) {
  const indexMap = headerIndexMap(headers);
  const setIf = (keys, field) => {
    const value = strCell(cellAt(row, indexMap, ...keys));
    if (value) candidate[field] = value;
  };

  setIf(['Employee ID', 'EmployeeID'], 'employeeId');
  setIf(['Full Name', 'FullName'], 'fullName');
  setIf(['Email'], 'email');
  setIf(['Password'], 'password');
  setIf(['Phone Number', 'PhoneNumber'], 'phoneNumber');
  setIf(['Country Code', 'CountryCode'], 'countryCode');
  setIf(['Short Bio', 'ShortBio'], 'shortBio');
  setIf(['SEVIS ID', 'SevisId'], 'sevisId');
  setIf(['EAD'], 'ead');
  setIf(['Degree'], 'degree');
  setIf(['Visa Type', 'VisaType'], 'visaType');
  setIf(['Custom Visa Type', 'CustomVisaType'], 'customVisaType');
  setIf(['Supervisor Name', 'SupervisorName'], 'supervisorName');
  setIf(['Supervisor Contact', 'SupervisorContact'], 'supervisorContact');
  setIf(['Supervisor Country Code', 'SupervisorCountryCode'], 'supervisorCountryCode');
  setIf(['Salary Range', 'SalaryRange'], 'salaryRange');
  setIf(['Street Address', 'StreetAddress'], 'streetAddress');
  setIf(['Street Address 2', 'StreetAddress2'], 'streetAddress2');
  setIf(['City'], 'city');
  setIf(['State'], 'state');
  setIf(['Zip Code', 'ZipCode'], 'zipCode');
  setIf(['Country'], 'country');
  setIf(['Designation'], 'designation');

  const compensation = compensationTypeFromLabel(cellAt(row, indexMap, 'Compensation Status'));
  if (compensation) candidate.compensationType = compensation;

  if (candidate.email) candidate.email = normalizeEmail(candidate.email);
}

function parseMultiSheetExcel(fileBuffer) {
  const workbook = XLSX.read(fileBuffer, { type: 'buffer', cellDates: true });
  const detailsAoa = sheetAoa(workbook, SHEET_NAMES.details);
  if (!detailsAoa) {
    throw new ApiError(httpStatus.BAD_REQUEST, 'Missing required sheet: Employee Details');
  }
  if (detailsAoa.length < 2) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      'Employee Details sheet must have at least a header row and one data row'
    );
  }

  const headers = detailsAoa[0].map((h) => String(h || '').trim());
  const candidates = [];

  for (let i = 1; i < detailsAoa.length; i += 1) {
    const row = detailsAoa[i];
    if (!rowHasValues(row)) continue;
    const candidate = {
      sourceRow: i + 1,
      qualifications: [],
      experiences: [],
      skills: [],
      socialLinks: [],
      documents: [],
      salarySlips: [],
      _nested: { qualifications: false, experiences: false, skills: false, socialLinks: false, documents: false, salarySlips: false },
    };
    mergeDetailsRow(candidate, headers, row);
    candidates.push(candidate);
  }

  for (const sheetName of LEGACY_SUPPLEMENTAL_SHEETS) {
    if (!workbook.SheetNames.includes(sheetName)) continue;
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '', raw: true });
    if (data.length < 2) continue;
    const sh = data[0].map((h) => String(h || '').trim());
    const indexMap = headerIndexMap(sh);
    for (let i = 1; i < data.length; i += 1) {
      const row = data[i];
      if (!rowHasValues(row)) continue;
      const candidate = findCandidateByJoinKey(candidates, joinFromRow(indexMap, row));
      if (candidate) mergeDetailsRow(candidate, sh, row);
    }
  }

  const attach = (canonical, flag, build) => {
    const aoa = sheetAoa(workbook, canonical);
    if (!aoa || aoa.length < 2) return;
    const sh = aoa[0].map((h) => String(h || '').trim());
    const indexMap = headerIndexMap(sh);
    for (let i = 1; i < aoa.length; i += 1) {
      const row = aoa[i];
      if (!rowHasValues(row)) continue;
      const candidate = findCandidateByJoinKey(candidates, joinFromRow(indexMap, row));
      if (!candidate) continue;
      const item = build(row, indexMap);
      if (!item) continue;
      candidate[flag].push(item);
      candidate._nested[flag] = true;
    }
  };

  attach(SHEET_NAMES.qualifications, 'qualifications', (row, indexMap) => {
    const degree = strCell(cellAt(row, indexMap, 'Degree'));
    const institute = strCell(cellAt(row, indexMap, 'Institute'));
    if (!degree || !institute) return null;
    const startYear = strCell(cellAt(row, indexMap, 'Start Year', 'StartYear'));
    const endYear = strCell(cellAt(row, indexMap, 'End Year', 'EndYear'));
    return {
      degree,
      institute,
      location: strCell(cellAt(row, indexMap, 'Location')),
      startYear: startYear ? parseInt(startYear, 10) : null,
      endYear: endYear ? parseInt(endYear, 10) : null,
      description: strCell(cellAt(row, indexMap, 'Description')),
    };
  });

  attach(SHEET_NAMES.experience, 'experiences', (row, indexMap) => {
    const company = strCell(cellAt(row, indexMap, 'Company'));
    const role = strCell(cellAt(row, indexMap, 'Role'));
    if (!company || !role) return null;
    const currentlyWorking = parseCurrentlyWorking(cellAt(row, indexMap, 'Currently Working', 'CurrentlyWorking'));
    const startDateRaw = cellAt(row, indexMap, 'Start Date', 'StartDate');
    const endDateRaw = cellAt(row, indexMap, 'End Date', 'EndDate');
    const startDate = startDateRaw ? fmtIsoDate(startDateRaw) : '';
    const endDate = currentlyWorking ? '' : endDateRaw ? fmtIsoDate(endDateRaw) : '';
    return {
      company,
      role,
      startDate: startDate || null,
      endDate: endDate || null,
      currentlyWorking,
      description: strCell(cellAt(row, indexMap, 'Description')),
    };
  });

  attach(SHEET_NAMES.skills, 'skills', (row, indexMap) => {
    const name = strCell(cellAt(row, indexMap, 'Skill Name', 'SkillName', 'Name'));
    if (!name) return null;
    const levelRaw = strCell(cellAt(row, indexMap, 'Level')) || 'Beginner';
    return {
      name,
      level: SKILL_LEVELS.has(levelRaw) ? levelRaw : 'Beginner',
      category: strCell(cellAt(row, indexMap, 'Category')),
    };
  });

  attach(SHEET_NAMES.social, 'socialLinks', (row, indexMap) => {
    const platform = strCell(cellAt(row, indexMap, 'Platform'));
    const url = strCell(cellAt(row, indexMap, 'URL', 'Url'));
    if (!platform || !url) return null;
    return { platform, url };
  });

  attach(SHEET_NAMES.documents, 'documents', (row, indexMap) => {
    const label = strCell(cellAt(row, indexMap, 'Document Name', 'DocumentName', 'Label'));
    const type = strCell(cellAt(row, indexMap, 'Document Type', 'DocumentType', 'Type'));
    if (!label && !type) return null;
    return { label, type: type || 'Other' };
  });

  attach(SHEET_NAMES.salarySlips, 'salarySlips', (row, indexMap) => {
    const month = strCell(cellAt(row, indexMap, 'Month'));
    const yearRaw = strCell(cellAt(row, indexMap, 'Year'));
    if (!month && !yearRaw) return null;
    const parsedYear = Number(yearRaw);
    return {
      month,
      ...(Number.isFinite(parsedYear) ? { year: Math.trunc(parsedYear) } : {}),
    };
  });

  return candidates;
}

function validateCandidate(candidate, { isUpdate } = {}) {
  const errors = [];
  if (!isUpdate) {
    if (!candidate.fullName) errors.push('Full Name is required');
    if (!candidate.email) errors.push('Email is required');
    if (!candidate.phoneNumber) errors.push('Phone Number is required');
    if (!candidate.password) {
      errors.push('Password is required for new employees (8 characters, 1 capital letter, 1 number)');
    } else if (!isPasswordPolicyOk(candidate.password)) {
      errors.push('Password must be at least 8 characters with 1 capital letter and 1 number');
    }
  } else if (candidate.password && !isPasswordPolicyOk(candidate.password)) {
    errors.push('Password must be at least 8 characters with 1 capital letter and 1 number');
  }

  if (candidate.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.email)) {
    errors.push('Invalid email format');
  }

  if (candidate.phoneNumber) {
    const phoneValidation = validatePhoneForCountry(candidate.phoneNumber, candidate.countryCode || 'US');
    if (!phoneValidation.valid) errors.push(phoneValidation.error);
    else candidate.phoneNumber = phoneValidation.digits;
  }

  if (candidate.supervisorContact) {
    const supervisorPhoneValidation = validatePhoneForCountry(
      candidate.supervisorContact,
      candidate.supervisorCountryCode || candidate.countryCode || 'US'
    );
    if (!supervisorPhoneValidation.valid) errors.push(`Supervisor ${supervisorPhoneValidation.error}`);
    else candidate.supervisorContact = supervisorPhoneValidation.digits;
  }

  return {
    isValid: errors.length === 0,
    errors: errors.length > 0 ? errors.join(', ') : null,
  };
}

function buildMappedPayload(candidate, { isUpdate }) {
  const payload = {};
  const assign = (field, value) => {
    if (value !== undefined && value !== null && value !== '') payload[field] = value;
  };

  assign('fullName', candidate.fullName);
  assign('email', candidate.email);
  assign('phoneNumber', candidate.phoneNumber);
  assign('countryCode', candidate.countryCode || (isUpdate ? undefined : 'US'));
  assign('shortBio', candidate.shortBio);
  assign('sevisId', candidate.sevisId);
  assign('ead', candidate.ead);
  assign('degree', candidate.degree);
  if (candidate.visaType) payload.visaType = candidate.visaType;
  assign('customVisaType', candidate.customVisaType);
  assign('supervisorName', candidate.supervisorName);
  assign('supervisorContact', candidate.supervisorContact);
  assign('supervisorCountryCode', candidate.supervisorCountryCode);
  assign('salaryRange', candidate.salaryRange);
  assign('designation', candidate.designation);
  assign('compensationType', candidate.compensationType);

  const address = {
    streetAddress: candidate.streetAddress || '',
    streetAddress2: candidate.streetAddress2 || '',
    city: candidate.city || '',
    state: candidate.state || '',
    zipCode: candidate.zipCode || '',
    country: candidate.country || '',
  };
  if (!isUpdate || Object.values(address).some(Boolean)) {
    payload.address = address;
  }

  if (!isUpdate || candidate._nested.qualifications) payload.qualifications = candidate.qualifications;
  if (!isUpdate || candidate._nested.experiences) payload.experiences = candidate.experiences;
  if (!isUpdate || candidate._nested.skills) payload.skills = candidate.skills;
  if (!isUpdate || candidate._nested.socialLinks) payload.socialLinks = candidate.socialLinks;
  if (candidate._nested.documents) payload.documents = candidate.documents;
  if (candidate._nested.salarySlips) payload.salarySlips = candidate.salarySlips;

  if (!isUpdate) payload.password = candidate.password;
  return payload;
}

async function defaultFindEmployee(email, employeeId) {
  const normalized = normalizeEmail(email);
  if (normalized) {
    const byEmail = await Employee.findOne({ email: normalized });
    if (byEmail) return byEmail;
  }
  const id = String(employeeId || '').trim();
  if (id) {
    const byId = await Employee.findOne({ employeeId: id });
    if (byId) return byId;
  }
  return null;
}

function buildErrorWorkbookBuffer(failed) {
  const wb = XLSX.utils.book_new();
  const aoa = [
    ['Row', 'Full Name', 'Email', 'Error'],
    ...failed.map((f) => [f.row, f.fullName, f.email, f.error]),
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'Errors');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

async function importParsedCandidates(parsedCandidates, currentUser, deps = {}) {
  const create = deps.createCandidate || createCandidate;
  const update = deps.updateCandidateById || updateCandidateById;
  const findEmployee = deps.findEmployee || defaultFindEmployee;
  const createdBy = currentUser?.id || currentUser?._id;

  const results = {
    successful: [],
    failed: [],
    summary: {
      total: parsedCandidates.length,
      successful: 0,
      failed: 0,
      created: 0,
      updated: 0,
    },
  };

  for (let i = 0; i < parsedCandidates.length; i += 1) {
    const candidate = parsedCandidates[i];
    const row = candidate.sourceRow || i + 2;
    try {
      const existing = await findEmployee(candidate.email, candidate.employeeId);
      const isUpdate = Boolean(existing);
      const validation = validateCandidate(candidate, { isUpdate });
      if (!validation.isValid) throw new Error(validation.errors);

      const payload = buildMappedPayload(candidate, { isUpdate });
      let saved;
      let action;
      if (isUpdate) {
        saved = await update(existing.id || existing._id, payload, currentUser);
        if (candidate.password) {
          const ownerId = existing.owner?._id || existing.owner;
          if (ownerId) {
            const { updateUserById } = await import('./user.service.js');
            await updateUserById(ownerId, { password: candidate.password });
          }
        }
        action = 'updated';
        results.summary.updated += 1;
      } else {
        saved = await create(createdBy, payload);
        action = 'created';
        results.summary.created += 1;
      }

      results.successful.push({
        row,
        candidateId: saved.id || saved._id,
        fullName: saved.fullName || candidate.fullName,
        email: saved.email || candidate.email,
        action,
      });
      results.summary.successful += 1;
    } catch (error) {
      results.failed.push({
        row,
        fullName: candidate.fullName || 'Unknown',
        email: candidate.email || 'Unknown',
        error: error.message || 'Unknown error',
      });
      results.summary.failed += 1;
    }
  }

  if (results.failed.length) {
    results.errorWorkbookBase64 = Buffer.from(buildErrorWorkbookBuffer(results.failed)).toString('base64');
  }
  return results;
}

const importCandidatesFromExcel = async (fileBuffer, currentUser, deps) => {
  try {
    const parsedCandidates = parseMultiSheetExcel(fileBuffer);
    if (parsedCandidates.length === 0) {
      throw new ApiError(httpStatus.BAD_REQUEST, 'No employees found in Excel file');
    }
    return importParsedCandidates(parsedCandidates, currentUser, deps);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(httpStatus.BAD_REQUEST, `Failed to import employees: ${error.message}`);
  }
};

export {
  importCandidatesFromExcel,
  importParsedCandidates,
  parseMultiSheetExcel,
  validatePhoneForCountry,
  validateCandidate,
  buildErrorWorkbookBuffer,
};
