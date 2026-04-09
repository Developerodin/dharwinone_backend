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

/**
 * Multi-sheet workbook: summary + visa/supervisor + address + one row per nested item.
 * @param {{ totalCandidates: number, exportedAt: string, data: object[] }} exportData
 * @returns {Buffer}
 */
export function generateCandidateExportXlsxBuffer(exportData) {
  const wb = XLSX.utils.book_new();
  const list = exportData.data || [];

  const idRow = (c) => [s(c.employeeId), s(c.fullName), s(c.email)];

  const overviewHeader = [
    'Employee ID',
    'Full Name',
    'Email',
    'Phone Number',
    'Country Code',
    'Owner',
    'Owner Email',
    'Admin',
    'Admin Email',
    'Assigned Agent Name',
    'Assigned Agent Email',
    'Designation',
    'Position (catalog)',
    'Profile Completion %',
    'Status',
    'Created At',
    'Updated At',
  ];
  const overviewRows = list.map((c) => [
    s(c.employeeId),
    s(c.fullName),
    s(c.email),
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
    c.isProfileCompleted ?? '',
    c.isCompleted ? 'Completed' : 'Incomplete',
    fmtDate(c.createdAt),
    fmtDate(c.updatedAt),
  ]);
  const wsOverview = XLSX.utils.aoa_to_sheet([overviewHeader, ...overviewRows]);
  wsOverview['!cols'] = [
    { wch: 10 },
    { wch: 22 },
    { wch: 28 },
    { wch: 14 },
    { wch: 8 },
    { wch: 18 },
    { wch: 26 },
    { wch: 18 },
    { wch: 26 },
    { wch: 20 },
    { wch: 28 },
    { wch: 22 },
    { wch: 18 },
    { wch: 8 },
    { wch: 12 },
    { wch: 12 },
    { wch: 12 },
  ];
  XLSX.utils.book_append_sheet(wb, wsOverview, 'Overview');

  const visaHeader = [
    'Employee ID',
    'Full Name',
    'Email',
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
  ];
  const visaRows = list.map((c) => [
    s(c.employeeId),
    s(c.fullName),
    s(c.email),
    s(c.shortBio),
    s(c.sevisId),
    s(c.ead),
    s(c.degree),
    s(c.visaType),
    s(c.customVisaType),
    s(c.supervisorName),
    textPhone(c.supervisorContact),
    s(c.supervisorCountryCode),
    s(c.salaryRange),
  ]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([visaHeader, ...visaRows]), 'Visa and supervisor');

  const addrHeader = [
    'Employee ID',
    'Full Name',
    'Email',
    'Street Address',
    'Street Address 2',
    'City',
    'State',
    'Zip Code',
    'Country',
  ];
  const addrRows = list.map((c) => {
    const a = c.address || {};
    return [
      s(c.employeeId),
      s(c.fullName),
      s(c.email),
      s(a.streetAddress),
      s(a.streetAddress2),
      s(a.city),
      s(a.state),
      s(a.zipCode),
      s(a.country),
    ];
  });
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([addrHeader, ...addrRows]), 'Address');

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
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(qualRows.length ? [qualHeader, ...qualRows] : [qualHeader]),
    'Qualifications'
  );

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
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(expRows.length ? [expHeader, ...expRows] : [expHeader]),
    'Experience'
  );

  const skillHeader = ['Employee ID', 'Full Name', 'Email', 'Skill Name', 'Level', 'Category'];
  const skillRows = [];
  for (const c of list) {
    for (const sk of c.skills || []) {
      skillRows.push([...idRow(c), s(sk.name), s(sk.level), s(sk.category)]);
    }
  }
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(skillRows.length ? [skillHeader, ...skillRows] : [skillHeader]),
    'Skills'
  );

  const socialHeader = ['Employee ID', 'Full Name', 'Email', 'Platform', 'URL'];
  const socialRows = [];
  for (const c of list) {
    for (const sl of c.socialLinks || []) {
      socialRows.push([...idRow(c), s(sl.platform), s(sl.url)]);
    }
  }
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(socialRows.length ? [socialHeader, ...socialRows] : [socialHeader]),
    'Social Links'
  );

  const docHeader = ['Employee ID', 'Full Name', 'Email', 'Label', 'Original Name', 'Size', 'Mime Type'];
  const docRows = [];
  for (const c of list) {
    for (const d of c.documents || []) {
      docRows.push([
        ...idRow(c),
        s(d.label),
        s(d.originalName),
        d.size != null ? s(d.size) : '',
        s(d.mimeType),
      ]);
    }
  }
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(docRows.length ? [docHeader, ...docRows] : [docHeader]),
    'Documents'
  );

  const slipHeader = ['Employee ID', 'Full Name', 'Email', 'Month', 'Year', 'Original Name'];
  const slipRows = [];
  for (const c of list) {
    for (const ss of c.salarySlips || []) {
      slipRows.push([...idRow(c), s(ss.month), s(ss.year), s(ss.originalName)]);
    }
  }
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(slipRows.length ? [slipHeader, ...slipRows] : [slipHeader]),
    'Salary Slips'
  );

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
