const asTrimmedString = (value) => (typeof value === 'string' ? value.trim() : '');

const normalizeSkillNames = (skills) => {
  if (!Array.isArray(skills)) return [];
  const names = [];
  const seen = new Set();
  for (const skill of skills) {
    const name =
      typeof skill === 'string'
        ? skill.trim()
        : skill && typeof skill === 'object'
          ? asTrimmedString(skill.name)
          : '';
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
};

const educationVenue = (edu = {}) =>
  asTrimmedString(edu.institution) ||
  asTrimmedString(edu.institute) ||
  asTrimmedString(edu.university) ||
  asTrimmedString(edu.school);

const formatEducationLabel = (education = []) =>
  education
    .map((edu) => {
      const parts = [];
      const degree = asTrimmedString(edu?.degree);
      const venue = educationVenue(edu);
      if (degree) parts.push(degree);
      if (venue) parts.push(venue);
      if (edu?.endDate) {
        const year = new Date(edu.endDate).getFullYear();
        if (!Number.isNaN(year)) parts.push(`(${year})`);
      }
      return parts.join(' - ');
    })
    .filter(Boolean)
    .join(', ');

const hasUsableEducation = (education) =>
  Array.isArray(education) &&
  education.some((edu) => asTrimmedString(edu?.degree) || educationVenue(edu));

const qualificationsToEducation = (qualifications = []) =>
  qualifications
    .map((q) => {
      const degree = asTrimmedString(q?.degree);
      const institution = asTrimmedString(q?.institute) || asTrimmedString(q?.institution);
      if (!degree && !institution) return null;
      const row = { degree, institution };
      if (q?.endYear) row.endDate = `${q.endYear}-06-01`;
      if (q?.description) row.description = q.description;
      return row;
    })
    .filter(Boolean);

/**
 * Fill empty Training Student profile fields from the linked User / Candidate
 * (Employee) record. Student values always win when present.
 *
 * @param {object} student plain student JSON (populated `user` allowed)
 * @param {object|null} person Employee/Candidate lean doc
 * @returns {object}
 */
export const applyPersonProfileFallback = (student, person = null) => {
  const next = { ...student };
  const userPhone = asTrimmedString(student?.user?.phoneNumber);
  const studentPhone = asTrimmedString(student?.phone);
  const personPhone = asTrimmedString(person?.phoneNumber);

  next.phone = studentPhone || userPhone || personPhone || student?.phone || '';
  next.skills = normalizeSkillNames(student?.skills);
  if (!next.skills.length) {
    next.skills = normalizeSkillNames(person?.skills);
  }

  const studentBio = asTrimmedString(student?.bio);
  next.bio = studentBio || asTrimmedString(person?.shortBio) || student?.bio || '';

  if (!hasUsableEducation(student?.education)) {
    const fromQualifications = qualificationsToEducation(person?.qualifications);
    if (fromQualifications.length) {
      next.education = fromQualifications;
    } else if (asTrimmedString(person?.degree)) {
      next.education = [{ degree: asTrimmedString(person.degree) }];
    }
  }

  return next;
};

export const studentToPlain = (student) => {
  if (!student) return student;
  if (typeof student.toJSON === 'function') return student.toJSON();
  return student;
};

const collator = { sensitivity: 'base' };

const sortedUnique = (set) =>
  Array.from(set).sort((a, b) => a.localeCompare(b, undefined, collator));

/**
 * Distinct sidebar/header filter values from already-overlaid student rows.
 * @param {object[]} students
 */
export const collectStudentFilterFacets = (students = []) => {
  const names = new Set();
  const emails = new Set();
  const skills = new Set();
  const education = new Set();

  for (const student of students) {
    const name = asTrimmedString(student?.user?.name);
    if (name) names.add(name);
    const email = asTrimmedString(student?.user?.email);
    if (email) emails.add(email);
    for (const skill of normalizeSkillNames(student?.skills)) {
      skills.add(skill);
    }
    const label = formatEducationLabel(student?.education);
    if (label) education.add(label);
  }

  return {
    names: sortedUnique(names),
    emails: sortedUnique(emails),
    skills: sortedUnique(skills),
    education: sortedUnique(education),
  };
};
