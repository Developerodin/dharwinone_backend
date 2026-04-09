/**
 * RFC 4180-style CSV cells: always quoted, " escaped as "".
 * @param {unknown} value
 * @returns {string}
 */
export function csvCell(value) {
  if (value === null || value === undefined) {
    return '""';
  }
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Phone as a normal quoted cell (avoids fragile ="" Excel formulas inside CSV).
 * @param {string} digits
 */
export function csvPhoneCell(digits) {
  const d = digits == null ? '' : String(digits).replace(/\D/g, '');
  return csvCell(d);
}

/**
 * @param {{ totalCandidates: number, exportedAt: string, data: object[] }} exportData
 */
export function generateCandidateExportCsv(exportData) {
  const headers = [
    'Employee ID',
    'Full Name',
    'Email',
    'Phone Number',
    'Short Bio',
    'SEVIS ID',
    'EAD',
    'Visa Type',
    'Custom Visa Type',
    'Country Code',
    'Degree',
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
    'Qualifications',
    'Experiences',
    'Skills',
    'Social Links',
    'Documents',
    'Salary Slips',
  ];

  const rows = exportData.data.map((candidate) => {
    const qualStr = (candidate.qualifications || [])
      .map((q) => `${q.degree} - ${q.institute}`)
      .join('; ');
    const expStr = (candidate.experiences || [])
      .map((e) => `${e.role} @ ${e.company}${e.currentlyWorking ? ' (Currently Working)' : ''}`)
      .join('; ');
    const skillsStr = (candidate.skills || []).map((s) => `${s.name} (${s.level})`).join('; ');
    const socialStr = (candidate.socialLinks || []).map((sl) => `${sl.platform}: ${sl.url}`).join('; ');
    const docsStr = (candidate.documents || []).map((d) => d.label || d.originalName).join('; ');
    const slipsStr = (candidate.salarySlips || []).map((ss) => `${ss.month} ${ss.year}`).join('; ');

    return [
      csvCell(candidate.employeeId || ''),
      csvCell(candidate.fullName || ''),
      csvCell(candidate.email || ''),
      csvPhoneCell(candidate.phoneNumber || ''),
      csvCell(candidate.shortBio || ''),
      csvCell(candidate.sevisId || ''),
      csvCell(candidate.ead || ''),
      csvCell(candidate.visaType || ''),
      csvCell(candidate.customVisaType || ''),
      csvCell(candidate.countryCode || ''),
      csvCell(candidate.degree || ''),
      csvCell(candidate.supervisorName || ''),
      csvPhoneCell(candidate.supervisorContact || ''),
      csvCell(candidate.supervisorCountryCode || ''),
      csvCell(candidate.salaryRange || ''),
      csvCell(candidate.address?.streetAddress || ''),
      csvCell(candidate.address?.streetAddress2 || ''),
      csvCell(candidate.address?.city || ''),
      csvCell(candidate.address?.state || ''),
      csvCell(candidate.address?.zipCode || ''),
      csvCell(candidate.address?.country || ''),
      csvCell(candidate.owner || ''),
      csvCell(candidate.ownerEmail || ''),
      csvCell(candidate.adminId || ''),
      csvCell(candidate.adminEmail || ''),
      csvCell(candidate.assignedAgentName || ''),
      csvCell(candidate.assignedAgentEmail || ''),
      csvCell(candidate.designation || ''),
      csvCell(candidate.positionTitle || ''),
      csvCell(candidate.isProfileCompleted ?? 0),
      csvCell(candidate.isCompleted ? 'Completed' : 'Incomplete'),
      csvCell(candidate.createdAt ? new Date(candidate.createdAt).toLocaleDateString() : ''),
      csvCell(candidate.updatedAt ? new Date(candidate.updatedAt).toLocaleDateString() : ''),
      csvCell(qualStr),
      csvCell(expStr),
      csvCell(skillsStr),
      csvCell(socialStr),
      csvCell(docsStr),
      csvCell(slipsStr),
    ];
  });

  const headerLine = headers.map(csvCell).join(',');
  const bodyLines = rows.map((row) => row.join(','));
  return [headerLine, ...bodyLines].join('\n');
}
