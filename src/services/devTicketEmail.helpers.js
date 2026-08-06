import {
  DEFAULT_TESTER_EMAIL,
  PLATFORM_ASSIGNEE_EMAILS,
  PLATFORM_LABELS,
} from '../models/devTicket.model.js';

export { DEFAULT_TESTER_EMAIL, PLATFORM_ASSIGNEE_EMAILS, PLATFORM_LABELS };

/** Format a user ref for display in emails (never raw ObjectId when name/email known). */
export const formatUserRef = (user) => {
  if (user == null || user === '') return '(empty)';
  if (typeof user === 'string') {
    const t = user.trim();
    return t || '(empty)';
  }
  const name = user.name?.trim();
  const email = user.email?.trim();
  if (name && email) return `${name} <${email}>`;
  return name || email || '(empty)';
};

/** Platform-scoped developer email from ticket (sync — uses map when assignee not populated). */
export const resolvePlatformEmailFromTicket = (ticket = {}) => {
  const populated = ticket.assignedTo;
  if (populated?.email) return populated.email;
  const platform = ticket.platform || 'web';
  return PLATFORM_ASSIGNEE_EMAILS[platform] || PLATFORM_ASSIGNEE_EMAILS.web;
};

/**
 * Recipients for dev-ticket assign/update emails: platform developer + tester (deduped).
 * @returns {{ email: string, role: 'developer' | 'tester' }[]}
 */
export const buildDevTicketEmailRecipients = (ticket = {}, options = {}) => {
  const testerEmail = options.testerEmail || DEFAULT_TESTER_EMAIL;
  const platformEmail = options.platformEmail || resolvePlatformEmailFromTicket(ticket);
  const seen = new Set();
  const out = [];

  const add = (email, role) => {
    const norm = String(email || '').trim().toLowerCase();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push({ email: String(email).trim(), role });
  };

  add(platformEmail, 'developer');
  add(testerEmail, 'tester');
  return out;
};

export const buildAssignedIntroLines = ({ role = 'developer', platformLabel = 'Web', actorName = 'Someone' }) => {
  if (role === 'tester') {
    return [
      `You are the tester on this dev ticket (Platform: ${platformLabel}).`,
      `${actorName} created or updated this ticket. Full details are below.`,
    ];
  }
  return [
    `A development ticket was assigned to you for the ${platformLabel} platform.`,
    `${actorName} created or assigned this ticket. Full details are below.`,
  ];
};

export const buildUpdatedIntroLines = ({
  role = 'developer',
  actorName = 'Someone',
  ticketId = '',
  platformLabel = 'Web',
}) => {
  if (role === 'tester') {
    return [
      `${actorName} updated ticket ${ticketId} (Platform: ${platformLabel}).`,
      'You are receiving this as the tester. Changes are listed below.',
    ];
  }
  return [
    `${actorName} updated ticket ${ticketId}.`,
    'Changes are listed below.',
  ];
};

export const buildAttachmentSectionBody = ({ linkCount = 0, mailAttachCount = 0 } = {}) => {
  if (!linkCount) return ['No attachments on this ticket.'];
  const lines = ['Each file below is a direct download link (valid for 7 days).'];
  if (mailAttachCount > 0) {
    lines.push('The same files are also attached to this email.');
  } else {
    lines.push('Files could not be attached to this email; use the download links below.');
  }
  return lines;
};

const OBJECT_ID_RE = /^[0-9a-fA-F]{24}$/;

export const humanizeAssigneeDiffValue = (value, userById = {}) => {
  if (value == null || value === '' || value === '(empty)') return '(empty)';
  const s = String(value);
  if (OBJECT_ID_RE.test(s) && userById[s]) {
    return formatUserRef(userById[s]);
  }
  return s;
};

export const humanizeDiffRows = (rows = [], userById = {}) =>
  rows.map((row) => {
    if (row.field !== 'Assignee') return row;
    return {
      ...row,
      from: humanizeAssigneeDiffValue(row.from, userById),
      to: humanizeAssigneeDiffValue(row.to, userById),
    };
  });

export const platformLabelFor = (platform) => PLATFORM_LABELS[platform] || platform || 'Web';
