// Conversation policy — structured resolver facts → natural HR-assistant prose.
// Resolvers return facts; this module owns all user-facing wording.

/**
 * @param {{ kind:'user'|'role', name:string, roles?:string[] }} m
 */
function describeEntityOption(m) {
  if (m.kind === 'role') return `the **${m.name}** role`;
  return `**${m.name}**, the user`;
}

/**
 * @param {string[]} parts
 * @param {{ oxford?: boolean }} [opts]
 */
function joinOr(parts, opts = {}) {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) {
    return opts.oxford ? `${parts[0]}, or ${parts[1]}` : `${parts[0]} or ${parts[1]}`;
  }
  return `${parts.slice(0, -1).join(', ')}, or ${parts[parts.length - 1]}`;
}

/**
 * @param {{ query?:string, matches:{ kind:'user'|'role', name:string, roles?:string[] }[] }} facts
 */
/**
 * @param {{ query?: string, jobMatches?: { title: string }[], employeeMatches?: { name?: string }[] }} facts
 */
export function renderTitleAmbiguity(facts) {
  const title = facts.query || facts.jobMatches?.[0]?.title || 'that title';
  const jobCount = facts.jobMatches?.length ?? 0;
  const empCount = facts.employeeMatches?.length ?? 0;
  const jobLabel = jobCount === 1 ? 'a job' : `${jobCount} jobs`;
  const empLabel = empCount === 1 ? 'an employee' : `${empCount} employees`;
  return (
    `I found both ${jobLabel} called **${title}** and ${empLabel} with that position. ` +
    'Were you asking about the **job posting** or the **employees**?'
  );
}

export function renderAmbiguousEntity(facts) {
  const matches = facts.matches || [];
  const options = matches.map(describeEntityOption);
  const allUsers = matches.length > 0 && matches.every((m) => m.kind === 'user');

  if (allUsers && matches.length === 2) {
    const names = matches.map((m) => `**${m.name}**`);
    return `Which one do you mean — ${names[0]} or ${names[1]}?`;
  }

  return `Do you mean ${joinOr(options, { oxford: true })}?`;
}

/**
 * @param {{ query?:string, matches:{ name:string, roles?:string[] }[] }} facts
 */
export function renderPersonDisambiguation(facts) {
  const matches = facts.matches || [];
  const names = matches.map((m) => `**${m.name}**`);

  if (names.length === 2) {
    return `Which one do you mean — ${names[0]} or ${names[1]}?`;
  }
  return `Which one do you mean — ${joinOr(names)}?`;
}

function formatDate(v) {
  if (!v) return null;
  const t = new Date(v);
  if (Number.isNaN(t.getTime())) return null;
  return t.toISOString().slice(0, 10);
}

/**
 * @param {import('../roleProfile/index.js').resolveRoleProfile extends (...args:any)=>infer R ? Awaited<R> : never} profile
 */
export function renderRoleProfile(profile) {
  if (profile.kind === 'notFound') return "I couldn't find that role.";

  const r = profile.role;
  const roleName = r.name || 'That role';
  const sentences = [];

  const detailBits = [];
  if (r.status) detailBits.push(`${r.status}`);
  if (Array.isArray(r.permissions) && r.permissions.length) {
    detailBits.push(`${r.permissions.length} permission${r.permissions.length === 1 ? '' : 's'} configured`);
  }
  if (r.aliases?.length) detailBits.push(`also known as ${r.aliases.join(', ')}`);

  const count = profile.assignedCount ?? 0;
  const userLabel = count === 1 ? '1 user' : `${count} users`;

  if (detailBits.length) {
    sentences.push(`The **${roleName}** role is ${detailBits.join(', ')}.`);
  }

  if (count > 0) {
    sentences.push(`The **${roleName}** role is currently assigned to ${userLabel}.`);
  } else {
    sentences.push(`The **${roleName}** role doesn't have any users assigned right now.`);
  }

  const hasRichDetail =
    detailBits.length > 0 ||
    r.slug ||
    r.previousNames?.length ||
    formatDate(r.createdAt) ||
    formatDate(r.updatedAt);

  if (!hasRichDetail) {
    sentences.push("That's all the information I have about the role itself.");
  }

  return sentences.join(' ');
}

function formatFieldValue(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'object' && v.name) return String(v.name);
  return String(v);
}

function fieldSentence(key, val, personName) {
  const readable = key
    .replace(/([A-Z])/g, ' $1')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim();
  if (readable === 'email') return `You can reach them at ${val}.`;
  if (readable === 'phone' || readable === 'mobile') return `Their phone number is ${val}.`;
  return `Their ${readable} is ${val}.`;
}

