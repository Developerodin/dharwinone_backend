import XLSX from 'xlsx';
import { eadDisplayValue } from './eadDisplayValue.js';
import {
  DOCUMENTS_HEADERS,
  DOCUMENTS_NOTE,
  EMPLOYEE_DETAILS_HEADERS,
  EXPERIENCE_HEADERS,
  QUALIFICATIONS_HEADERS,
  SALARY_SLIPS_HEADERS,
  SHEET_NAMES,
  SKILLS_HEADERS,
  SOCIAL_HEADERS,
  exportCompensationStatusCell,
  exportEmploymentStatusCell,
  fmtIsoDate,
} from './candidateExcelContract.js';

function s(v) {
  if (v === null || v === undefined) return '';
  return String(v);
}

/** Excel often shows long numeric phones as scientific notation; force text. */
function textPhone(v) {
  const d = v == null ? '' : String(v).replace(/\D/g, '');
  if (!d) return '';
  return `\u200B${d}`;
}

function docUploadStatus(d) {
  return d.url || d.key ? 'Uploaded' : 'Missing';
}

/** Shared minimum widths for employee identity columns repeated on nested sheets. */
export const COMMON_SHEET_MIN_COL_WIDTHS = {
  'Employee ID': 12,
  'Full Name': 20,
  Email: 32,
};

/** Minimum column widths for the Employee Details sheet (header row + data). */
export const EMPLOYEE_DETAILS_MIN_COL_WIDTHS = {
  ...COMMON_SHEET_MIN_COL_WIDTHS,
  'Phone Number': 14,
  'Country Code': 12,
  Owner: 20,
  'Owner Email': 32,
  Admin: 20,
  'Admin Email': 32,
  'Assigned Agent Name': 22,
  'Assigned Agent Email': 32,
  Designation: 18,
  Position: 22,
  'Compensation Status': 18,
  'Employment Status': 18,
  'Profile Completion %': 22,
  'Profile Status': 16,
  Password: 12,
  'Short Bio': 30,
  'SEVIS ID': 14,
  EAD: 14,
  Degree: 16,
  'Visa Type': 14,
  'Custom Visa Type': 18,
  'Supervisor Name': 20,
  'Supervisor Contact': 14,
  'Supervisor Country Code': 14,
  'Salary Range': 16,
  'Street Address': 24,
  'Street Address 2': 20,
  City: 16,
  State: 12,
  'Zip Code': 12,
  Country: 14,
  'Created At': 14,
  'Updated At': 14,
};

/**
 * Size each column to the longest header/data value, with optional per-header floors.
 * Mirrors meetingExcel.service.js so long emails and status labels are not truncated.
 *
 * @param {Array<Array<unknown>>} aoa
 * @param {Record<string, number>} [minByHeader]
 * @returns {Array<{ wch: number }>}
 */
export function columnWidthsFromAoa(aoa, minByHeader = {}) {
  const headers = aoa[0] || [];
  return headers.map((header, col) => {
    const headerText = String(header ?? '');
    const longest = aoa.reduce((max, row) => {
      const len = String(row[col] ?? '').length;
      return len > max ? len : max;
    }, headerText.length);
    const min = minByHeader[headerText] ?? 10;
    return { wch: Math.min(Math.max(longest + 2, min), 60) };
  });
}

/**
 * Apply column widths and header-row autofilter to a list sheet.
 * Community xlsx does not emit freeze panes or cell styles (bold), so those are omitted.
 *
 * @param {import('xlsx').WorkSheet} ws
 * @param {Array<Array<unknown>>} aoa
 * @param {Record<string, number>} [minByHeader]
 */
