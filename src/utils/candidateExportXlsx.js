import XLSX from 'xlsx';

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

function fmtDate(d) {
  if (!d) return '';
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return s(d);
  }
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
  'Position (catalog)': 22,
  'Profile Completion %': 22,
  Status: 14,
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

  const idRow = (c) => [s(c.employeeId), s(c.fullName), s(c.email)];

  const detailsHeader = [
    'Employee ID', 'Full Name', 'Email', 'Phone Number', 'Country Code',
    'Owner', 'Owner Email', 'Admin', 'Admin Email',
    'Assigned Agent Name', 'Assigned Agent Email',
    'Designation', 'Position (catalog)', 'Profile Completion %', 'Status',
    'Short Bio', 'SEVIS ID', 'EAD', 'Degree', 'Visa Type', 'Custom Visa Type',
    'Supervisor Name', 'Supervisor Contact', 'Supervisor Country Code', 'Salary Range',
    'Street Address', 'Street Address 2', 'City', 'State', 'Zip Code', 'Country',
    'Created At', 'Updated At',
  ];
  const detailsRows = list.map((c) => {
    const a = c.address || {};
    return [
      s(c.employeeId), s(c.fullName), s(c.email), textPhone(c.phoneNumber), s(c.countryCode),
      s(c.owner), s(c.ownerEmail), s(c.adminId), s(c.adminEmail),
      s(c.assignedAgentName), s(c.assignedAgentEmail),
      s(c.designation), s(c.positionTitle), c.isProfileCompleted ?? '', c.isCompleted ? 'Completed' : 'Incomplete',
      s(c.shortBio), s(c.sevisId), s(c.ead), s(c.degree), s(c.visaType), s(c.customVisaType),
      s(c.supervisorName), textPhone(c.supervisorContact), s(c.supervisorCountryCode), s(c.salaryRange),
      s(a.streetAddress), s(a.streetAddress2), s(a.city), s(a.state), s(a.zipCode), s(a.country),
      fmtDate(c.createdAt), fmtDate(c.updatedAt),
    ];
  });
  const detailsAoa = [detailsHeader, ...detailsRows];
  const wsDetails = XLSX.utils.aoa_to_sheet(detailsAoa);
  applyExportSheetFormatting(wsDetails, detailsAoa, EMPLOYEE_DETAILS_MIN_COL_WIDTHS);
  XLSX.utils.book_append_sheet(wb, wsDetails, 'Employee Details');

  const qualHeader = [
    'Employee ID',
    'Full Name',
    'Email',
    'Degree',
    'Institute',
    'Location',
    'Start Year',
    'End Year',
    'Description',
  ];
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
  const qualAoa = qualRows.length ? [qualHeader, ...qualRows] : [qualHeader];
  const wsQual = XLSX.utils.aoa_to_sheet(qualAoa);
  applyExportSheetFormatting(wsQual, qualAoa, { ...COMMON_SHEET_MIN_COL_WIDTHS, Description: 30 });
  XLSX.utils.book_append_sheet(wb, wsQual, 'Qualifications');

  const expHeader = [
    'Employee ID',
    'Full Name',
    'Email',
    'Company',
    'Role',
    'Start Date',
    'End Date',
    'Currently Working',
    'Description',
  ];
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
  const expAoa = expRows.length ? [expHeader, ...expRows] : [expHeader];
  const wsExp = XLSX.utils.aoa_to_sheet(expAoa);
  applyExportSheetFormatting(wsExp, expAoa, { ...COMMON_SHEET_MIN_COL_WIDTHS, Description: 30 });
  XLSX.utils.book_append_sheet(wb, wsExp, 'Experience');

  const skillHeader = ['Employee ID', 'Full Name', 'Email', 'Skill Name', 'Level', 'Category'];
  const skillRows = [];
  for (const c of list) {
    for (const sk of c.skills || []) {
      skillRows.push([...idRow(c), s(sk.name), s(sk.level), s(sk.category)]);
    }
  }
  const skillAoa = skillRows.length ? [skillHeader, ...skillRows] : [skillHeader];
  const wsSkill = XLSX.utils.aoa_to_sheet(skillAoa);
  applyExportSheetFormatting(wsSkill, skillAoa, COMMON_SHEET_MIN_COL_WIDTHS);
  XLSX.utils.book_append_sheet(wb, wsSkill, 'Skills');

  const socialHeader = ['Employee ID', 'Full Name', 'Email', 'Platform', 'URL'];
  const socialRows = [];
  for (const c of list) {
    for (const sl of c.socialLinks || []) {
      socialRows.push([...idRow(c), s(sl.platform), s(sl.url)]);
    }
  }
  const socialAoa = socialRows.length ? [socialHeader, ...socialRows] : [socialHeader];
  const wsSocial = XLSX.utils.aoa_to_sheet(socialAoa);
  applyExportSheetFormatting(wsSocial, socialAoa, { ...COMMON_SHEET_MIN_COL_WIDTHS, URL: 40 });
  XLSX.utils.book_append_sheet(wb, wsSocial, 'Social Links');

  const docHeader = [
    'Employee ID', 'Full Name', 'Email',
    'Document Name', 'Document Type', 'Upload Status', 'Mime Type',
  ];
  const docRows = [];
  for (const c of list) {
    for (const d of c.documents || []) {
      docRows.push([
        ...idRow(c),
        s(d.label || d.originalName),
        s(d.type),
        docUploadStatus(d),
        s(d.mimeType),
      ]);
    }
  }
  const docAoa = docRows.length ? [docHeader, ...docRows] : [docHeader];
  const wsDoc = XLSX.utils.aoa_to_sheet(docAoa);
  applyExportSheetFormatting(wsDoc, docAoa, COMMON_SHEET_MIN_COL_WIDTHS);
  XLSX.utils.book_append_sheet(wb, wsDoc, 'Documents');

  const slipHeader = ['Employee ID', 'Full Name', 'Email', 'Month', 'Year'];
  const slipRows = [];
  for (const c of list) {
    for (const ss of c.salarySlips || []) {
      slipRows.push([...idRow(c), s(ss.month), s(ss.year)]);
    }
  }
  const slipAoa = slipRows.length ? [slipHeader, ...slipRows] : [slipHeader];
  const wsSlip = XLSX.utils.aoa_to_sheet(slipAoa);
  applyExportSheetFormatting(wsSlip, slipAoa, COMMON_SHEET_MIN_COL_WIDTHS);
  XLSX.utils.book_append_sheet(wb, wsSlip, 'Salary Slips');

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
