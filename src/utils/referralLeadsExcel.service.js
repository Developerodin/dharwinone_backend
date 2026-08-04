import XLSX from 'xlsx';

const LINK_TYPE_LABELS = {
  SHARE_CANDIDATE_ONBOARD: 'Onboard invite',
  JOB_APPLY: 'Job link',
};

const STATUS_LABELS = {
  profile_complete: 'Profile complete',
  pending: 'Pending',
  applied: 'Applied',
  in_review: 'Interview',
  interview: 'Interview',
  offer: 'Offer',
  preboarding: 'Preboarding',
  deferred: 'Deferred',
  hired: 'Hired',
  joined: 'Joined',
  employee: 'Employee',
  resigned: 'Resigned',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
  job_removed: 'Job removed',
};

/** A leading =, +, -, or @ is quoted so Excel treats the cell as text, not a formula. */
function defangCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

/** Format a date value as "YYYY-MM-DD HH:mm" UTC (empty for missing/invalid). */
function fmtDateTime(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 16).replace('T', ' ');
}

/** Date-only UTC column (joining date). */
function fmtDate(d) {
  if (!d) return '';
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

function statusLabel(key) {
  return STATUS_LABELS[key] || STATUS_LABELS.pending;
}

function linkTypeLabel(ctx) {
  if (!ctx) return '';
  return LINK_TYPE_LABELS[ctx] || String(ctx);
}

export const REFERRAL_LEADS_EXPORT_HEADERS = [
  'Candidate Name',
  'Candidate Email',
  'Referred By Name',
  'Referred By Email',
  'Link Type',
  'Job Title',
  'Status',
  'Assigned Sales Agent Name',
  'Assigned Sales Agent Email',
  'Joining Date',
  'Claimed At (UTC)',
];

/**
 * Build an in-memory .xlsx workbook of referral leads.
 * Rows must be shaped via shapeLeadRow so status/job/referrer match the ATS table.
 *
 * @param {Array<Record<string, any>>} shapedRows
 * @returns {Buffer}
 */
export function buildReferralLeadsExportBuffer(shapedRows = []) {
  const headers = REFERRAL_LEADS_EXPORT_HEADERS;
  const aoa = [headers];

  for (const r of shapedRows) {
    const anonymised = r.referralAttributionAnonymised === true;
    aoa.push(
      [
        r.fullName || '',
        r.email || '',
        anonymised ? 'Anonymised' : r.referredBy?.name || '',
        anonymised ? '' : r.referredBy?.email || '',
        linkTypeLabel(r.referralContext),
        r.job?.title || '',
        statusLabel(r.referralPipelineStatus),
        r.salesAgent?.name || '',
        r.salesAgent?.email || '',
        fmtDate(r.joiningDate),
        fmtDateTime(r.referredAt || r.createdAt),
      ].map(defangCell)
    );
  }

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  ws['!cols'] = headers.map((h, col) => {
    const longest = aoa.reduce((max, row) => {
      const len = String(row[col] ?? '').length;
      return len > max ? len : max;
    }, h.length);
    return { wch: Math.min(Math.max(longest + 2, 10), 60) };
  });

  const lastCol = XLSX.utils.encode_col(headers.length - 1);
  ws['!autofilter'] = { ref: `A1:${lastCol}${aoa.length}` };

  XLSX.utils.book_append_sheet(wb, ws, 'Referral Leads');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