export function applyExportSheetFormatting(ws, aoa, minByHeader = {}) {
  ws['!cols'] = columnWidthsFromAoa(aoa, minByHeader);
  if (!aoa.length) return;
  const lastCol = XLSX.utils.encode_col((aoa[0]?.length ?? 1) - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}${aoa.length}` };
}

/**
 * Multi-sheet workbook: summary + visa/supervisor + address + one row per nested item.
 * @param {{ totalCandidates: number, exportedAt: string, data: object[] }} exportData
 * @returns {Buffer}
 */
export function generateCandidateExportXlsxBuffer(exportData) {
  const wb = XLSX.utils.book_new();
  const list = exportData.data || [];
  const employmentFilterScope = exportData.employmentStatusFilter;

  const idRow = (c) => [s(c.employeeId), s(c.fullName), s(c.email)];

  const detailsRows = list.map((c) => {
    const a = c.address || {};
    return [
      s(c.employeeId),
      s(c.fullName),
      s(c.email),
      '',
      textPhone(c.phoneNumber),
      s(c.countryCode),
      s(c.owner),
      s(c.ownerEmail),
      s(c.adminId),
      s(c.adminEmail),
      s(c.assignedAgentName),
      s(c.assignedAgentEmail),
      s(c.designation),
      s(c.positionTitle),
      exportCompensationStatusCell(c),
      exportEmploymentStatusCell(c, employmentFilterScope),
      c.isProfileCompleted ?? '',
      c.isCompleted ? 'Completed' : 'Incomplete',
      s(c.shortBio),
      s(c.sevisId),
      s(eadDisplayValue(c)),
      s(c.degree),
      s(c.visaType),
      s(c.customVisaType),
      s(c.supervisorName),
      textPhone(c.supervisorContact),
      s(c.supervisorCountryCode),
      s(c.salaryRange),
      s(a.streetAddress),
      s(a.streetAddress2),
      s(a.city),
      s(a.state),
      s(a.zipCode),
      s(a.country),
      fmtIsoDate(c.createdAt),
      fmtIsoDate(c.updatedAt),
    ];
  });
  const detailsAoa = [EMPLOYEE_DETAILS_HEADERS.slice(), ...detailsRows];
  const wsDetails = XLSX.utils.aoa_to_sheet(detailsAoa);
  applyExportSheetFormatting(wsDetails, detailsAoa, EMPLOYEE_DETAILS_MIN_COL_WIDTHS);
  XLSX.utils.book_append_sheet(wb, wsDetails, SHEET_NAMES.details);

  const qualRows = [];
  for (const c of list) {
    for (const q of c.qualifications || []) {
      qualRows.push([
        ...idRow(c),
        s(q.degree),
        s(q.institute),
        s(q.location),
        s(q.startYear),
        s(q.endYear),
        s(q.description),
      ]);
    }
  }
  const qualAoa = [QUALIFICATIONS_HEADERS.slice(), ...qualRows];
  const wsQual = XLSX.utils.aoa_to_sheet(qualAoa);
  applyExportSheetFormatting(wsQual, qualAoa, { ...COMMON_SHEET_MIN_COL_WIDTHS, Description: 30 });
  XLSX.utils.book_append_sheet(wb, wsQual, SHEET_NAMES.qualifications);

  const expRows = [];
  for (const c of list) {
    for (const e of c.experiences || []) {
      expRows.push([
        ...idRow(c),
        s(e.company),
        s(e.role),
        s(e.startDate),
        s(e.endDate),
        e.currentlyWorking ? 'Yes' : 'No',
        s(e.description),
      ]);
    }
  }
  const expAoa = [EXPERIENCE_HEADERS.slice(), ...expRows];
  const wsExp = XLSX.utils.aoa_to_sheet(expAoa);
  applyExportSheetFormatting(wsExp, expAoa, { ...COMMON_SHEET_MIN_COL_WIDTHS, Description: 30 });
  XLSX.utils.book_append_sheet(wb, wsExp, SHEET_NAMES.experience);

  const skillRows = [];
  for (const c of list) {
    for (const sk of c.skills || []) {
      skillRows.push([...idRow(c), s(sk.name), s(sk.level), s(sk.category)]);
    }
  }
  const skillAoa = [SKILLS_HEADERS.slice(), ...skillRows];
  const wsSkill = XLSX.utils.aoa_to_sheet(skillAoa);
  applyExportSheetFormatting(wsSkill, skillAoa, COMMON_SHEET_MIN_COL_WIDTHS);
  XLSX.utils.book_append_sheet(wb, wsSkill, SHEET_NAMES.skills);

  const socialRows = [];
  for (const c of list) {
    for (const sl of c.socialLinks || []) {
      socialRows.push([...idRow(c), s(sl.platform), s(sl.url)]);
    }
  }
  const socialAoa = [SOCIAL_HEADERS.slice(), ...socialRows];
  const wsSocial = XLSX.utils.aoa_to_sheet(socialAoa);
  applyExportSheetFormatting(wsSocial, socialAoa, { ...COMMON_SHEET_MIN_COL_WIDTHS, URL: 40 });
  XLSX.utils.book_append_sheet(wb, wsSocial, SHEET_NAMES.social);

  const docRows = [];
  for (const c of list) {
    for (const d of c.documents || []) {
      docRows.push([
        ...idRow(c),
        s(d.label || d.originalName),
        s(d.type),
        docUploadStatus(d),
        s(d.mimeType),
        DOCUMENTS_NOTE,
      ]);
    }
  }
  const docAoa = [DOCUMENTS_HEADERS.slice(), ...docRows];
  const wsDoc = XLSX.utils.aoa_to_sheet(docAoa);
  applyExportSheetFormatting(wsDoc, docAoa, { ...COMMON_SHEET_MIN_COL_WIDTHS, Note: 20 });
  XLSX.utils.book_append_sheet(wb, wsDoc, SHEET_NAMES.documents);

  const slipRows = [];
  for (const c of list) {
    for (const ss of c.salarySlips || []) {
      slipRows.push([...idRow(c), s(ss.month), s(ss.year)]);
    }
  }
  const slipAoa = [SALARY_SLIPS_HEADERS.slice(), ...slipRows];
  const wsSlip = XLSX.utils.aoa_to_sheet(slipAoa);
  applyExportSheetFormatting(wsSlip, slipAoa, COMMON_SHEET_MIN_COL_WIDTHS);
  XLSX.utils.book_append_sheet(wb, wsSlip, SHEET_NAMES.salarySlips);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