function roleIntro(name, roleList) {
  if (!roleList.length) return `Here's what I know about **${name}**.`;
  if (roleList.length === 1) return `**${name}** works as a ${roleList[0]}.`;
  return `**${name}** works as ${joinOr(roleList.map((r) => `a ${r}`))}.`;
}

function primaryProfile(profile) {
  return Object.values(profile.profiles || {})[0];
}

/**
 * Brief confirmation after disambiguation — no table, 2–3 facts max.
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 */
export function renderPersonProfileAcknowledgment(profile) {
  if (profile.kind !== 'unique') {
    return { text: renderPersonProfile(profile), usedFields: [] };
  }

  const primary = primaryProfile(profile);
  const { name, roles } = profile.identity;
  const roleList = roles?.length ? roles : [];
  const parts = [`Got it — ${roleIntro(name, roleList).replace(/\.$/, '')}.`];
  const usedFields = ['name', 'roles'];

  for (const k of primary?.summaryFields || []) {
    if (usedFields.length >= 4) break;
    const val = formatFieldValue(primary?.fields?.[k]);
    if (val) {
      parts.push(fieldSentence(k, val, name));
      usedFields.push(k);
    }
  }

  return { text: parts.join(' '), usedFields };
}

/**
 * Remaining facts not yet communicated — natural prose only.
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 * @param {string[]} communicatedFields
 */
export function renderPersonProfileDelta(profile, communicatedFields = []) {
  if (profile.kind !== 'unique') {
    return { text: renderPersonProfile(profile), usedFields: [] };
  }

  const communicated = new Set(communicatedFields || []);
  const { name } = profile.identity;
  const parts = [];
  const usedFields = [];

  for (const p of Object.values(profile.profiles || {})) {
    for (const k of p.visibleFields || []) {
      if (communicated.has(k) || k === 'name' || k === 'roles') continue;
      const val = formatFieldValue(p.fields?.[k]);
      if (!val) continue;
      parts.push(fieldSentence(k, val, name));
      usedFields.push(k);
    }
  }

  if (!parts.length) {
    return {
      text: `That's everything I have on **${name}** right now.`,
      usedFields: [],
    };
  }

  return {
    text: `A few more things about **${name}**: ${parts.join(' ')}`,
    usedFields,
  };
}

/**
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 * @param {string|null} fieldKey
 */
export function renderPersonProfileSingleFact(profile, fieldKey) {
  if (profile.kind !== 'unique') {
    return { text: renderPersonProfile(profile), usedFields: [] };
  }

  const { name } = profile.identity;

  if (fieldKey === 'role') {
    const roles = profile.identity.roles || [];
    const text = roles.length
      ? `**${name}**'s business role${roles.length === 1 ? '' : 's'}: ${roles.join(', ')}.`
      : `I don't have a business role on file for **${name}**.`;
    return { text, usedFields: ['roles'] };
  }

  for (const p of Object.values(profile.profiles || {})) {
    if (fieldKey && !p.visibleFields?.includes(fieldKey)) continue;
    const keys = fieldKey ? [fieldKey] : p.visibleFields || [];
    for (const k of keys) {
      const val = formatFieldValue(p.fields?.[k]);
      if (val) {
        return { text: fieldSentence(k, val, name), usedFields: [k] };
      }
    }
  }

  return {
    text: `I don't have that detail for **${name}** in what I'm allowed to share.`,
    usedFields: [],
  };
}

/**
 * @param {Awaited<ReturnType<import('../personProfile/index.js').resolvePersonProfile>>} profile
 */
export function renderPersonProfile(profile) {
  if (profile.kind === 'notFound') return "I couldn't find anyone by that name.";
  if (profile.kind === 'notAuthorized') return "You don't have access to look up other people's profiles.";
  if (profile.kind === 'unavailable') {
    return "I couldn't reach the directory just now — try again in a moment.";
  }
  if (profile.kind === 'ambiguous') {
    return renderPersonDisambiguation({ query: profile.query, matches: profile.matches });
  }

  const primary = Object.values(profile.profiles)[0];
  const { name, roles } = profile.identity;
  const roleList = roles?.length ? roles : [];

  const intro = roleIntro(name, roleList);

  const parts = [intro];
  const keys = profile.depth === 'full' ? primary?.visibleFields : primary?.summaryFields;
  for (const k of keys || []) {
    const val = formatFieldValue(primary?.fields?.[k]);
    if (val) parts.push(fieldSentence(k, val, name));
  }

  if (profile.depth === 'brief' && profile.availableSections?.length) {
    parts.push(`I can also tell you about ${profile.availableSections.join(', ')}.`);
  }

  return parts.join(' ');
}
